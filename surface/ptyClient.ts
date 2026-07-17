// The UI's handle on this extension's pty lifecycle — the DIRECT client of the
// worker daemon over the one bus. There is no host relay: a spawn is a targeted
// request (a slot shell addresses its reservation, a home shell the machine),
// input/resize/kill are targeted publishes against the same target, and the
// worker's pty.data/pty.exit frames are plain publishes this client subscribes
// to, correlated by ptyId. The client also owns the two conveniences the old
// relay carried: the default-cwd lookup for a machine-home shell, and the
// disconnect sweep that synthesizes an exit when a machine drops so a shell
// renders "connection lost" instead of hanging.

import type { Bus, BusTarget, Subscription, Workers, Workspaces } from '../../types';

// How long the optional default-cwd lookup may take before we give up and open
// the shell in the worker's home. workspaces.reservations({}) can round-trip to
// other machines' workers; a wedged one must never make a shell feel hung.
const DEFAULT_CWD_BUDGET_MS = 1500;

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

export interface PtyExit {
  exitCode: number;
  signal?: number;
  error?: string;
}

export interface PtyClient {
  spawn(machine: string, opts: { reservationId?: string | null; cwd?: string; cols: number; rows: number }): Promise<{ ptyId?: string; error?: string }>;
  input(ptyId: string, data: string): Promise<void>;
  resize(ptyId: string, cols: number, rows: number): Promise<void>;
  kill(ptyId: string): Promise<void>;
  onData(ptyId: string, handler: (data: string) => void): () => void;
  onExit(ptyId: string, handler: (e: PtyExit) => void): () => void;
  // Tear the client down: the disconnect watch and any live routing records.
  dispose(): void;
}

export function createPtyClient(bus: Bus, workspaces: Workspaces, workers: Workers): PtyClient {
  // ptyId → routing record: the target the pty's traffic addresses (its
  // reservation when it is a slot shell, else its machine) plus the machine
  // for the disconnect sweep. The worker daemon shares the ptyId.
  const routes = new Map<string, { target: BusTarget; machine: string }>();

  // Synthesized exits ride the same handler sets real ones do, so a shell's
  // onExit fires identically for "process ended" and "machine gone".
  const exitHandlers = new Map<string, Set<(e: PtyExit) => void>>();

  function emitExit(ptyId: string, e: PtyExit): void {
    routes.delete(ptyId);
    for (const handler of Array.from(exitHandlers.get(ptyId) ?? [])) handler(e);
  }

  // A machine dropping takes its ptys with it — surface the ended state so the
  // UI's shells render "connection lost" instead of hanging.
  const workersSub: Subscription = workers.watch((event) => {
    if (event.type !== 'disconnected' || !event.machine) return;
    for (const [ptyId, rec] of Array.from(routes.entries())) {
      if (rec.machine === event.machine) emitExit(ptyId, { exitCode: -1, error: 'machine disconnected' });
    }
  });

  // Default cwd when the caller gives none: the machine opens in its first
  // live slot's directory, else '' so the worker daemon falls back to the
  // worker's home. Raced against a short budget — a convenience default is
  // never worth a hung terminal.
  async function resolveDefaultCwd(machine: string): Promise<string> {
    try {
      const reservations = await withTimeout(workspaces.reservations({}), DEFAULT_CWD_BUDGET_MS);
      for (const r of reservations) {
        if (r.machine === machine && r.slot.slotDirectory) return r.slot.slotDirectory;
      }
    } catch { /* timed out or faulted — fall through to the worker's home */ }
    return '';
  }

  return {
    // Spawn rides a targeted request so an unroutable target (released
    // reservation, disconnected machine) surfaces as a spawn error instead of
    // a shell that never answers; the worker's responder acknowledges the
    // spawn it started, and every later failure arrives as a pty.exit frame.
    async spawn(machine, opts) {
      if (!machine) return { error: 'spawn: machine required' };
      const reservationId = typeof opts.reservationId === 'string' && opts.reservationId ? opts.reservationId : null;
      const target: BusTarget = reservationId ? { reservationId } : { machine };
      let cwd = typeof opts.cwd === 'string' ? opts.cwd : '';
      if (!cwd && !reservationId) cwd = await resolveDefaultCwd(machine);
      const ptyId = genPtyId();
      routes.set(ptyId, { target, machine });
      try {
        await bus.extension.request('pty.spawn', { ptyId, cwd, cols: opts.cols, rows: opts.rows }, { target });
      } catch (err: any) {
        routes.delete(ptyId);
        return { error: err?.message || String(err) };
      }
      return { ptyId };
    },
    async input(ptyId, data) {
      const rec = routes.get(ptyId);
      if (rec) bus.extension.publish('pty.input', { ptyId, data }, { target: rec.target });
    },
    async resize(ptyId, cols, rows) {
      const rec = routes.get(ptyId);
      if (rec) bus.extension.publish('pty.resize', { ptyId, cols, rows }, { target: rec.target });
    },
    async kill(ptyId) {
      const rec = routes.get(ptyId);
      // Keep the route: the worker's exit frame retires it (and reaches
      // onExit). If the machine drops before answering, the disconnect sweep
      // synthesizes the exit.
      if (rec) bus.extension.publish('pty.kill', { ptyId }, { target: rec.target });
    },
    onData(ptyId, handler) {
      const sub = bus.extension.subscribe('pty.data', (p: any) => { if (p?.ptyId === ptyId) handler(p.data); });
      return () => sub.unsubscribe();
    },
    onExit(ptyId, handler) {
      let set = exitHandlers.get(ptyId);
      if (!set) { set = new Set(); exitHandlers.set(ptyId, set); }
      set.add(handler);
      const sub = bus.extension.subscribe('pty.exit', (p: any) => {
        if (p?.ptyId !== ptyId) return;
        emitExit(ptyId, {
          exitCode: typeof p.exitCode === 'number' ? p.exitCode : -1,
          signal: typeof p.signal === 'number' ? p.signal : undefined,
          error: typeof p.error === 'string' ? p.error : undefined,
        });
      });
      return () => { set!.delete(handler); sub.unsubscribe(); };
    },
    dispose() {
      workersSub.unsubscribe();
      routes.clear();
      exitHandlers.clear();
    },
  };
}
