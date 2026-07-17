// The terminal's daemon-side half: node-pty on the worker machine, driven by
// this extension's server code over the worker channel. The channel protocol
// is ours (correlated by ptyId):
//
//   request in:  { type: 'spawn', ptyId, cwd, cols, rows } → { ok } (the ack;
//                failures still arrive as exit events, matching every other
//                way a shell dies)
//   send in:     { type: 'input', ptyId, data }
//                { type: 'resize', ptyId, cols, rows }
//                { type: 'kill', ptyId }
//   send out:    { type: 'data', ptyId, data }
//                { type: 'exit', ptyId, exitCode, signal, error? }
//
// node-pty is a NATIVE module, resolved via context.modules.import('node-pty')
// (daemon-located resolution) — it is
// installed on the worker (the in-cluster k8s pod has it baked into
// /server/node_modules via `npm install`). When it can't be resolved the spawn
// surfaces a clean "terminal unavailable on this worker" instead of breaking
// the daemon.
//
// Spawns stay injection-safe: the shell is spawned with an EMPTY argv and
// user keystrokes only ever arrive as pty input bytes.

import * as os from 'os';
import type { WorkerProvider, WorkerDaemonContext } from '../../types';

const PTY_MAX = 32;
const PTY_DATA_FLUSH_BYTES = 64 * 1024; // bound a single channel payload

interface Pty {
  pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

interface NodePtyModule {
  spawn(file: string, args: string[], opts: any): Pty;
}

function clampCols(v: any): number { return Math.max(2, Math.min(500, parseInt(v, 10) || 80)); }
function clampRows(v: any): number { return Math.max(2, Math.min(200, parseInt(v, 10) || 24)); }

export function register(provider: WorkerProvider): void {
  const w = provider.version(1);
  // The worker bundle is a single daemon: all logic and capability live inside
  // its mount(), which receives the flat WorkerDaemonContext.
  w.daemon.register({ mount });
}

// The terminal worker daemon: runs node-pty next to the machine's files, driven
// over the worker channel, and registers the run_command action whose closure
// executes on this machine. Nothing to tear down beyond the daemon itself, so
// mount returns an empty handle.
function mount(context: WorkerDaemonContext): { dispose?: () => void } {
  const { channel } = context;

  const ptys = new Map<string, { pty: Pty }>();

  let nodePty: NodePtyModule | null = null;
  let nodePtyFetchPromise: Promise<NodePtyModule> | null = null;

  function ensureNodePty(): Promise<NodePtyModule> {
    if (nodePty) return Promise.resolve(nodePty);
    if (nodePtyFetchPromise) return nodePtyFetchPromise;

    nodePtyFetchPromise = (async () => {
      const mod: any = await context.modules.import('node-pty');
      nodePty = (mod && mod.default ? mod.default : mod) as NodePtyModule;
      console.log('[terminal-worker] node-pty: loaded from worker node_modules');
      return nodePty;
    })();

    // Clear the latched promise on failure so the next spawn retries (a
    // transient resolution failure must not disable terminals for the daemon's
    // lifetime).
    nodePtyFetchPromise.catch(() => { nodePtyFetchPromise = null; });

    return nodePtyFetchPromise;
  }

  function sendData(ptyId: string, data: string): void {
    let s = data;
    while (s.length > PTY_DATA_FLUSH_BYTES) {
      channel.send({ type: 'data', ptyId, data: s.slice(0, PTY_DATA_FLUSH_BYTES) });
      s = s.slice(PTY_DATA_FLUSH_BYTES);
    }
    if (s.length) channel.send({ type: 'data', ptyId, data: s });
  }

  function sendExit(ptyId: string, exitCode: number, signal?: number, error?: string): void {
    channel.send({ type: 'exit', ptyId, exitCode, signal: signal || 0, error });
  }

  async function spawn(ptyId: string, cwd: string, cols: number, rows: number): Promise<void> {
    if (ptys.size >= PTY_MAX) {
      sendExit(ptyId, -1, undefined, `terminal limit reached (${PTY_MAX})`);
      return;
    }
    let np: NodePtyModule;
    try {
      np = await ensureNodePty();
    } catch (err: any) {
      sendExit(ptyId, -1, undefined, `terminal unavailable on this worker: ${err?.message || err}`);
      return;
    }
    const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');
    let pty: Pty;
    try {
      pty = np.spawn(shell, [], {
        name: 'xterm-256color',
        cols, rows,
        cwd: cwd || os.homedir(),
        env: { ...process.env, TERM: 'xterm-256color' },
      });
    } catch (err: any) {
      sendExit(ptyId, -1, undefined, `pty spawn failed: ${err?.message || err}`);
      return;
    }
    ptys.set(ptyId, { pty });
    console.log(`[terminal-worker] spawn ${ptyId} pid=${pty.pid} shell=${shell} cwd=${cwd}`);
    pty.onData((data) => sendData(ptyId, data));
    pty.onExit(({ exitCode, signal }) => {
      console.log(`[terminal-worker] exit ${ptyId} code=${exitCode} signal=${signal || 0}`);
      ptys.delete(ptyId);
      sendExit(ptyId, exitCode, signal);
    });
  }

  // ── Worker-realm action: run a command on THIS machine ────────────────
  // A worker-realm action: its run() executes ON THE DAEMON, so it fires with
  // NOTHING ATTENDING — schedule it bound to a reservation and the host
  // dispatches it to this worker on cron, no browser open. It runs a command next
  // to the machine's files and returns the output, the canonical "headless
  // backend work" an action should do off the host. Injection-safe: execFile
  // takes a command + an args ARRAY (no shell string), exactly like the pty's
  // empty-argv spawn. The closure lives here, in the worker bundle — never in the
  // UI controller — and an action's realm is simply the bundle that holds its
  // closure, so registering it here is what makes it a worker-realm action.
  context.actions.register({
    id: 'terminal.run_command',
    title: 'Run a command on the machine',
    description:
      'Run a shell command (an executable + arguments) on the worker machine and return its stdout, stderr, and ' +
      'exit code. Runs ON THE MACHINE next to its files — no app needs to be open — so it can be scheduled to fire ' +
      'unattended (bind the schedule to a reservation to run it in that slot). Provide `command` (the executable, ' +
      'e.g. "git") and optional space-separated `args` (e.g. "status --porcelain") and a working directory `cwd`.',
    category: 'Terminal',
    defaultKey: null,
    group: null,
    output: null,
    input: {
      fields: [
        { key: 'command', type: 'string', label: 'Command', description: null, required: true, default: null, placeholder: 'e.g. git' },
        { key: 'args', type: 'string', label: 'Arguments', description: 'Space-separated arguments. Optional.', required: null, default: null, placeholder: null },
        { key: 'cwd', type: 'string', label: 'Working directory', description: 'Absolute path; defaults to the worker home. Optional.', required: null, default: null, placeholder: null },
      ],
    },
    async run(_ctx, input) {
      const args = (input ?? {}) as { command?: string; args?: string; cwd?: string };
      const command = String(args.command ?? '').trim();
      if (!command) throw new Error('command is required (the executable to run)');
      const argv = String(args.args ?? '').trim() ? String(args.args).trim().split(/\s+/) : [];
      const cwd = String(args.cwd ?? '').trim() || os.homedir();
      // execFile (NOT exec): no shell, command + args array — injection-safe.
      const { execFile } = context.modules.require('child_process') as typeof import('child_process');
      return await new Promise((resolve) => {
        execFile(command, argv, { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (err: any, stdout: string, stderr: string) => {
          resolve({
            command,
            args: argv,
            cwd,
            exitCode: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            error: err && err.code === undefined ? String(err.message || err) : undefined,
          });
        });
      });
    },
  });

  // Spawns arrive as requests so the caller learns the daemon heard it (an
  // unroutable target rejects on the calling side before this runs); every
  // later failure still arrives as an exit event.
  channel.onRequest((msg: any) => {
    const ptyId = typeof msg?.ptyId === 'string' ? msg.ptyId : '';
    if (!ptyId || msg.type !== 'spawn') return { ok: false, error: 'unknown request' };
    void spawn(
      ptyId,
      typeof msg.cwd === 'string' ? msg.cwd : '',
      clampCols(msg.cols),
      clampRows(msg.rows),
    );
    return { ok: true };
  });

  channel.onMessage((msg: any) => {
    const ptyId = typeof msg?.ptyId === 'string' ? msg.ptyId : '';
    if (!ptyId) return;
    const entry = ptys.get(ptyId);
    if (!entry) {
      // The server side already retired this ptyId (kill races exit) — a
      // synthetic exit would be dropped there anyway.
      return;
    }
    if (msg.type === 'input') {
      try { entry.pty.write(typeof msg.data === 'string' ? msg.data : ''); }
      catch (err: any) { console.error(`[terminal-worker] write ${ptyId}: ${err?.message}`); }
    } else if (msg.type === 'resize') {
      try { entry.pty.resize(clampCols(msg.cols), clampRows(msg.rows)); }
      catch (err: any) { console.error(`[terminal-worker] resize ${ptyId}: ${err?.message}`); }
    } else if (msg.type === 'kill') {
      try { entry.pty.kill(); } catch (err: any) { console.error(`[terminal-worker] kill ${ptyId}: ${err?.message}`); }
      // onExit cleans up the map.
    }
  });

  return {};
}
