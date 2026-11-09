#!/usr/bin/env bash
# One-time nginx + SSL setup on the host (needs sudo):  ssh -t ubuntu 'bash ~/surviver/deploy/setup-nginx.sh'
# Touches only: sites-available/surviver.yunix.software + ONE include line in nginx.conf (backup kept).
set -euo pipefail
DOMAIN=surviver.yunix.software
CONF=/etc/nginx/sites-available/$DOMAIN
MAIN=/etc/nginx/nginx.conf
CERT=/etc/letsencrypt/live/$DOMAIN/fullchain.pem
SRC="$(dirname "$0")/nginx.conf"

# 1. certificate (HTTP-01 via the nginx plugin; no-op if it already exists)
if ! sudo test -f "$CERT"; then
  sudo certbot certonly --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email
fi

# 2. vhost file; the old symlink in sites-enabled is unused on this host
sudo cp "$SRC" "$CONF"
sudo rm -f /etc/nginx/sites-enabled/$DOMAIN

# 3. include it from nginx.conf (http block), with rollback on a failed config test
BACKUP=$MAIN.bak-surviver-$(date +%s)
sudo cp "$MAIN" "$BACKUP"
if ! sudo grep -qF "include $CONF;" "$MAIN"; then
  sudo sed -i "\#include /etc/nginx/ndvwa/\*.conf;#a\    include $CONF;   # surviver game" "$MAIN"
fi
if sudo nginx -t; then
  sudo systemctl reload nginx
  echo "OK: https://$DOMAIN  (backup: $BACKUP)"
else
  echo "nginx -t failed, restoring $BACKUP" >&2
  sudo cp "$BACKUP" "$MAIN"
  sudo rm -f "$CONF"
  sudo nginx -t && sudo systemctl reload nginx
  exit 1
fi
