import { createRoot } from 'react-dom/client';
import type { SurfaceProvider, ExtensionHost } from '../../types';
import { TerminalPanel } from './components/TerminalPanel';
import { createPtyClient } from './ptyClient';
import { registerActions } from './actions';
import './styles.css';

// The Terminal app. It owns its entire content rect and renders the
// whole terminal experience inside: a TARGET TREE rail (machines /
// reservations) via ExtensionSidebar, and a strip of session tabs (ExtensionTabs) over the
// active xterm — one live shell per tab. Every target (including the host's own
// "Server" machine) routes to a worker daemon; the ptys themselves live on the
// daemon, bridged through this extension's server code over its bus channel
// (ptyClient).
//
// CRITICAL: each session's XtermTerminal mounts EXACTLY ONCE and is kept in the
// DOM (visibility-toggled, never unmounted) across internal tab switches, so a
// shell survives switching tabs. The host's warm-keep model keeps the WHOLE app
// mounted across app switches/peeks, so those don't tear the ptys down either.

// The launcher glyph: a shell prompt (chevron + cursor line), drawn in the
// 0 0 16 16 viewBox apps use, stroked in currentColor.
const TERMINAL_ICON = 'M3.5 4l3 3-3 3M8.5 11h4';

export function register(uiProvider: SurfaceProvider): void {
  const ui = uiProvider.version(1);

  // Declare the app's operations ONCE as actions (open/close a shell) + the live
  // target option source they pick from. register() runs in BOTH realms; an
  // action's run() resolves against host services and writes a command marker to
  // ui.prefs, which the mounted <TerminalPanel> drains — so the same op runs from
  // the in-app button, the host modal, an agent (frontier.run_action), or the
  // scheduler. The daemon-side terminal.run_command lives in worker/index.ts.
  registerActions(ui);

  ui.application.register({
    id: 'terminal',
    title: 'Terminals',
    icon: TERMINAL_ICON,
    color: '#22d3ee',
    // The app owns host.container entirely. mount() runs ONCE (the host warms
    // this app's webview once, then only toggles visibility); the returned
    // teardown runs if the user quits Terminal from the launcher — which
    // unmounts every open shell's pty along with it.
    mount(host: ExtensionHost) {
      const root = createRoot(host.container);
      root.render(
        <TerminalPanel
          terminal={createPtyClient(host.bus)}
          machines={host.services.workers}
          workspaces={host.services.workspaces}
          prefs={host.prefs}
        />,
      );
      return () => root.unmount();
    },
  });
}
