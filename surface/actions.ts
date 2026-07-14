// The terminal app's CONTROLLER-realm actions — the operations a user or agent
// can DO, declared once (UiV1.actions.register) so each gets the three invokers
// the host derives for free: a generated human modal, an agent tool
// (frontier.run_action), and a scheduler entry.
//
// REALM NOTE (the crux of how these reach the live app). register() runs in BOTH
// the controller realm (declarations → host; an agent/palette/scheduler runs the
// closures HERE) and the app's surface realm (declarations suppressed; the in-app
// <ActionButton> runs the closures THERE). The two realms are SEPARATE MEMORY —
// the controller can't touch the surface's React state (same constraint spaces'
// create_space documents). So an action does NOT mutate the session store
// directly; its run() resolves the request against the host SERVICES (available
// in both realms) and writes a COMMAND MARKER to ui.prefs. The mounted
// <TerminalPanel> watches that key (prefs.watch) and applies it — open/close a
// shell — in its own realm. One code path then works identically whether the
// trigger was the in-app button, the host-generated modal, an agent, or the
// scheduler. (prefs is the device-local cross-document channel the host gives
// every extension; markers carry a monotonic nonce so two identical opens in a
// row both fire.)
//
// These replace the app's only bespoke "pick a target" interaction: opening a
// shell used to be a raw click on a tree row with no agent/scheduler surface and
// no described operation. `terminal.open_shell` is now the canonical op, its
// target chosen from a LIVE option source (terminal.target) so the modal shows a
// real picker of connected machines + directory-backed reservations while an
// agent passes the same target id as a string.
//
// The daemon-side `terminal.run_command` (worker realm) lives in worker/index.ts,
// not here — its run() must execute next to the machine's files.

import type { WorkerRegistry, Reservation, UiV1, Workspaces } from '../../types';

// prefs keys the action writes and the panel drains. OPEN carries the resolved
// target; CLOSE carries an optional session id; both carry a nonce so a repeat
// of the same request still triggers a prefs.watch tick (a cross-realm write only
// reaches another document as a `storage` event when the value actually changes).
// `consumed` is flipped by the panel once it applies a marker: an UNconsumed one
// is a request nobody has handled yet, so the panel applies it both live (warm
// app) and once on mount — a marker set while the app was COLD (an agent, the
// scheduler, or the Machines view's "Terminal" button opening straight onto a
// machine) is fulfilled on the next mount instead of being silently dropped.
export const OPEN_CMD_KEY = 'cmd.open';
export const CLOSE_CMD_KEY = 'cmd.close';

export interface OpenCommand {
  nonce: number;
  machine: string;
  cwd?: string;
  label: string;
  // Set true by the panel once this marker has been applied (see above). The
  // action always writes it absent, i.e. unconsumed.
  consumed?: boolean;
}
export interface CloseCommand {
  nonce: number;
  sessionId?: string;
  consumed?: boolean;
}

// Option-source id the open-shell picker resolves against, and the value-id
// scheme it emits: "<kind>:<id>" so run() can route it back to a target against
// the live fleet (a machine id, or a reservation id we look the directory up for).
export const TARGET_SOURCE_ID = 'terminal.target';
const SERVER_MACHINE_NAME = 'Server';

// A strictly-increasing marker nonce. Date.now() alone can collide for two calls
// in the same millisecond (rapid programmatic triggers); seeding from Date.now()
// keeps it monotonic across an app reload too (a later session's markers always
// outrank an earlier one's, so the drain's "newer than last applied" holds). The
// counter lives per realm — fine, since the panel compares each key's own stream.
let nonceSeq = Date.now();
function nextNonce(): number { return ++nonceSeq; }

function machineValue(id: string): string { return `machine:${id}`; }
function reservationValue(id: string): string { return `reservation:${id}`; }

// How long the optional reservation lookup may take before the picker / resolver
// gives up on it. workspaces.reservations() verifies every live slot, and that
// verify can round-trip to a slow/wedged worker (an isolated slot probes its own
// daemon); the target picker must never hang waiting on it — connected machines
// are always offerable on their own. Mirrors the server's DEFAULT_CWD_BUDGET_MS.
const RESERVATIONS_BUDGET_MS = 2000;

// Resolve a promise, or reject once `ms` elapse. Keeps the best-effort
// reservation lookup off the modal-open / resolve critical path.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

interface ResolvedTarget { machine: string; cwd?: string; label: string; }

// Build the live target options from the host services (works in EITHER realm —
// the controller's option-source list() and the surface button both call this):
// every CONNECTED machine, then every directory-backed reservation whose machine
// is connected. Disconnected targets are omitted — the picker only offers what
// will actually open.
async function listTargetOptions(
  machines: WorkerRegistry,
  workspaces: Workspaces,
): Promise<{ value: string; label: string; description?: string }[]> {
  const out: { value: string; label: string; description?: string }[] = [];
  const machineById = new Map(machines.list().map((m) => [m.id, m]));
  for (const m of machines.list()) {
    if (!m.connected) continue;
    out.push({ value: machineValue(m.id), label: m.name, description: 'Machine — opens in the worker’s home directory.' });
  }
  // Reservations are a BONUS on top of the machines above — never let a slow
  // slot verify hold the picker hostage. On timeout (or fault) we just offer the
  // connected machines, which is the common target anyway.
  let reservations: Reservation[] = [];
  try { reservations = await withTimeout(workspaces.reservations(), RESERVATIONS_BUDGET_MS); } catch { /* offer machines only */ }
  for (const r of reservations) {
    const cwd = r.descriptor.slotDir || r.descriptor.canonicalDir;
    if (!cwd) continue;
    const m = machineById.get(r.machine);
    if (!m?.connected) continue;
    const where = m.name ? `${cwd} on ${m.name}` : cwd;
    out.push({ value: reservationValue(r.id), label: `${r.description} (${r.owner || 'other'})`, description: where });
  }
  return out;
}

// The default target: the host's co-located "Server", else the first connected
// machine. Null when nothing is connected.
function defaultTarget(machines: WorkerRegistry): ResolvedTarget | null {
  const connected = machines.list().filter((m) => m.connected);
  if (connected.length === 0) return null;
  const server = connected.find((m) => m.name === SERVER_MACHINE_NAME) ?? connected[0];
  return { machine: server.id, label: server.name };
}

// Resolve a target value id (from the picker or an agent) against the live fleet.
// Null when it doesn't resolve (a stale id, or its machine went away / dropped).
async function resolveTarget(
  value: string,
  machines: WorkerRegistry,
  workspaces: Workspaces,
): Promise<ResolvedTarget | null> {
  if (value.startsWith('machine:')) {
    const id = value.slice('machine:'.length);
    const m = machines.get(id);
    return m && m.connected ? { machine: m.id, label: m.name } : null;
  }
  if (value.startsWith('reservation:')) {
    const id = value.slice('reservation:'.length);
    let reservations: Reservation[] = [];
    try { reservations = await withTimeout(workspaces.reservations(), RESERVATIONS_BUDGET_MS); } catch { return null; }
    const r = reservations.find((x) => x.id === id);
    if (!r) return null;
    const cwd = r.descriptor.slotDir || r.descriptor.canonicalDir;
    const m = machines.get(r.machine);
    return cwd && m?.connected ? { machine: r.machine, cwd, label: r.description } : null;
  }
  return null;
}

export function registerActions(ui: UiV1): void {
  const { workers: machines, workspaces } = ui.services;

  // The live target picker (machines + directory-backed reservations), resolved
  // when the open-shell modal opens. Published as an option source so the host
  // renders a real dropdown and an agent still passes a plain string id.
  ui.optionSources.register({
    id: TARGET_SOURCE_ID,
    title: 'Terminal target',
    list: () => listTargetOptions(machines, workspaces),
  });

  // Open a new shell on a target. The canonical "drop into a shell" op — the tab
  // strip's "+", the empty-stage button, an agent, and the scheduler all run THIS;
  // the tree rows are a one-click shortcut for it pre-aimed at a row's target.
  ui.actions.register({
    id: 'terminal.open_shell',
    title: 'Open a shell',
    description:
      'Open a new terminal (a live shell) on a target and focus it. The target is a connected machine — ' +
      'including the host’s own “Server” machine — or a directory-backed reservation (the shell opens in that ' +
      'slot’s directory). Pick one from the live list; omit it to use the default target (the “Server” machine, ' +
      'else the first connected machine). Several shells can be open on the same target at once. Returns the new ' +
      'target’s label. This only opens an interactive shell; to run a single command unattended use ' +
      'terminal.run_command.',
    input: {
      fields: [
        {
          key: 'target',
          type: 'option-source',
          source: TARGET_SOURCE_ID,
          label: 'Target',
          description: 'A connected machine or a directory-backed reservation. Omit to use the default target.',
        },
      ],
    },
    async run(_ctx, input) {
      const args = (input ?? {}) as { target?: string };
      const value = String(args.target ?? '').trim();

      let target: ResolvedTarget | null;
      if (!value) {
        target = defaultTarget(machines);
        if (!target) {
          return { ok: false, code: 'no_target', field: 'target', error: 'No machine is connected yet — wait for a machine to come online, then open a shell.' };
        }
      } else {
        target = await resolveTarget(value, machines, workspaces);
        if (!target) {
          return { ok: false, code: 'unknown_target', field: 'target', error: 'That target is no longer available (its machine may have disconnected). Pick another.' };
        }
      }

      const cmd: OpenCommand = { nonce: nextNonce(), machine: target.machine, cwd: target.cwd, label: target.label };
      ui.prefs.set(OPEN_CMD_KEY, cmd);
      return { target: target.label };
    },
  });

  // Close a shell — the focused one by default, or one named by session id. Gives
  // the agent/scheduler a way to tidy up shells. (The tab × and the recovery
  // overlays close locally; this is the described, agent-callable op.)
  ui.actions.register({
    id: 'terminal.close_shell',
    title: 'Close a shell',
    description:
      'Close an open terminal session, killing its shell. Closes the focused session by default, or pass a ' +
      '`sessionId` (as returned in the app) to close a specific one. No-op if nothing is open.',
    input: {
      fields: [
        { key: 'sessionId', type: 'string', label: 'Session id', description: 'The session to close. Omit to close the focused one.' },
      ],
    },
    run(_ctx, input) {
      const args = (input ?? {}) as { sessionId?: string };
      const sessionId = String(args.sessionId ?? '').trim() || undefined;
      const cmd: CloseCommand = { nonce: nextNonce(), sessionId };
      ui.prefs.set(CLOSE_CMD_KEY, cmd);
      return { requested: sessionId ?? 'focused' };
    },
  });
}
