#!/usr/bin/env bash
# =============================================================================
# One-time HTTPS bootstrap for the Gates PD RMS API, via nginx + Let's
# Encrypt (certbot). Run this ONCE on the actual production host -- not in a
# container/dev sandbox -- after DNS for your domain already points at this
# machine's public IP and ports 80/443 are reachable from the internet.
# Certbot's HTTP-01 challenge will otherwise simply fail with a timeout.
#
# Usage:
#   sudo deploy/setup_https.sh citations.gatespd.tn.gov ops@gatespd.tn.gov
#
# What it does, in order (see the inline comments -- the ordering matters):
#   1. Installs nginx + certbot if not already present.
#   2. Deploys an HTTP-only "bootstrap" nginx config (no TLS directives yet
#      -- nginx cannot start a server block pointing at a cert file that
#      doesn't exist).
#   3. Obtains the certificate via the HTTP-01 webroot method.
#   4. Swaps in the real config (deploy/nginx/gates-pd-api.conf, which DOES
#      have the TLS/HSTS/OCSP block) now that the certificate files exist.
#   5. Confirms certbot's renewal timer is active and wires a reload hook so
#      nginx actually picks up each renewed certificate.
# =============================================================================
set -euo pipefail

DOMAIN="${1:?Usage: $0 <domain> <email>}"
EMAIL="${2:?Usage: $0 <domain> <email>}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEBROOT="/var/www/certbot"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this as root (sudo deploy/setup_https.sh $DOMAIN $EMAIL)." >&2
  exit 1
fi

echo "==> Installing nginx and certbot (if not already present)..."
if ! command -v nginx >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y nginx
fi
if ! command -v certbot >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y certbot
fi

echo "==> Preparing ACME HTTP-01 webroot at $WEBROOT..."
mkdir -p "$WEBROOT"

echo "==> Deploying temporary HTTP-only bootstrap config..."
sed "s/DOMAIN_NAME_PLACEHOLDER/$DOMAIN/g" \
  "$REPO_DIR/deploy/nginx/gates-pd-api-bootstrap.conf" \
  > /etc/nginx/sites-available/gates-pd-api.conf
ln -sf /etc/nginx/sites-available/gates-pd-api.conf /etc/nginx/sites-enabled/gates-pd-api.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "==> Requesting certificate from Let's Encrypt for $DOMAIN..."
certbot certonly \
  --webroot -w "$WEBROOT" \
  -d "$DOMAIN" \
  --email "$EMAIL" \
  --agree-tos \
  --non-interactive \
  --deploy-hook "systemctl reload nginx"

echo "==> Certificate obtained. Deploying the full TLS config..."
sed "s/DOMAIN_NAME_PLACEHOLDER/$DOMAIN/g" \
  "$REPO_DIR/deploy/nginx/gates-pd-api.conf" \
  > /etc/nginx/sites-available/gates-pd-api.conf
nginx -t
systemctl reload nginx

echo "==> Confirming certbot's auto-renewal timer is active..."
systemctl enable --now certbot.timer
systemctl status certbot.timer --no-pager | head -5

echo ""
echo "Done. https://$DOMAIN should now serve the API over TLS 1.2/1.3 only,"
echo "with HTTP redirecting to HTTPS. Renewal is automatic (certbot.timer"
echo "runs twice daily and only acts within ~30 days of expiry); each"
echo "successful renewal reloads nginx via the --deploy-hook set above."
echo ""
echo "Remember to set TRUST_PROXY=true in the API's .env now that nginx is"
echo "the entry point -- otherwise every audit_logs.ip_address will record"
echo "127.0.0.1 instead of the officer's real address. See src/app.js."
