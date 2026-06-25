// The terminal's host-side BRIDGE: it owns the pty.* bus channel its own UI
// calls and routes every request to this extension's worker component (which
// runs node-pty on the daemon), served back to the UI over the same channel.
//
//   request  pty.spawn  { machine, cwd?, cols, rows } → { ptyId } | { error }
//   request  pty.input  { ptyId, data }               → { ok }
//   request  pty.resize { ptyId, cols, rows }         → { ok }
//   request  pty.kill   { ptyId }                     → { ok }
//   publish  pty.data   { ptyId, data }
//   publish  pty.exit   { ptyId, exitCode, signal, error? }
//
// Every machine — including the host's own worker-zero daemon ("Server"), which
// is now a real connected machine like any other — rides the worker channel to
// worker/index.ts. The host process no longer spawns any pty itself: there is
// no in-process / pseudo-machine path. The channel protocol is ours
// (spawn/input/resize/kill out, data/exit back, correlated by ptyId).
//
// Spawns are injection-safe by construction: the shell is spawned with an
// EMPTY argv (no command string, no interpolation) and user keystrokes only
// ever travel over the pty stream as input bytes.

import type { ServerProvider, WorkerChannel } from '../../types';

const PTY_DATA_FLUSH_BYTES = 64 * 1024; // bound a single publish payload

// How long the optional default-cwd lookup may take before we give up and open
// the shell in the worker's home. Generous enough for a healthy fleet's slot
// verify, short enough that a wedged worker never makes a shell feel hung.
const DEFAULT_CWD_BUDGET_MS = 1500;

function clampCols(v: any): number { return Math.max(2, Math.min(500, parseInt(v, 10) || 80)); }
function clampRows(v: any): number { return Math.max(2, Math.min(200, parseInt(v, 10) || 24)); }

// Resolve a promise, or reject once `ms` elapse — used to keep an optional,
// best-effort lookup off the spawn critical path. The timer is cleared on settle
// so it never holds the event loop open.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function genPtyId(): string {
  return `pty_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function register(serverProvider: ServerProvider): void {
  const server = serverProvider.version(1);
  const { bus, workers, services } = server;

  // ptyId → remote routing record; the worker component shares the ptyId.
  const remotePtys = new Map<string, { machine: string }>();
  // One channel (with one wired onMessage) per machine, created on first use.
  const channels = new Map<string, WorkerChannel>();

  function publishData(ptyId: string, data: string): void {
    let s = data;
    while (s.length > PTY_DATA_FLUSH_BYTES) {
      bus.extension.publish('pty.data', { ptyId, data: s.slice(0, PTY_DATA_FLUSH_BYTES) });
      s = s.slice(PTY_DATA_FLUSH_BYTES);
    }
    if (s.length) bus.extension.publish('pty.data', { ptyId, data: s });
  }

  function publishExit(ptyId: string, exitCode: number, signal?: number, error?: string): void {
    bus.extension.publish('pty.exit', { ptyId, exitCode, signal: signal || 0, error });
  }

  function channelFor(machine: string): WorkerChannel {
    let ch = channels.get(machine);
    if (!ch) {
      ch = workers.channel(machine);
      ch.onMessage((msg: any) => {
        const ptyId = typeof msg?.ptyId === 'string' ? msg.ptyId : '';
        if (!ptyId || !remotePtys.has(ptyId)) return;
        if (msg.type === 'data') {
          publishData(ptyId, typeof msg.data === 'string' ? msg.data : '');
        } else if (msg.type === 'exit') {
          remotePtys.delete(ptyId);
          publishExit(
            ptyId,
            typeof msg.exitCode === 'number' ? msg.exitCode : -1,
            typeof msg.signal === 'number' ? msg.signal : undefined,
            typeof msg.error === 'string' ? msg.error : undefined,
          );
        }
      });
      channels.set(machine, ch);
    }
    return ch;
  }

  // Default cwd when the caller gives none: the machine opens in its first live
  // slot's directory, else '' so the worker component falls back to the
  // worker's home. Worker-zero (the host's "Server" machine) is just another
  // machine here — it resolves the same way.
  //
  // CRITICAL: this is on the spawn critical path, so it must never BLOCK opening
  // a shell. workspaces.reservations() verifies every live slot, and that verify
  // can round-trip to a *different* machine's worker (an isolated slot probes its
  // own daemon); if that machine is slow or wedged, the lookup can stall for a
  // long time — and a shell on the host's own "Server" would then be held hostage
  // by an unrelated worker. So we race the lookup against a short budget and, on
  // timeout (or any fault), fall back to the worker's home directory. A
  // convenience default cwd is never worth a hung terminal.
  async function resolveDefaultCwd(machine: string): Promise<string> {
    try {
      const reservations = await withTimeout(services.workspaces.reservations(), DEFAULT_CWD_BUDGET_MS);
      for (const r of reservations) {
        if (r.machine === machine && r.descriptor.slotDir) return r.descriptor.slotDir;
      }
    } catch { /* timed out or faulted — fall through to the worker's home */ }
    return '';
  }

  // ── Remote (worker-component) pty ─────────────────────────────────────
  function spawnRemote(ptyId: string, machine: string, cwd: string, cols: number, rows: number): { error?: string } {
    const ch = channelFor(machine);
    remotePtys.set(ptyId, { machine });
    try {
      ch.send({ type: 'spawn', ptyId, cwd, cols, rows });
    } catch (err: any) {
      remotePtys.delete(ptyId);
      return { error: err?.message || String(err) };
    }
    return {};
  }

  function sendRemote(ptyId: string, machine: string, msg: any): void {
    try { channelFor(machine).send(msg); }
    catch (err: any) { console.error(`[terminal] ${msg?.type} ${ptyId}: ${err?.message || err}`); }
  }

  // ── Bus responders (this extension's UI) ──────────────────────────────
  bus.extension.respond('pty.spawn', async (params: { machine?: string; cwd?: string; cols?: number; rows?: number }) => {
    const machine = typeof params?.machine === 'string' ? params.machine : '';
    if (!machine) return { error: 'pty.spawn: machine required' };
    const cols = clampCols(params?.cols);
    const rows = clampRows(params?.rows);
    let cwd = typeof params?.cwd === 'string' ? params.cwd : '';
    if (!cwd) cwd = await resolveDefaultCwd(machine);
    const ptyId = genPtyId();
    const res = spawnRemote(ptyId, machine, cwd, cols, rows);
    if (res.error) return { error: res.error };
    return { ptyId };
  });

  bus.extension.respond('pty.input', (params: { ptyId?: string; data?: string }) => {
    const ptyId = typeof params?.ptyId === 'string' ? params.ptyId : '';
    const data = typeof params?.data === 'string' ? params.data : '';
    if (!ptyId) return { ok: false, error: 'pty.input: ptyId required' };
    const remote = remotePtys.get(ptyId);
    if (remote) {
      sendRemote(ptyId, remote.machine, { type: 'input', ptyId, data });
      return { ok: true };
    }
    return { ok: false, error: 'unknown ptyId' };
  });

  bus.extension.respond('pty.resize', (params: { ptyId?: string; cols?: number; rows?: number }) => {
    const ptyId = typeof params?.ptyId === 'string' ? params.ptyId : '';
    if (!ptyId) return { ok: false, error: 'pty.resize: ptyId required' };
    const cols = clampCols(params?.cols);
    const rows = clampRows(params?.rows);
    const remote = remotePtys.get(ptyId);
    if (remote) {
      sendRemote(ptyId, remote.machine, { type: 'resize', ptyId, cols, rows });
      return { ok: true };
    }
    return { ok: false, error: 'unknown ptyId' };
  });

  bus.extension.respond('pty.kill', (params: { ptyId?: string }) => {
    const ptyId = typeof params?.ptyId === 'string' ? params.ptyId : '';
    if (!ptyId) return { ok: false, error: 'pty.kill: ptyId required' };
    const remote = remotePtys.get(ptyId);
    if (remote) {
      sendRemote(ptyId, remote.machine, { type: 'kill', ptyId });
      // Keep the record: the component's exit event cleans it up (and
      // publishes pty.exit). If the machine drops before answering, the
      // disconnect sweep below synthesizes the exit.
      return { ok: true };
    }
    return { ok: false, error: 'unknown ptyId' };
  });

  // A machine dropping takes its ptys with it — surface the ended state so
  // the UI's shells render "connection lost" instead of hanging.
  const unwatch = services.machines.watch((event) => {
    if (event.type !== 'disconnected' || !event.machine) return;
    for (const [ptyId, rec] of Array.from(remotePtys.entries())) {
      if (rec.machine !== event.machine) continue;
      remotePtys.delete(ptyId);
      publishExit(ptyId, -1, undefined, 'machine disconnected');
    }
  });

  server.deregister(() => {
    unwatch();
    for (const [ptyId, rec] of Array.from(remotePtys.entries())) {
      sendRemote(ptyId, rec.machine, { type: 'kill', ptyId });
      remotePtys.delete(ptyId);
    }
  });
}
