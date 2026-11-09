#!/usr/bin/env bash
# One-time nginx + SSL setup on the server (needs sudo). Run on the host:  bash ~/surviver/deploy/setup-nginx.sh
set -euo pipefail
DOMAIN=surviver.yunix.software
CONF=/etc/nginx/sites-available/$DOMAIN
if [ ! -f "$CONF" ]; then
  sudo cp "$(dirname "$0")/nginx.conf" "$CONF"
  sudo ln -sf "$CONF" /etc/nginx/sites-enabled/$DOMAIN
fi
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d $DOMAIN --non-interactive --agree-tos --redirect || sudo certbot --nginx -d $DOMAIN --redirect
sudo nginx -t && sudo systemctl reload nginx
echo "OK: https://$DOMAIN"
