// The terminal app's content.
//
// Layout: a narrow TARGET TREE rail (ExtensionSidebar) on the left and a session
// area on the right — a strip of session tabs (ExtensionTabs) over the xterm stage,
// the two panes joined by a resizable Split. The tree lists every place a
// shell can open:
//
//   Machines      — every connected worker machine, muted while disconnected.
//                   The host itself is one of them: it always runs a co-located
//                   worker ("Server"), so it appears here like any other machine.
//   Reservations  — directory-backed slots grouped by the owning extension;
//                   opening one drops the shell in the slot's directory
//
// Clicking a row is a one-click shortcut for the `terminal.open_shell` ACTION
// pre-aimed at that target: it opens a NEW session tab there (a fresh shell) and
// focuses it — so a user can run several shells on the same target side by side.
// The same action (with its live target picker) backs the tab strip's "+" and the
// empty-stage button, and is what an agent / the scheduler call. All session state
// lives in the module store (../store) so the action run()s and this panel stay in
// lockstep. Each session keeps its own XtermTerminal mounted EXACTLY ONCE
// (visibility-toggled, not unmounted) so its shell survives tab switches; closing
// a tab unmounts it, which kills its pty. The host warm-keeps the whole app, so
// switching to another app / peeking it never tears these down.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExtensionSidebar, ExtensionTabs, Split, EmptyState } from '@frontierengineer/ui';
import { ActionButton } from '@frontierengineer/ui/useAction';
import type { WorkerRegistry, Reservation, SurfaceServices, Workspaces } from '../../../types';
import type { PtyClient } from '../ptyClient';
import { XtermTerminal } from './XtermTerminal';
import {
  closeSession,
  getLastSessionId,
  getSelected,
  openSession,
  selectSession,
  setCatalogue,
  useCatalogue,
  useFocusNonce,
  useSelected,
  useSessions,
  type SpawnTarget,
  type TargetMachine,
  type TargetReservation,
} from '../store';
import {
  CLOSE_CMD_KEY,
  OPEN_CMD_KEY,
  type CloseCommand,
  type OpenCommand,
} from '../actions';

interface ReservationGroup {
  extensionId: string;
  rows: TargetReservation[];
}

const EXPANDED_KEY = 'tree.expanded';
type GroupId = 'machines' | 'reservations';

function listMachineRows(machines: WorkerRegistry): TargetMachine[] {
  return machines.list()
    .map((m) => ({ id: m.id, name: m.name, connected: m.connected }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Flatten the host's reservations into the catalogue's directory-backed rows,
// dropping no-directory slots (nowhere to put a shell) and resolving each row's
// machine connection state for the tree's muting + the picker's filtering.
function listReservationRows(reservations: Reservation[], machineRows: TargetMachine[]): TargetReservation[] {
  const machineById = new Map(machineRows.map((m) => [m.id, m]));
  const out: TargetReservation[] = [];
  for (const r of reservations) {
    const cwd = r.descriptor.slotDir || r.descriptor.canonicalDir;
    if (!cwd) continue;
    const m = machineById.get(r.machine);
    out.push({
      reservationId: r.id,
      name: r.description,
      extensionId: r.owner || 'other',
      machine: r.machine,
      machineName: m?.name ?? null,
      connected: m?.connected ?? false,
      cwd,
    });
  }
  return out;
}

function Caret({ open }: { open: boolean }) {
  return (
    <span className="ext-terminal-tree-caret" aria-hidden="true">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        {open ? <path d="M3 4.5L6 7.5L9 4.5" /> : <path d="M4.5 3L7.5 6L4.5 9" />}
      </svg>
    </span>
  );
}

export function TerminalPanel({ terminal, machines, workspaces, localSettings, bus }: {
  terminal: PtyClient;
  machines: WorkerRegistry;
  workspaces: Workspaces;
  localSettings: SurfaceServices['localSettings'];
  bus: SurfaceServices['bus'];
}) {
  // Session + catalogue state live in the module store so the registered actions
  // (open_shell / close_shell) and this panel share one source of truth.
  const sessions = useSessions();
  const selected = useSelected();
  const catalogue = useCatalogue();
  const focusNonce = useFocusNonce();
  const { machines: machineRows, reservations: reservationRows } = catalogue;

  // Persisted expand/collapse of the two tree groups. Seeded from localSettings on
  // mount; toggling writes through to localSettings. This is device-local UI state,
  // not a signaling channel, so there is no live cross-document sync here — a toggle
  // in another of the extension's open documents lands on that document's next mount.
  const [expanded, setExpanded] = useState<Record<GroupId, boolean>>(() => readExpanded(localSettings));
  const toggleGroup = useCallback((group: GroupId) => {
    setExpanded((prev) => {
      const next = { ...prev, [group]: !prev[group] };
      localSettings.set(EXPANDED_KEY, next);
      return next;
    });
  }, [localSettings]);

  // The auto-seed fires AT MOST ONCE — once the user has had (or opened) a
  // session, closing the last tab leaves the stage empty rather than respawning.
  const seededRef = useRef(false);

  // Pull the live catalogue (machines + directory-backed reservations) into the
  // store, refreshed on mount and on every fleet/slot event the host pushes.
  const refresh = useCallback(async () => {
    const nextMachines = listMachineRows(machines);
    let reservations: Reservation[] = [];
    try { reservations = await workspaces.reservations(); } catch { /* keep the last good list */ }
    setCatalogue({ machines: nextMachines, reservations: listReservationRows(reservations, nextMachines) });
  }, [machines, workspaces]);

  useEffect(() => {
    void refresh();
    const sub = machines.watch(() => void refresh());
    return () => sub.unsubscribe();
  }, [refresh, machines]);

  // Drain the action command markers (open_shell / close_shell store them in
  // localSettings and poke a bus.extension event; see ../actions for the two-channel
  // reason). An action's run() executes in the surface DAEMON (an agent, the
  // palette, the scheduler, or a host-chrome caller like the Machines view's
  // "Terminal" button) — separate memory from this app — so it can't open a tab
  // directly; it writes a marker and we apply it HERE. We read the marker from
  // localSettings and CONSUME it once applied (flip `consumed` in place), then apply
  // only UNconsumed ones: that way we handle a marker both when it arrives live (the
  // bus event, on the warm app) AND once on mount — a marker set while this app was
  // COLD (e.g. opened straight onto a machine from the Machines view) is fulfilled on
  // the next mount rather than silently dropped, while a consumed one never replays
  // on a remount. Consuming FIRST makes a re-entrant bus tick a no-op. (The in-app
  // <ActionButton> runs the same daemon action, so its marker lands the same way —
  // one path for every trigger.)
  useEffect(() => {
    const applyOpen = () => {
      const cmd = localSettings.get<OpenCommand>(OPEN_CMD_KEY);
      if (!cmd || cmd.consumed || typeof cmd.machine !== 'string') return;
      localSettings.set(OPEN_CMD_KEY, { ...cmd, consumed: true });
      // A requested open IS the seed for this mount — don't also auto-open "Server".
      seededRef.current = true;
      openSession({ machine: cmd.machine, cwd: cmd.cwd, label: cmd.label });
    };
    const applyClose = () => {
      const cmd = localSettings.get<CloseCommand>(CLOSE_CMD_KEY);
      if (!cmd || cmd.consumed) return;
      localSettings.set(CLOSE_CMD_KEY, { ...cmd, consumed: true });
      const id = cmd.sessionId || getSelected() || getLastSessionId();
      if (id) closeSession(id);
    };
    // Apply anything left unconsumed while we were cold, then follow live pokes.
    applyOpen();
    applyClose();
    const unOpen = bus.extension.subscribe(OPEN_CMD_KEY, applyOpen);
    const unClose = bus.extension.subscribe(CLOSE_CMD_KEY, applyClose);
    return () => { unOpen.unsubscribe(); unClose.unsubscribe(); };
  }, [localSettings, bus]);

  // Seed one shell on the first connected machine, once. Runs after the machine
  // list populates (worker-zero connects shortly after boot), so the app opens
  // straight into a live shell on the host's "Server" machine.
  useEffect(() => {
    if (seededRef.current) return;
    const connected = machineRows.filter((m) => m.connected);
    if (connected.length === 0) return;
    const server = connected.find((m) => m.name === 'Server') ?? connected[0];
    seededRef.current = true;
    openSession({ machine: server.id, label: server.name });
  }, [machineRows]);

  // Per-target shell numbering for tab labels ("<target> · shell N"). The number
  // is the session's STABLE seq (assigned once at open in the store), so closing
  // an earlier sibling never renumbers the rest — "shell 3" stays "shell 3" after
  // "shell 1" is closed.
  const labels = useMemo(() => {
    const out = new Map<string, string>();
    for (const s of sessions) out.set(s.sessionId, `${s.label} · shell ${s.seq}`);
    return out;
  }, [sessions]);

  const reservationGroups = useMemo(() => {
    const byExtension = new Map<string, ReservationGroup>();
    for (const r of reservationRows) {
      let g = byExtension.get(r.extensionId);
      if (!g) { g = { extensionId: r.extensionId, rows: [] }; byExtension.set(r.extensionId, g); }
      g.rows.push(r);
    }
    for (const g of byExtension.values()) g.rows.sort((a, b) => a.name.localeCompare(b.name));
    return Array.from(byExtension.values()).sort((a, b) => a.extensionId.localeCompare(b.extensionId));
  }, [reservationRows]);

  const anyConnected = machineRows.some((m) => m.connected);

  // A tree row is a one-click shortcut for terminal.open_shell pre-aimed at this
  // target — so the same op runs whether you click a row, the "+", or an agent
  // calls it. data-help feeds the bottom Info View on hover/focus.
  const openOn = useCallback((target: SpawnTarget) => openSession(target), []);

  // The target tree — the app's left nav rail.
  const tree = (
    <ExtensionSidebar className="ext-terminal-selector">
      <button
        className="ext-terminal-tree-group"
        onClick={() => toggleGroup('machines')}
        aria-expanded={expanded.machines}
        data-help-title="Machines"
        data-help="Worker machines you can open a shell on, including the host’s own “Server”. A connected machine opens in the worker’s home directory; disconnected ones are muted until they reconnect."
      >
        <Caret open={expanded.machines} />
        <span className="ext-terminal-selector-label">Machines</span>
      </button>
      {expanded.machines && (
        <div className="ext-terminal-tree-children">
          {machineRows.length === 0 ? (
            <div className="ext-terminal-tree-empty">No machines yet — they appear here as workers connect.</div>
          ) : (
            machineRows.map((m) => (
              <button
                key={m.id}
                className="ext-terminal-selector-item"
                disabled={!m.connected}
                onClick={() => openOn({ machine: m.id, label: m.name })}
                data-help-title={`Open a shell on ${m.name}`}
                data-help={m.connected
                  ? `Open a new shell on ${m.name}, in the worker’s home directory.`
                  : `${m.name} is disconnected — its worker isn’t reachable, so no shell can open there until it reconnects.`}
              >
                <span className={`ext-terminal-dot ${m.connected ? 'connected' : 'disconnected'}`} aria-hidden="true" />
                <span className="ext-terminal-selector-label">{m.name}</span>
                {!m.connected && <span className="ext-terminal-selector-hint">offline</span>}
              </button>
            ))
          )}
        </div>
      )}

      <button
        className="ext-terminal-tree-group"
        onClick={() => toggleGroup('reservations')}
        aria-expanded={expanded.reservations}
        data-help-title="Reservations"
        data-help="Directory-backed slots other extensions hold, grouped by owner. Opening one drops a shell straight into that slot’s working directory on its machine."
      >
        <Caret open={expanded.reservations} />
        <span className="ext-terminal-selector-label">Reservations</span>
      </button>
      {expanded.reservations && (
        <div className="ext-terminal-tree-children">
          {reservationGroups.length === 0 ? (
            <div className="ext-terminal-tree-empty">No directory-backed slots open right now.</div>
          ) : (
            reservationGroups.map((g) => (
              <div key={g.extensionId} className="ext-terminal-tree-section">
                <div className="ext-terminal-tree-section-title">{g.extensionId}</div>
                {g.rows.map((row) => (
                  <button
                    key={row.reservationId}
                    className="ext-terminal-selector-item"
                    disabled={!row.connected}
                    onClick={() => openOn({ machine: row.machine, cwd: row.cwd, label: row.name })}
                    data-help-title={`Open a shell in ${row.name}`}
                    data-help={row.connected
                      ? `Open a shell in ${row.cwd}${row.machineName ? ` on ${row.machineName}` : ''}.`
                      : `${row.name}’s machine${row.machineName ? ` (${row.machineName})` : ''} is offline — reconnect it to open a shell here.`}
                  >
                    <span className="ext-terminal-selector-label">{row.name}</span>
                    {row.machineName && <span className="ext-terminal-selector-hint">{row.machineName}</span>}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </ExtensionSidebar>
  );

  // The session area — a tab strip over the xterm stage. Each tab carries a
  // trailing close ×; the strip's trailing "+" runs the open-shell action (with
  // its live target picker). The stage keeps every shell mounted, showing only
  // the selected one (visibility-toggled, never unmounted — see XtermTerminal).
  const sessionTabs = sessions.map((s) => ({
    id: s.sessionId,
    label: labels.get(s.sessionId) ?? s.label,
    trailing: (
      <button
        className="ext-terminal-tab-close"
        onClick={(ev) => { ev.stopPropagation(); closeSession(s.sessionId); }}
        title="Close session"
        aria-label="Close session"
        data-help-title="Close this shell"
        data-help="Close this terminal session and kill its shell. Its scrollback is discarded."
      >
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    ),
  }));

  const newShellButton = (
    <ActionButton
      actionId="terminal.open_shell"
      className="ext-terminal-newtab"
      disabled={!anyConnected}
      title={anyConnected ? 'Open a new shell' : 'No machine is connected yet'}
      aria-label="Open a new shell"
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
        <path d="M8 3.5v9M3.5 8h9" />
      </svg>
    </ActionButton>
  );

  const sessionArea = (
    <div className="ext-terminal-main">
      <ExtensionTabs
        tabs={sessionTabs}
        activeId={selected}
        onSelect={selectSession}
        actions={sessions.length > 0 ? newShellButton : undefined}
      />
      <div className="ext-terminal-stage">
        {sessions.length === 0 && (
          <EmptyState
            icon={<ShellGlyph />}
            title={anyConnected ? 'No shell open' : 'Waiting for a machine'}
            description={anyConnected
              ? 'Open a shell on a machine or a reservation’s directory. Pick a target on the left, or use the button below.'
              : 'A worker machine has to connect before a shell can open. The host’s own “Server” comes online shortly after start-up.'}
            action={anyConnected
              ? <ActionButton actionId="terminal.open_shell" className="btn-secondary btn-sm">Open a shell</ActionButton>
              : undefined}
          />
        )}
        {sessions.map((s) => (
          <div
            key={s.sessionId}
            className={`ext-terminal-mount ${selected === s.sessionId ? 'active' : 'hidden'}`}
          >
            <XtermTerminal
              terminal={terminal}
              machine={s.machine}
              cwd={s.cwd}
              active={selected === s.sessionId}
              focusNonce={focusNonce}
              onClose={() => closeSession(s.sessionId)}
              onNewSession={() => openSession(s)}
            />
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <Split
      className="ext-terminal-panel"
      first={tree}
      second={sessionArea}
      initialFirstSize={184}
      minFirstSize={140}
      minSecondSize={240}
      storageKey="frontier.terminal.selectorWidth"
    />
  );
}

// The empty-stage glyph: a shell prompt (chevron + cursor line), matching the
// app's launcher icon, drawn larger for the EmptyState.
function ShellGlyph() {
  return (
    <svg width="44" height="44" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M4 6l2.2 2L4 10M7.5 10.5h4" />
    </svg>
  );
}

// The persisted expand/collapse state of the two tree groups, defaulting both
// open. Read from localSettings on mount.
function readExpanded(localSettings: SurfaceServices['localSettings']): Record<GroupId, boolean> {
  return { machines: true, reservations: true, ...localSettings.get<Record<GroupId, boolean>>(EXPANDED_KEY) };
}
