#!/usr/bin/env bash
# Installs Web Console as a safe, self-hosted systemd service.
set -euo pipefail

INSTALL_DIR=/opt/web-console
WORKSPACE_ROOT=/workspace
SERVICE_USER=webconsole

usage() {
  cat <<'EOF'
Usage: sudo ./scripts/install-systemd.sh [--install-dir DIR] [--workspace DIR] [--password VALUE]

Copies this checkout, creates an unprivileged service account, generates a
production .env, installs systemd units, builds the app, and starts it on
127.0.0.1:8790. Put HTTPS/basic auth in a reverse proxy before exposing it.
EOF
}

while (($#)); do
  case "$1" in
    --install-dir) INSTALL_DIR=${2:?missing value}; shift 2 ;;
    --workspace) WORKSPACE_ROOT=${2:?missing value}; shift 2 ;;
    --password) AUTH_PASSWORD=${2:?missing value}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ ${EUID} -ne 0 ]]; then
  echo 'Run with sudo/root.' >&2
  exit 1
fi

SOURCE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
if ! command -v pnpm >/dev/null; then
  command -v corepack >/dev/null || { echo 'pnpm is required and Corepack is unavailable.' >&2; exit 1; }
  corepack enable
  corepack prepare pnpm@11.6.0 --activate
fi
command -v openssl >/dev/null || { echo 'openssl is required.' >&2; exit 1; }

id -u "$SERVICE_USER" >/dev/null 2>&1 || \
  useradd --system --create-home --home-dir "/var/lib/$SERVICE_USER" --shell /usr/sbin/nologin "$SERVICE_USER"

install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$WORKSPACE_ROOT" "$WORKSPACE_ROOT/uploads"
install -d -m 0755 "$(dirname "$INSTALL_DIR")"
rsync -a --delete \
  --exclude .git --exclude node_modules --exclude .next --exclude .env --exclude data \
  "$SOURCE_DIR/" "$INSTALL_DIR/"
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

AUTH_PASSWORD=${AUTH_PASSWORD:-$(openssl rand -base64 24)}
JWT_SECRET=$(openssl rand -hex 32)
ADMIN_TOKEN=$(openssl rand -hex 32)
cat > "$INSTALL_DIR/.env" <<EOF
AUTH_PASSWORD=$AUTH_PASSWORD
JWT_SECRET=$JWT_SECRET
WEB_CONSOLE_ADMIN_TOKEN=$ADMIN_TOKEN
PORT=8790
WS_PORT=8791
WS_HOST=127.0.0.1
NEXT_PUBLIC_WS_PORT=8791
PTY_DAEMON_HOST=127.0.0.1
PTY_DAEMON_PORT=8792
PTY_DAEMON_URL=ws://127.0.0.1:8792
PTY_IDLE_TIMEOUT_HOURS=168
WORKSPACE_ROOT=$WORKSPACE_ROOT
FILE_ACCESS_ROOT=$WORKSPACE_ROOT
ALLOW_FULL_FILESYSTEM=false
ALLOWED_CWD_ROOT=$WORKSPACE_ROOT
UPLOAD_DIR=$WORKSPACE_ROOT/uploads
NEXT_PUBLIC_WORKSPACE_ROOT=$WORKSPACE_ROOT
NEXT_PUBLIC_UPLOAD_DIR=$WORKSPACE_ROOT/uploads
NEXT_PUBLIC_APP_LABEL=Web Console
EOF
chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/.env"
chmod 0600 "$INSTALL_DIR/.env"

runuser -u "$SERVICE_USER" -- sh -c "cd '$INSTALL_DIR' && pnpm install --frozen-lockfile && pnpm build"
install -m 0644 "$INSTALL_DIR/deploy/systemd/web-console.service" /etc/systemd/system/web-console.service
install -m 0644 "$INSTALL_DIR/deploy/systemd/web-console-ws.service" /etc/systemd/system/web-console-ws.service
install -m 0644 "$INSTALL_DIR/deploy/systemd/web-console-pty.service" /etc/systemd/system/web-console-pty.service
install -d /etc/needrestart/conf.d
install -m 0644 "$INSTALL_DIR/deploy/needrestart/99-web-console-protect-interactive.conf" /etc/needrestart/conf.d/99-web-console-protect-interactive.conf
systemctl daemon-reload
systemctl enable --now web-console-pty.service web-console-ws.service web-console.service

echo "Installed. Local URL: http://127.0.0.1:8790"
echo "Web Console password: $AUTH_PASSWORD"
echo 'Before public exposure, configure HTTPS and an external access gate in your reverse proxy.'
