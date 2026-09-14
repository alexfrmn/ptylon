# Web Console - Agent Context

## What This Is

Browser-based terminal workspace: "Termius in a browser". It has xterm.js terminals, tabs, split panes, workspaces, file manager, Monaco editor, uploads, voice input, circadian theme, and a theme gallery.

Production URL is deployment-specific.

Stack: Next.js 16, React 19, xterm.js v6, node-pty, Monaco, SQLite, Zustand, Tailwind 4, ws.

## Current Architecture

```text
browser
  -> nginx/basic_auth
       -> localhost:8790  web-console.service       Next.js standalone
            -> server-side Chrome sessions for browser panels
       -> localhost:8791  web-console-ws.service    authenticated WS gateway
            -> localhost:8792  web-console-pty.service  long-lived PTY daemon
                 -> node-pty bash sessions
```

Important consequence: `web-console-ws.service` is no longer the shell owner. It can restart without killing shell sessions. `web-console-pty.service` is the owner of live PTY processes; restarting it still kills live shells.

## Hard Rules

1. Keep raw `node-pty` semantics. Do not add tmux/zellij as a backend or default backend.
2. `web-console-pty.service` must bind to `127.0.0.1` only.
3. Browser-facing terminal traffic goes through `web-console-ws.service` with JWT auth.
4. Do not commit `.env`, SQLite DB files, uploads, or build output.
5. Do not reintroduce personal defaults as code constants. Use `.env.example` and env vars.
6. SSR stays effectively off for the main app. Zustand + localStorage workspace state is browser-owned.
7. xterm accessibility tree hiding in `TerminalPanel.tsx` is intentional; changing it can bring back copy/selection artifacts.
8. Ctrl+C must remain SIGINT. Use Ctrl+Shift+C for terminal copy.
9. On Ubuntu, protect `web-console-pty.service` and `web-console-ws.service` from automatic `needrestart` restarts. The PTY daemon owns interactive work; unattended restarts kill live shells.
10. Manual login after auth expiry must sync SQLite workspace state before authenticated UI effects can save state.
11. Trusted PTY daemon session lists are recovery data: live sessions missing from workspace JSON should be surfaced as recovered terminal tabs.
12. Browser panels are server-side Chrome frame surfaces, not iframe previews. Do not reintroduce iframe-only behavior as the main browser panel path.
13. `/api/browser` is the logged-in UI browser endpoint. `/api/admin/browser` must remain loopback-only and admin-token guarded.
14. Restarting `web-console.service` may end browser sessions, but it must clean Chrome and crashpad helper processes. Do not involve `web-console-pty.service` in browser cleanup.

## Services

```text
web-console.service
  ExecStart=/usr/bin/node .next/standalone/server.js
  PORT=8790

web-console-ws.service
  ExecStart=/usr/bin/node server/ws-server.mjs
  WS_PORT=8791
  Requires=web-console-pty.service

web-console-pty.service
  ExecStart=/usr/bin/node server/pty-daemon.mjs
  PTY_DAEMON_HOST=127.0.0.1
  PTY_DAEMON_PORT=8792
```

Deploy sequence:

```bash
pnpm build
systemctl restart web-console.service
systemctl restart web-console-ws.service
```

Only restart `web-console-pty.service` when intentionally accepting that live shell processes will be killed.

## Key Files

```text
server/
  pty-daemon.mjs        # Long-lived localhost daemon, owns PTY sessions
  ws-server.mjs         # Browser WS gateway, auth + proxy to daemon
  pty-manager.mjs       # node-pty pool, scrollback, create/write/resize/kill/list/stats

src/lib/
  browser-automation.ts # CDP/headless Chrome sessions, frames, input, lifecycle cleanup
  theme-palettes.ts     # Curated/imported theme palette schema and presets

scripts/
  smoke-pty-gateway.mjs # Verifies WS gateway restart does not kill shell session
  browser-regression.mjs # Browser/terminal/UI regression against a running app

bin/
  webc.mjs              # Localhost admin/control CLI

deploy/systemd/
  web-console.service
  web-console-ws.service
  web-console-pty.service

deploy/needrestart/
  99-web-console-protect-interactive.conf # Prevents unattended-upgrades from killing live PTYs

src/app/
  HomeClient.tsx        # Main UI, WS lifecycle, trusted welcome/session cleanup
  api/browser/          # Logged-in UI browser panel API
  api/admin/browser/    # Localhost/token admin browser API for webc and agents
  api/workspace/        # SQLite workspace persistence
  api/files/            # File APIs
  api/upload/           # Multipart uploads

src/components/
  TerminalPanel.tsx     # xterm.js instance and create/attach/reconnect logic
  BrowserPanel.tsx      # Server-side browser viewport, toolbar, input batching
  ThemeGallery.tsx      # Curated palettes, preview/apply, JSON import/export
  SplitContainer.tsx    # Split tree and pane lifecycle
  Sidebar.tsx           # Workspace switcher/templates/import/export
  FileManager.tsx       # File browser
  MonacoEditor.tsx      # Editor
  VoiceInput.tsx        # Recording/transcription

src/stores/
  workspace-store.ts    # Zustand state, local/server merge policy
```

## Environment

Use `.env.example` as the public-safe template.

Required:

```dotenv
AUTH_PASSWORD=...
JWT_SECRET=...
# ALLOW_INSECURE_COOKIE=true only for explicit non-loopback HTTP testing
PORT=8790
WS_PORT=8791
NEXT_PUBLIC_WS_PORT=8791
PTY_DAEMON_HOST=127.0.0.1
PTY_DAEMON_PORT=8792
PTY_DAEMON_URL=ws://127.0.0.1:8792
PTY_IDLE_TIMEOUT_HOURS=168
WORKSPACE_ROOT=/workspace
ALLOWED_CWD_ROOT=/workspace
UPLOAD_DIR=/workspace/uploads
NEXT_PUBLIC_WORKSPACE_ROOT=/workspace
NEXT_PUBLIC_UPLOAD_DIR=/workspace/uploads
NEXT_PUBLIC_APP_LABEL=Web Console
```

Optional:

```dotenv
CHROME=/usr/bin/google-chrome
WEB_CONSOLE_BROWSER_SESSION_TTL_MS=600000
GROQ_API_KEY=...
```

## State Model

- Browser `localStorage`: immediate workspace/layout cache.
- SQLite `data/web-console.db`: server-side cross-device workspace state.
- PTY daemon memory: live shell processes and scrollback.

PTY idle cleanup is controlled by `PTY_IDLE_TIMEOUT_HOURS`. The default is 168 hours, and values below 48 hours are raised to 48 hours. Browser attach, resize, terminal input/output, and metadata updates all count as activity.

The frontend must only clear missing terminal session IDs after a trusted live session list from the gateway. An untrusted or stale welcome must not erase local layout.

Merge rule: richer local workspace layout wins over poorer server snapshots even if the server timestamp is newer. This prevents F5/reconnect from collapsing multi-workspace layouts into an old single-tab server state.

Auth expiry rule: the explicit login form must call `syncFromServer()` before `setAuth(true, token)`. If `setAuth` runs first, `HomeClient` effects can create/save tabs from stale `localStorage` and overwrite SQLite before `/api/workspace` is read. This caused the 2026-05-01 "clean sheet" incident.

Recovery rule: a trusted gateway welcome contains the PTY daemon's live session list. If a daemon session is not referenced by the active tabs or any saved workspace, add it back as a recovered terminal tab. The daemon may still contain useful scrollback and resume commands even when workspace JSON lost the reference.

## Verification

Run before claiming the console is fixed:

```bash
pnpm exec tsc --noEmit
pnpm lint
pnpm build
pnpm test:pty-gateway
pnpm test:browser-regression
systemctl status web-console.service web-console-ws.service web-console-pty.service --no-pager
```

Behavioral checks:

- Create terminal, split pane, create another workspace, split again.
- Reload page: workspace count, split count, and session IDs must remain stable.
- Restart only `web-console-ws.service`: PTY daemon session IDs and PIDs must remain stable.
- Close a split pane: UI tab count and daemon session count must decrease.
- Upload/file manager/voice should still work after reconnect.
- Browser regression should pass against the deployed app before closing auth/reconnect/cursor fixes.
- Theme Gallery should open from the status bar and command palette, preview palettes on hover/focus, apply a curated palette, and reset to `Circadian Auto`.
- Monitoring recipe should create four terminal sessions and render output from `top`, logs, network, and disk panes.
- Workspace rename/duplicate/delete must be reachable on touch devices through the sidebar `...` action button; do not rely only on right-click.
- Server-side browser panel should render a visible frame, accept click/type input, and remain controllable through `webc browser` using the same `browserSessionId`.
- After restarting only `web-console.service`, `ps` should not show leftover `web-console-browser`, Chrome remote-debugging, or session-specific crashpad helper processes.

## Known Gotchas

### Theme Gallery

Theme Gallery builds on `useCircadianTheme`, not the Zustand workspace store. Keep selected palette persistence in `localStorage` (`circadian-theme-palette`) and imported palette persistence in `localStorage` (`circadian-theme-custom-palettes`) unless cross-device theme sync is explicitly designed.

`Circadian Auto` removes inline CSS variable overrides and lets `data-circadian-phase` drive the existing CSS. Fixed palettes write CSS variables to `:root`, set `data-theme-palette`, set `data-terminal-tone`, and dispatch `circadian-theme-change`. Terminal and Monaco theme updates depend on that event path.

Keep palette JSON validation in `src/lib/theme-palettes.ts`; do not import arbitrary CSS text or execute user-provided code. Imported themes should be data-only variable maps.

### Mobile Panes And Recipes

Narrow screens render one split pane at a time. Keep `TerminalPanel`, `MonacoEditorPanel`, and `BrowserPanel` keyed by `tab.id` in `HomeClient.tsx`; otherwise React can reuse stale component state when mobile/split pane selection changes. That breaks recipe `initCommand` behavior and can leave Monitoring panes connected but sitting at a prompt.

`TerminalPanel` must keep `initCommandRef` synchronized with the latest prop before session creation. The Monitoring recipe depends on each pane sending its own command after the PTY session is created.

Sidebar workspace actions must stay touch reachable. Desktop right-click is useful, but mobile users need the visible `...` row action to rename, duplicate, or delete a workspace.

### Server-Side Browser Panel

The browser panel is a server-side Chrome viewport rendered as JPEG frames through the logged-in `/api/browser` endpoint. Mouse, keyboard, paste, wheel, back, forward, and reload actions are sent to the same Chrome session through CDP. Browser tabs persist `browserSessionId` so `webc browser` and the visible UI can inspect and control the same session.

Keep the API split strict: `/api/browser` uses normal app auth for the visible UI and must not expose admin tokens to client JavaScript. `/api/admin/browser` is for scripts/agents, must stay loopback-only, and must require `WEB_CONSOLE_ADMIN_TOKEN` or `JWT_SECRET`.

Browser sessions belong to `web-console.service`. Restarting that service intentionally ends browser sessions, but shutdown must call `closeAllBrowserSessions()`, signal Chrome process groups, and clean session-specific `chrome_crashpad_handler` processes. Do not restart `web-console-pty.service` for browser cleanup; it owns live shells.

This mode is still headless server Chrome. Sites with strong anti-bot, IP reputation, or endless verification checks can fail even when local previews and normal sites work. Treat that as an architecture limitation, not a UI bug. A headed/VNC/WebRTC/residential-proxy design would be a separate phase.

Keep `pnpm test:browser-regression` passing before changing `BrowserPanel.tsx`, `/api/browser`, `/api/admin/browser`, `browser-automation.ts`, or `bin/webc.mjs`.

### Gateway Restart

The daemon/gateway split fixed the original hard blocker: restarting `web-console-ws.service` used to run `ptyManager.destroy()` and kill all shells. The gateway must not import `pty-manager.mjs` directly.

### Ubuntu needrestart

Ubuntu's `needrestart` apt hook can run after unattended package upgrades and
auto-restart services with old libraries mapped. For this project,
`web-console-pty.service` is not a stateless daemon; it owns live `node-pty`
shells and child processes such as Claude Code, editors, `uv`, `node`, and
browser automation.

Install `deploy/needrestart/99-web-console-protect-interactive.conf` to
`/etc/needrestart/conf.d/` on production hosts. The 2026-04-28 incident showed
the failure mode: unattended upgrade restarted `web-console-pty.service`, the
daemon logged `All sessions destroyed`, and systemd SIGKILLed two active
`claude` processes. Treat this guard as part of production install, not an
optional hardening step.

### No tmux Backend

Do not introduce tmux/zellij as a backend for this project. The 2026-04-25 hardening decision explicitly rejected tmux as the default backend and selected raw `node-pty` because the app is meant to preserve Termius/Claude Code terminal semantics: direct PTY process ownership, predictable signal behavior, simple session lifecycle, and no extra terminal multiplexer state hidden underneath the browser UI.

The accepted architecture is raw `node-pty` owned by long-lived `web-console-pty.service`, with `web-console-ws.service` acting only as a restartable authenticated gateway. This guarantees survival across `web-console-ws.service` restarts. It does not guarantee survival across `web-console-pty.service` restarts; that limitation is known and intentional until a separate session backend is designed.

### Trusted Welcome

Do not send a browser `welcome` with an empty cached session list and allow the frontend to treat it as authoritative. That was the source of F5 creating duplicate sessions.

### Manual Relogin

The manual login path is different from the cookie-valid startup path. Keep `LoginPage` in sync with `HomeClient`: after successful password auth, fetch `/api/auth`, call `syncFromServer()`, then call `setAuth(true, wsToken)`.

The 2026-05-01 incident was caused by skipping this server sync. Browser `localStorage` wrote an older two-tab workspace to SQLite at login time, while two other live PTY sessions stayed alive but orphaned in `web-console-pty.service`.

### Split Close Ordering

`SplitContainer` must call close handling before replacing the tree, or the app can no longer find the leaf being closed and the PTY will leak.

### Clipboard

`navigator.clipboard.writeText()` from `onSelectionChange` is best-effort only because browsers require user activation. Ctrl+Shift+C is the reliable copy path.

### Terminal Mouse Input

Plain clicks must only focus/select; never synthesize arrow keys from screen coordinates, because TUIs use arrows for navigation. Right-click text must use `term.paste()` to preserve bracketed-paste framing. These behaviors and Escape delivery are covered by `pnpm test:browser-regression`. `pnpm test:terminal-input` also checks native selection and Codex paste after truncated scrollback, using the deployed frontend with isolated API/WebSocket mocks. When live process metadata identifies Codex, recover missing bracketed-paste mode before pasting; respect other applications’ mode.

### Attention Notifications

Terminal attention UI is fed by live OSC output only. Do not replay notifications from scrollback: `scrollback` messages should restore terminal pixels, while `output` messages may create unread tab/workspace/pane badges. Keep OSC 777 browser regression coverage before changing this parser path.

### Session Metadata

Collect live session metadata outside the shell through daemon-side `/proc` reads and bounded `git -C` calls. Do not inject prompt hooks, aliases, or background commands into user PTYs just to learn cwd/git status.

### Recipes

Recipes are loaded from built-ins plus `${WORKSPACE_ROOT}/.web-console.json` through `/api/recipes`, then launched from the browser command palette. Recipe-created browser tabs may set a URL, but keep browser automation actions explicit through `/api/admin/browser` and `webc browser`; do not hide clicks, eval, or screenshots inside recipe launch.

### Local Admin API / webc

The `/api/admin/*` control plane is for localhost scripts and agents only. Keep it token-guarded with `WEB_CONSOLE_ADMIN_TOKEN` or `JWT_SECRET`, deny non-loopback `X-Forwarded-For`, and do not expose it as a public unauthenticated nginx route. `webc` should remain a thin CLI over this API.

### Public Release

Public release baseline:

- Repository visibility is public from clean release commit `42b7ff2`.
- Keep HEAD secret/internal-reference scans clean.
- Keep `.env`, databases, uploads, runtime browser profiles, and local deployment paths out of git.
- Rotate any real local `.env` secrets before publishing forks, support bundles, or new release-history rewrites.
- Re-run fresh clone install/build/run before future public release tags.
