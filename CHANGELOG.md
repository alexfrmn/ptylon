# Changelog

## 2026-07-08

### Added

- Added dedicated browser regression coverage for terminal click-to-cursor.
- Added OSS release files: `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, and GitHub Actions CI.
- Published the project from clean public release history (`42b7ff2`) with MIT licensing.
- Synced theme mode, selected palette, and imported custom palettes through server-side workspace state.

### Fixed

- Browser regression now dismisses onboarding before real pointer-event checks.
- Terminal click-to-cursor now falls back to viewport-derived cell dimensions when xterm private render dimensions are unavailable.
- Public examples no longer hardcode a personal deployment path.
- Browser regression now verifies that Theme Gallery changes persist to server workspace state.
- Workspace autosave no longer drops saved theme settings from server workspace state.
- The footer `auto` theme button now resets fixed/custom palettes back to the circadian auto palette.

### Verified

- `pnpm exec tsc --noEmit`
- `pnpm lint`
- `pnpm test:pty-gateway`
- `pnpm test:browser-regression` on a test deployment.

## 2026-05-01

### Added

- Added `pnpm test:browser-regression` for headless Chrome checks against a running Web Console instance.
- Added Attention MVP for terminal OSC notifications: live OSC 777/99/9 output now creates unread badges for tabs, split panes, workspaces, and the status bar.
- Added Metadata MVP for live PTY sessions: cwd, active command, git branch, and dirty state now surface in pane headers, tabs, sidebar, and status bar.
- Added Recipes MVP: `/api/recipes`, `.web-console.json` support, a command palette, and recipe-driven workspace creation.
- Added Phase D local control plane: token-guarded `/api/admin/*` routes and `webc` CLI for ping, recipes, workspace creation, notify, and send.
- Added Phase E Browser MVP: browser preview tabs, browser recipe support, and localhost admin/browser automation through `webc browser` commands.
- Added Phase E.1 server-side browser panel: visible browser tabs now render server Chrome frames instead of iframe-only previews, with click/type/paste/scroll routed through CDP.
- Added authenticated `/api/browser` for the logged-in UI while keeping `/api/admin/browser` localhost-only and admin-token guarded for `webc` and agents.
- Added browser tab `browserSessionId` persistence so the UI and `webc browser` can share one Chrome session.
- Added browser history/loading controls: back, forward, reload, and CDP loading state in the UI and CLI.
- Added browser frame/performance tuning: JPEG frames, slower idle polling, faster loading polling, typed-text batching, and wheel-event throttling.
- Added browser lifecycle cleanup: shutdown hooks, `closeAllBrowserSessions()`, Chrome process-group termination, SIGKILL fallback, and session crashpad helper cleanup.
- Added Phase F.2 Theme Gallery: curated palettes, hover/focus preview, apply-on-click, JSON import/export, command palette entry, and status bar entry.
- Added `webc workspace delete <workspace-id>` for control-plane cleanup.
- Added `webc browser panel --local`, `frame`, `point-click`, `type`, `scroll`, `back`, `forward`, and `reload`.

### Fixed

- Fixed click-to-cursor across wrapped terminal input lines.
- Browser regression now verifies a live OSC 777 notification fixture in addition to terminal input echo.
- Browser regression now verifies live session metadata in the UI.
- Browser regression now verifies the recipes API and command palette recipe launch.
- Browser regression now verifies Monitoring recipe starts commands in all four panes.
- Browser regression now verifies workspace actions are reachable without right-click.
- Browser regression now verifies Theme Gallery curated palette apply/reset.
- Browser regression now verifies browser panel creation, server-side browser surface rendering, visible browser click/type input, admin browser snapshot automation, and shared UI/admin browser sessions.
- Improved mobile layout: narrow screens now render one active pane, keep the workspace sidebar as an overlay, suppress desktop onboarding, and avoid terminal status text overlapping command output.
- Fixed mobile/touch workspace management by adding an explicit `...` actions button for rename, duplicate, and delete.
- Fixed recipe pane remounting so mobile/split pane tab switches do not reuse stale terminal/editor/browser component state.
- Hardened auth cookies to use secure cookies in production while keeping an explicit `ALLOW_INSECURE_COOKIE=true` escape hatch for local HTTP testing.
- Confined PTY cwd requests under `ALLOWED_CWD_ROOT`/`WORKSPACE_ROOT`.
- Added PTY input/resize validation and cleaned up terminal resize observers on component unmount.
- Fixed manual re-login after auth expiry overwriting SQLite workspace state with stale browser `localStorage`.
- Manual login now syncs server workspace state before enabling the authenticated UI.
- Trusted PTY daemon welcome now recovers live PTY sessions that exist in the daemon but are missing from workspace JSON.

### Incident

- Symptom: after leaving sessions overnight, reopening the browser showed a clean/stale workspace even though `web-console-pty.service` had not restarted.
- Evidence: `web-console-pty.service` had `NRestarts=0` and still held four live PTY sessions; nginx showed `POST /api/auth` followed by `PUT /api/workspace` with no `GET /api/workspace` on the manual login path.
- Root cause: `LoginPage` set `authenticated=true` without `syncFromServer()`, so startup effects wrote stale browser state back to SQLite.
- Recovery: orphan PTY sessions remained alive in the daemon; scrollback exposed Claude resume commands for the affected sessions.

### Verified

- `pnpm exec tsc --noEmit`
- `pnpm lint`
- `pnpm build`
- `pnpm test:pty-gateway`
- `pnpm test:browser-regression`
- Headless Chrome mobile viewport smoke at 390x844
- Production deploy restarted `web-console.service`, `web-console-ws.service`, and `web-console-pty.service` after live sessions were closed.

## 2026-04-30

### Fixed

- Increased PTY idle cleanup from hardcoded 24 hours to configurable `PTY_IDLE_TIMEOUT_HOURS`.
- Default PTY idle timeout is now 168 hours, with a 48-hour minimum.
- Reattaching to an existing terminal now refreshes its activity timestamp so returning to the console extends the session lifetime.

## 2026-04-28

### Added

- Added `deploy/needrestart/99-web-console-protect-interactive.conf` for Ubuntu production hosts.

### Fixed

- Documented and guarded against `needrestart` automatic restarts of `web-console-pty.service` and `web-console-ws.service`.
- Root cause: Ubuntu `unattended-upgrades` can invoke `needrestart`, which may restart services with old mapped libraries. Restarting `web-console-pty.service` destroys every live `node-pty` process it owns, including active Claude Code sessions.

### Verified

- Installed the same guard on the production host at `/etc/needrestart/conf.d/99-lifecoach-protect-interactive.conf`.
- `perl -c /etc/needrestart/conf.d/99-lifecoach-protect-interactive.conf`
- `needrestart -b -r l` no longer lists `web-console-pty.service` or `web-console-ws.service` as restart candidates.

## 2026-04-25

### Added

- Added `web-console-pty.service`, a long-lived localhost-only PTY daemon that owns `node-pty` sessions.
- Added `server/pty-daemon.mjs`.
- Added `pnpm start:pty`, `pnpm start:ws`, and `pnpm test:pty-gateway`.
- Added `.env.example` with public-safe defaults.
- Added configurable `WORKSPACE_ROOT`, `UPLOAD_DIR`, and `NEXT_PUBLIC_APP_LABEL`.

### Changed

- Reworked `server/ws-server.mjs` into an authenticated WebSocket gateway that proxies terminal I/O to the PTY daemon.
- Kept raw `node-pty` semantics instead of using tmux as the default backend.
- Workspace sync now protects richer local layouts from older or poorer server snapshots.
- The frontend only clears missing terminal `sessionId` values after a trusted live daemon session list.
- `pty-manager` uses `WORKSPACE_ROOT`/`process.cwd()` as the default cwd instead of a personal hardcoded path.

### Fixed

- Restarting `web-console-ws.service` no longer kills running shell sessions.
- F5/reload no longer creates duplicate PTY sessions when existing session IDs are valid.
- Closing a split pane now removes the corresponding tab/session in the correct order.
- Split keyboard shortcuts no longer intercept terminal keystrokes inside `.xterm`.
- File manager, upload, Monaco, login label, and terminal clipboard upload paths now use env-configured defaults.

### Verified

- `pnpm exec tsc --noEmit`
- `pnpm lint`
- `pnpm build`
- `pnpm test:pty-gateway`
- Live systemd status for `web-console.service`, `web-console-ws.service`, and `web-console-pty.service`
- Browser reload and workspace/split persistence with Playwright
- WS gateway restart while PTY sessions stayed alive

### Still Open

- PTY daemon restart and host reboot do not preserve live shell processes.
- Headed/VNC/WebRTC browser mode and cross-device theme sync remain separate feature phases.
