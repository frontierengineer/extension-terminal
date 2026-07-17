// One xterm.js terminal bound to a single pty on a machine.
//
// Lifecycle:
//   - Mount → build xterm. We do NOT fit/spawn yet: a freshly-mounted pane
//     has not had the flex layout settle, so the mount element's height is
//     not yet final. Fitting then would compute too many rows and the shell
//     would draw past the visible area. The FIRST fit is driven from the
//     ResizeObserver (which fires once the element has a real box), and the
//     pty is spawned with those settled rows/cols.
//   - spawn() mints a ptyId; we then subscribe onData/onExit for it.
//   - User types → onData (xterm) → terminal.input(ptyId, data).
//   - Container resizes → fit addon recalcs → terminal.resize(ptyId, …).
//   - spawn returns an error (node-pty missing on the worker, pty cap hit, …) →
//     show a "couldn't open" overlay with Retry. We do NOT scribble a red error
//     line into the buffer (it reads like a crash and is easy to miss).
//   - onExit → show an ended overlay with a Restart action.
//   - A terminal call that REJECTS (link dropped) → flip to a "connection
//     lost" state. The pty is gone with that link, so we don't try to
//     reconnect it; the user closes the tab or opens a fresh session (both
//     wired up via props) without reloading the page.
//   - Unmount → terminal.kill(ptyId), dispose xterm + subscriptions.
//
// One instance per session; the parent keeps it mounted (just hidden) while
// its tab is open so the shell survives tab switches. When this session's tab
// becomes active again (or is freshly opened) the parent bumps `focusNonce`, and
// we return keyboard focus to xterm — so switching tabs lands the cursor in the
// shell without a click.

import { useEffect, useRef, useState } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { EmptyState } from '@frontierengineer/ui';
import '@xterm/xterm/css/xterm.css';
import type { PtyClient } from '../ptyClient';
import { XTERM_THEME } from '../constants';

interface Props {
  terminal: PtyClient;
  // Machine to open a shell on (a real machine id from the machines service).
  // Every machine — including the host's own worker-zero ("Server") — forwards
  // to that worker's daemon over the worker channel.
  machine: string;
  // The reservation whose slot this shell opens in, or null/absent for a
  // machine-home shell (routes the pty by reservation when set).
  reservationId?: string | null;
  // Directory the shell starts in (a reservation's slot dir); omitted, the
  // host resolves the machine user's default.
  cwd?: string;
  // Whether this session's tab is the visible/active one. Used only to gate
  // taking keyboard focus (a hidden terminal must not steal the cursor).
  active: boolean;
  // Bumped by the parent whenever the focused session should grab the cursor
  // (tab switch, fresh open). We focus xterm when this changes AND we're active.
  focusNonce: number;
  // Close this session (parent removes it; unmount kills the pty).
  onClose: () => void;
  // Open a brand-new session on the same machine (used by the
  // connection-lost recovery — the dead pty can't be revived).
  onNewSession: () => void;
}

interface ExitState {
  exitCode: number;
  signal?: number;
  error?: string;
}

// A spawn that failed before any shell existed. `unavailable` flags the specific
// "node-pty isn't installed on this worker" case, which gets its own calm copy
// (it's a machine-capability gap, not a crash) rather than a generic failure.
interface SpawnFailure {
  message: string;
  unavailable: boolean;
}

function isUnavailable(msg: string): boolean {
  return /terminal unavailable on this worker/i.test(msg);
}

export function XtermTerminal({ terminal, machine, reservationId, cwd, active, focusNonce, onClose, onNewSession }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Xterm | null>(null);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const [exit, setExit] = useState<ExitState | null>(null);
  const [lost, setLost] = useState(false);
  const [failure, setFailure] = useState<SpawnFailure | null>(null);
  const [restartKey, setRestartKey] = useState(0);

  useEffect(() => {
    if (!hostRef.current) return;

    const term = new Xterm({
      cursorBlink: true,
      convertEol: true,
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
      fontSize: 12,
      lineHeight: 1.2,
      scrollback: 10_000,
      theme: XTERM_THEME,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(hostRef.current);

    let alive = true;
    // spawn() hands back a ptyId; until then we buffer no input (the shell
    // isn't up). All I/O is keyed by it.
    let ptyId: string | null = null;
    // The first fit + spawn are deferred until the element has a real box
    // (driven by the ResizeObserver below). `spawned` guards the spawn so
    // later resize ticks only resize, never re-spawn.
    let spawned = false;
    // Set once the shell has cleanly exited. After that a stray input
    // failure is expected — the shell is gone on purpose — so we must NOT
    // mistake it for a dropped link and clobber the "Shell ended" overlay.
    let ended = false;
    let dataUnsub: (() => void) | null = null;
    let exitUnsub: (() => void) | null = null;

    // A rejected terminal call means the round-trip to the pty failed (the
    // link dropped). That pty is gone with it, so we surface the recovery
    // state rather than silently swallowing input.
    const onLinkFailed = () => {
      if (!alive || ended) return;
      setLost(true);
    };

    const spawn = (cols: number, rows: number) => {
      terminal.spawn(machine, { reservationId, cwd, cols, rows })
        .then((res) => {
          if (!alive) {
            // Component unmounted mid-spawn — kill the orphan immediately.
            if (res?.ptyId) terminal.kill(res.ptyId).catch(() => {});
            return;
          }
          if (res?.error || !res?.ptyId) {
            const message = res?.error || 'the worker returned no shell handle';
            setFailure({ message, unavailable: isUnavailable(message) });
            return;
          }
          ptyId = res.ptyId;
          dataUnsub = terminal.onData(ptyId, (data) => {
            if (alive) term.write(data);
          });
          exitUnsub = terminal.onExit(ptyId, (e) => {
            if (!alive) return;
            ended = true;
            setExit({
              exitCode: typeof e.exitCode === 'number' ? e.exitCode : -1,
              signal: typeof e.signal === 'number' ? e.signal : undefined,
              error: typeof e.error === 'string' ? e.error : undefined,
            });
          });
          // The shell is live — make sure the cursor is in it if we're the
          // visible tab (the initial mount happens before the first paint).
          if (active) term.focus();
        })
        .catch((err: any) => {
          if (!alive) return;
          const message = err?.message ? String(err.message) : String(err);
          setFailure({ message, unavailable: isUnavailable(message) });
        });
    };

    const dataSub = term.onData((data) => {
      if (!ptyId) return;
      terminal.input(ptyId, data).catch(onLinkFailed);
    });

    const ro = new ResizeObserver(() => {
      // Skip while the element has no box yet (hidden tab / pre-layout):
      // fitting a 0-height element yields a bogus row count.
      const el = hostRef.current;
      if (!el || el.clientHeight === 0 || el.clientWidth === 0) return;
      try { fit.fit(); } catch { return; }
      const c = term.cols, r = term.rows;
      // First settled measurement: spawn the pty with the real rows/cols.
      if (!spawned) {
        spawned = true;
        lastSizeRef.current = { cols: c, rows: r };
        spawn(c, r);
        return;
      }
      const last = lastSizeRef.current;
      if (!last || last.cols !== c || last.rows !== r) {
        lastSizeRef.current = { cols: c, rows: r };
        if (ptyId) terminal.resize(ptyId, c, r).catch(onLinkFailed);
      }
    });
    ro.observe(hostRef.current);

    return () => {
      alive = false;
      if (ptyId) terminal.kill(ptyId).catch(() => {});
      dataUnsub?.();
      exitUnsub?.();
      ro.disconnect();
      dataSub.dispose();
      termRef.current = null;
      try { term.dispose(); } catch { /* ignore */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal, machine, reservationId, cwd, restartKey]);

  // Return keyboard focus to the shell when this tab becomes the active one (the
  // parent bumps focusNonce on tab switch / fresh open). Guarded on `active` so a
  // hidden terminal never steals the cursor; skipped while an overlay is up.
  useEffect(() => {
    if (active && !exit && !lost && !failure) termRef.current?.focus();
  }, [active, focusNonce, exit, lost, failure]);

  const handleRestart = () => {
    setExit(null);
    setFailure(null);
    setRestartKey((k) => k + 1);
  };

  // Clicking anywhere on the stage (the padding around the screen included) puts
  // the cursor back in the shell — the expected "click the terminal to type".
  const focusShell = () => { if (!exit && !lost && !failure) termRef.current?.focus(); };

  return (
    <div className="ext-terminal-view">
      <div className="ext-terminal-host" ref={hostRef} onMouseDown={focusShell} />
      {/* A spawn that never produced a shell leaves NO terminal content behind it,
          so it reads as an empty pane — the shared EmptyState, filling it, rather
          than a card floating over a black void. (The ended / lost states below
          DO have scrollback worth keeping visible, so those stay overlay cards.) */}
      {failure && (
        <div className="ext-terminal-failure">
          <EmptyState
            icon={<FailureGlyph />}
            title={failure.unavailable ? 'Terminal unavailable here' : 'Couldn’t open a shell'}
            description={failure.unavailable
              ? 'This machine’s worker can’t start terminals — its node-pty native module isn’t installed. Other machines still work; pick one on the left, or try again once it’s set up.'
              : failure.message}
            action={
              <div className="ext-terminal-exit-actions">
                <button className="btn-ghost btn-sm" onClick={onClose} data-help-title="Close this shell" data-help="Close this session.">Close</button>
                <button className="btn-secondary btn-sm" onClick={handleRestart} data-help-title="Try opening the shell again" data-help="Retry the spawn on this target.">Try again</button>
              </div>
            }
          />
        </div>
      )}
      {lost && !failure && (
        <div className="ext-terminal-exit-overlay">
          <div className="ext-terminal-exit-card">
            <div className="ext-terminal-exit-headline">Connection lost</div>
            <div className="ext-terminal-exit-note">
              The link to this shell dropped. Its session is gone — close this
              tab or start a fresh session.
            </div>
            <div className="ext-terminal-exit-actions">
              <button className="btn-ghost btn-sm" onClick={onClose} data-help-title="Close this shell" data-help="Close this dropped session.">Close</button>
              <button className="btn-secondary btn-sm" onClick={onNewSession} data-help-title="Open a fresh shell on this target" data-help="The dropped pty can’t be revived; this opens a new shell on the same target.">New session</button>
            </div>
          </div>
        </div>
      )}
      {exit && !lost && !failure && (
        <div className="ext-terminal-exit-overlay">
          <div className="ext-terminal-exit-card">
            <div className="ext-terminal-exit-headline">
              Shell ended
              {exit.error && <span className="ext-terminal-exit-error"> · {exit.error}</span>}
            </div>
            {/* The exit code line is only meaningful for a REAL process exit. A
                synthetic stop (machine disconnected, link severed) carries the
                sentinel exit code -1 alongside an `error` that already explains
                it — showing a bare "exit code -1" there reads like the program
                failed with status -1, so we drop it and let the headline speak. */}
            {!(exit.exitCode < 0 && exit.error) && (
              <div className="ext-terminal-exit-meta">
                exit code {exit.exitCode}
                {exit.signal ? ` · signal ${exit.signal}` : ''}
              </div>
            )}
            <div className="ext-terminal-exit-actions">
              <button className="btn-ghost btn-sm" onClick={onClose} data-help-title="Close this shell" data-help="Close this finished session and its tab.">Close</button>
              <button className="btn-secondary btn-sm" onClick={handleRestart} data-help-title="Start a new shell here" data-help="Open a fresh shell on the same target, in place.">Restart</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// The empty-pane glyph for a shell that couldn't open: a terminal window with a
// small warning slash, drawn in the apps' 0 0 16 16 viewBox.
function FailureGlyph() {
  return (
    <svg width="44" height="44" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M4 6l2 2-2 2" />
      <path d="M10.5 6.5l3 3M13.5 6.5l-3 3" />
    </svg>
  );
}
