#!/usr/bin/env bash
# Deploy the web SPA to the staging S3 static-website bucket.
#
# Usage:
#   ./deploy-web-staging.sh <VITE_API_URL> [VITE_SOCKET_URL]
#   e.g. ./deploy-web-staging.sh http://foxtrot-api-prod.xyz.us-east-1.elasticbeanstalk.com
#
# VITE_SOCKET_URL defaults to VITE_API_URL (socket.io shares the API port).
# Idempotent: rebuilds and re-syncs; safe to run repeatedly.
#
# Cache policy (matches the initial manual sync):
#   - hashed assets  → public,max-age=31536000,immutable
#   - index.html     → no-cache (so deploys go live immediately)
set -euo pipefail

BUCKET="foxtrot-web-826671498662"
REGION="us-east-1"
WEBSITE_URL="http://${BUCKET}.s3-website-${REGION}.amazonaws.com"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <VITE_API_URL> [VITE_SOCKET_URL]" >&2
  exit 1
fi

API_URL="${1%/}"
SOCKET_URL="${2:-$API_URL}"
SOCKET_URL="${SOCKET_URL%/}"

# Repo root = two levels up from this script (apps/api/scripts).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DIST="$ROOT/apps/web/dist"

echo "==> Building web (VITE_API_URL=$API_URL VITE_SOCKET_URL=$SOCKET_URL)"
(cd "$ROOT" && VITE_API_URL="$API_URL" VITE_SOCKET_URL="$SOCKET_URL" npm run build -w apps/web)

[[ -f "$DIST/index.html" ]] || { echo "Build produced no index.html in $DIST" >&2; exit 1; }

echo "==> Syncing hashed assets (long cache)"
aws s3 sync "$DIST" "s3://$BUCKET" \
  --region "$REGION" \
  --delete \
  --exclude "index.html" \
  --cache-control "public,max-age=31536000,immutable"

echo "==> Uploading index.html (no-cache)"
aws s3 cp "$DIST/index.html" "s3://$BUCKET/index.html" \
  --region "$REGION" \
  --cache-control "no-cache" \
  --content-type "text/html"

echo "==> Deployed: $WEBSITE_URL"
