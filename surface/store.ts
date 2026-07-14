// The terminal app's tiny session store (SURFACE realm) — the single source of
// truth for which shells are open, which one is focused, and the live target
// catalogue the tree renders. <TerminalPanel> subscribes (useSessions /
// useSelected / useCatalogue / useFocusNonce) and re-renders on change.
//
// This store lives ONLY in the app's surface realm. The registered actions
// (open_shell / close_shell, ../actions) do NOT mutate it directly: their run()
// executes in the separate-memory surface daemon (agent / palette / scheduler),
// so they write a command marker to localSettings (for read-at-mount) and poke a
// bus.extension event on the same key (for the live case — localSettings is
// storage, not a signaling channel), and the panel drains it into this store by
// calling openSession() / closeSession() here. So every trigger — in-app button,
// host modal, agent, scheduler — converges on this one store, the same
// localSettings-plus-bus marker pattern spaces uses for create_space.
//
// Built on React 18's useSyncExternalStore so it adds NO dependency to this lean
// extension (zustand would drag a package in; the docs warn against bloating a
// lean extension's bundle).

import { useSyncExternalStore } from 'react';

// A place a shell can open: the pty-routing identity handed to spawn, the
// directory it starts in (omitted = the machine user's default), and the human
// label its tabs carry.
export interface SpawnTarget {
  machine: string;
  cwd?: string;
  label: string;
}

// One open shell.
export interface Session extends SpawnTarget {
  sessionId: string;
  // A STABLE per-target ordinal, assigned once when the shell opens and kept for
  // its whole life — so the tab label ("<target> · shell N") never renumbers when
  // an earlier sibling on the same target is closed (closing "shell 1" must not
  // turn "shell 3" into "shell 2"). Computed as max(siblings' seq) + 1 at open.
  seq: number;
}

// The grouping key a per-target shell number counts within: same machine + same
// starting directory share one "<target> · shell N" sequence.
function targetKey(t: SpawnTarget): string {
  return `${t.machine} ${t.cwd ?? ''}`;
}

// The next stable ordinal for a target: one past the highest currently-open
// sibling's seq (NOT the count — so a gap left by a closed shell is never reused,
// keeping every live label distinct and stable).
function nextSeqForTarget(target: SpawnTarget): number {
  const key = targetKey(target);
  let max = 0;
  for (const s of state.sessions) {
    if (targetKey(s) === key && s.seq > max) max = s.seq;
  }
  return max + 1;
}

// A machine the catalogue knows about (mirrors WorkerInfo, trimmed to what the
// tree + the open-shell action need).
export interface TargetMachine {
  id: string;
  name: string;
  connected: boolean;
}

// A reservation a shell can open in, already resolved to its directory + the
// machine that holds it. Grouped under its owning extension in the tree.
export interface TargetReservation {
  reservationId: string;
  name: string;
  extensionId: string;
  machine: string;
  machineName: string | null;
  connected: boolean;
  cwd: string;
}

// The live target catalogue the tree renders and the open-shell action resolves
// a target id against. Kept here (not just in the panel) so an action can name a
// machine/reservation and find its routing without a React render in the loop.
export interface TargetCatalogue {
  machines: TargetMachine[];
  reservations: TargetReservation[];
}

interface TerminalState {
  // Open shells, in tab order. Each is one live pty.
  sessions: Session[];
  // The focused tab's sessionId, or null when none is open.
  selected: string | null;
  // The live catalogue (machines + reservations) the tree + actions read.
  catalogue: TargetCatalogue;
  // Bumped to ask the focused terminal to take keyboard focus (e.g. after a tab
  // switch or a freshly opened shell) without reaching into xterm from here.
  focusNonce: number;
}

let state: TerminalState = {
  sessions: [],
  selected: null,
  catalogue: { machines: [], reservations: [] },
  focusNonce: 0,
};

const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function setState(patch: Partial<TerminalState>): void {
  state = { ...state, ...patch };
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ── Mutations (called by the panel AND by the registered actions) ──────

// A short, collision-free id for a session. crypto.randomUUID where available
// (every browser the app targets), else a timestamp+random fallback — we only
// need uniqueness among the handful of open tabs.
function newSessionId(): string {
  const c: Crypto | undefined = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// Open a new shell on `target`, focus it, and return its id. The pty itself is
// spawned by the XtermTerminal the panel mounts for this session (this only adds
// the tab); a freshly opened tab also requests keyboard focus.
export function openSession(target: SpawnTarget): string {
  const sessionId = newSessionId();
  const seq = nextSeqForTarget(target);
  setState({
    sessions: [...state.sessions, { ...target, sessionId, seq }],
    selected: sessionId,
    focusNonce: state.focusNonce + 1,
  });
  return sessionId;
}

// Close one shell. If it was focused, focus its neighbour (the next tab, else the
// previous, else nothing). Unmounting its XtermTerminal kills the pty.
export function closeSession(sessionId: string): void {
  const idx = state.sessions.findIndex((s) => s.sessionId === sessionId);
  if (idx === -1) return;
  const sessions = state.sessions.filter((s) => s.sessionId !== sessionId);
  let selected = state.selected;
  if (selected === sessionId) {
    const fallback = sessions[idx] ?? sessions[idx - 1] ?? null;
    selected = fallback ? fallback.sessionId : null;
  }
  setState({ sessions, selected, focusNonce: state.focusNonce + 1 });
}

// Focus a tab (no-op if it isn't open) and ask its terminal to take the cursor.
export function selectSession(sessionId: string): void {
  if (!state.sessions.some((s) => s.sessionId === sessionId)) return;
  setState({ selected: sessionId, focusNonce: state.focusNonce + 1 });
}

// Replace the live target catalogue (the panel pushes this from machines/slots
// events). Identity-stable when nothing changed, so subscribers don't re-render
// on every fleet tick that yields the same set.
export function setCatalogue(next: TargetCatalogue): void {
  if (sameCatalogue(state.catalogue, next)) return;
  setState({ catalogue: next });
}

function sameCatalogue(a: TargetCatalogue, b: TargetCatalogue): boolean {
  if (a.machines.length !== b.machines.length || a.reservations.length !== b.reservations.length) return false;
  for (let i = 0; i < a.machines.length; i++) {
    const x = a.machines[i], y = b.machines[i];
    if (x.id !== y.id || x.name !== y.name || x.connected !== y.connected) return false;
  }
  for (let i = 0; i < a.reservations.length; i++) {
    const x = a.reservations[i], y = b.reservations[i];
    if (x.reservationId !== y.reservationId || x.connected !== y.connected || x.cwd !== y.cwd
      || x.name !== y.name || x.machineName !== y.machineName || x.extensionId !== y.extensionId) return false;
  }
  return true;
}

// Snapshot of the currently focused session id — the panel hands this to the
// close-command drain so "close the focused one" resolves in the surface realm.
export function getSelected(): string | null {
  return state.selected;
}

// Snapshot of the last opened session id — the close-command fallback when there
// is no explicit id and nothing is focused.
export function getLastSessionId(): string | null {
  const list = state.sessions;
  return list.length ? list[list.length - 1].sessionId : null;
}

// ── React bindings (useSyncExternalStore selectors) ────────────────────

export function useSessions(): Session[] {
  return useSyncExternalStore(subscribe, () => state.sessions);
}

export function useSelected(): string | null {
  return useSyncExternalStore(subscribe, () => state.selected);
}

export function useCatalogue(): TargetCatalogue {
  return useSyncExternalStore(subscribe, () => state.catalogue);
}

export function useFocusNonce(): number {
  return useSyncExternalStore(subscribe, () => state.focusNonce);
}
