# Terminal

A real shell, in the app: an integrated xterm terminal in the bottom panel that
drops into a shell on any connected machine — including the host's own
co-located worker ("Server") — or a reservation's working directory.

Capabilities: `ui` (xterm + the target tree), `server` (the host-side pty
bridge), and `worker` (node-pty on the machine).

## A marketplace extension — and the template for terminal-like ones

Terminal is a **marketplace extension**, not part of the core: install it (or
uninstall it) like any other. It used to ship in the image; it was deliberately
extracted so the core never depends on a shell being present — nothing in core is
hard-coded to it, and the Machines view does not assume it's installed.

It is the **reference/template for building terminal-like extensions**. Nothing
about it is privileged: it's a plain extension that composes the `server`
(host-side pty bridge) + `worker` (node-pty next to a machine's files) + `ui`
capabilities, and the platform attaches NO special meaning to it. Another
extension can ship its own terminal experience the same way — register its own
app + `terminal.open_shell`-style actions and run its own server/worker halves —
and coexist with this one. Copy this extension as a starting point.

## What it ships

- **The xterm UI** (`ui/components/XtermTerminal.tsx`, `TerminalPanel.tsx`,
  `ui/ptyClient.ts`) with a target tree (a machine / a slot's directory). The
  machine list comes straight from the machines service; the host appears in it
  as the "Server" machine (worker-zero) like any other worker. Opening a shell is
  the **UI-realm action** `terminal.open_shell` (target chosen from the live
  `terminal.target` option source — a connected machine or a directory-backed
  reservation; omit it for the default "Server"), with `terminal.close_shell` to
  close one. The tree rows, the tab strip's **+**, and the empty-state button all
  run `open_shell`, so an agent (`frontier.run_action`) and the scheduler reach
  the same op. Because the action's `run()` may execute in the controller realm
  (separate memory from the app), it writes a command marker to `ui.prefs` that the
  mounted panel drains — the cross-realm channel spaces' `create_space` also uses.
- **A host-side bridge** (`server/index.ts`) that owns the `pty.*` bus channel
  its UI calls and routes every request to the worker component over the worker
  channel — serving the daemon's pty back to the UI. The host process spawns no
  pty itself; there is no in-process / pseudo-machine path.
- **A daemon-side component** (`worker/index.ts`) that owns node-pty on the
  machine, AND a **worker-realm action** `terminal.run_command` (run an
  executable + args on the machine and return stdout/stderr/exit code). Because
  its `run()` executes on the daemon, not the UI, it can be **scheduled to fire
  unattended** — bind a `frontier.schedule_action` to a reservation and it runs in
  that slot with no app open (the canonical worker-side action; see
  core/workers/). `execFile` (command + args array, no shell) keeps it
  injection-safe, same principle as the pty's empty-argv spawn.

## How the two halves talk

An extension can run **host-side bus responders** and a **machine-side worker
component**, and bridge them:

- The UI calls the host-side bridge over the private channel:
  `pty.spawn` / `pty.input` / `pty.resize` / `pty.kill` (request), with
  `pty.data` / `pty.exit` published back.
- The bridge routes **every** machine — including the host's own worker-zero
  ("Server") — over the **worker channel** to this extension's worker component,
  which owns node-pty on the daemon. The channel protocol is the extension's own
  (correlated by `ptyId`): `spawn`/`input`/`resize`/`kill` out, `data`/`exit`
  back. This is how an extension runs logic next to a machine's files — see
  core/workers/. node-pty lives only on the worker; the host vendors none.

`node-pty` is a native module: installed locally by the daemon on first boot (or
baked into the k8s worker image), resolved via `services.importWorker('node-pty')`.
When it can't be resolved, a spawn surfaces a clean "terminal unavailable on this
worker" rather than breaking the daemon.

## Injection safety

Spawns are injection-safe by construction: the shell is spawned with an **empty
argv** (no command string, no interpolation) and user keystrokes only ever travel
over the pty stream as input bytes. See core/security.md.
A reservation's slot directory is a valid target, so a human can drop into a shell
in exactly the worktree an agent is using.
