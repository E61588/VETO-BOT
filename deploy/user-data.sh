#!/bin/bash
# VETO bot — first-boot setup for an Ubuntu 24.04 server (AWS EC2, Tel Aviv).
# Paste this whole file into EC2 "Advanced details > User data" when launching
# the server. Fill in BOT_API_KEY first (the value is given to you separately;
# it must equal the BOT_API_KEY secret of the Base44 app).
#
# What it does: installs Node 20, Chromium (via Playwright) and Caddy; runs
# the bot as a systemd service on 127.0.0.1:3000; serves it over HTTPS at
# https://<public-ip-with-dashes>.sslip.io; pulls updates from GitHub every
# 10 minutes. Live submission stays OFF (ALLOW_LIVE_SUBMIT=false).
set -euo pipefail

BOT_API_KEY="__PASTE_BOT_API_KEY__"
WEBHOOK_URL="https://veto-app.base44.app/functions/automationWebhook"
REPO="https://github.com/E61588/VETO-BOT.git"
BRANCH="bot-v2"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Caddy (automatic HTTPS)
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -y
apt-get install -y caddy

# Service user and code
id vetobot >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/veto-bot-home vetobot
mkdir -p /opt/veto-bot /var/lib/veto-bot
chown vetobot:vetobot /opt/veto-bot /var/lib/veto-bot
sudo -u vetobot git clone --branch "$BRANCH" "$REPO" /opt/veto-bot/app
cd /opt/veto-bot/app
sudo -u vetobot npm ci --omit=dev
# Chromium and its system libraries, matching the installed Playwright version
npx --yes playwright install-deps chromium
sudo -u vetobot npx --yes playwright install chromium

cat > /etc/veto-bot.env <<EOF
PORT=3000
BOT_API_KEY=${BOT_API_KEY}
WEBHOOK_URL=${WEBHOOK_URL}
ALLOW_LIVE_SUBMIT=false
MAX_CONCURRENT_JOBS=2
DATA_DIR=/var/lib/veto-bot
EOF
chmod 600 /etc/veto-bot.env

cat > /etc/systemd/system/veto-bot.service <<'EOF'
[Unit]
Description=VETO appeal bot
After=network-online.target
Wants=network-online.target

[Service]
User=vetobot
WorkingDirectory=/opt/veto-bot/app
EnvironmentFile=/etc/veto-bot.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=/var/lib/veto-bot /opt/veto-bot

[Install]
WantedBy=multi-user.target
EOF

# Auto-update from GitHub every 10 minutes (only when the branch moved).
cat > /usr/local/bin/veto-bot-update <<EOF
#!/bin/bash
set -e
cd /opt/veto-bot/app
sudo -u vetobot git fetch -q origin ${BRANCH}
if [ "\$(sudo -u vetobot git rev-parse HEAD)" != "\$(sudo -u vetobot git rev-parse origin/${BRANCH})" ]; then
  sudo -u vetobot git reset -q --hard origin/${BRANCH}
  sudo -u vetobot npm ci --omit=dev
  sudo -u vetobot npx --yes playwright install chromium
  systemctl restart veto-bot
fi
EOF
chmod +x /usr/local/bin/veto-bot-update
cat > /etc/systemd/system/veto-bot-update.service <<'EOF'
[Unit]
Description=Update VETO bot from GitHub
[Service]
Type=oneshot
ExecStart=/usr/local/bin/veto-bot-update
EOF
cat > /etc/systemd/system/veto-bot-update.timer <<'EOF'
[Unit]
Description=Update VETO bot every 10 minutes
[Timer]
OnBootSec=5min
OnUnitActiveSec=10min
[Install]
WantedBy=timers.target
EOF

# HTTPS hostname from the public IP (IMDSv2), e.g. 51-16-1-2.sslip.io
TOKEN=$(curl -sX PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
PUBLIC_IP=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4)
BOT_HOST="${PUBLIC_IP//./-}.sslip.io"
cat > /etc/caddy/Caddyfile <<EOF
${BOT_HOST} {
  reverse_proxy 127.0.0.1:3000
}
EOF

systemctl daemon-reload
systemctl enable --now veto-bot veto-bot-update.timer
systemctl restart caddy
echo "VETO bot ready at https://${BOT_HOST}" | tee /var/log/veto-bot-ready.log
