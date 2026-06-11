#!/bin/sh
# Entrypoint for the FoxTrot API container.
#
# Applies pending Prisma migrations before starting the process handed in as
# CMD. The migrations baseline has NOT landed yet (schema.prisma is still
# settling) — until prisma/migrations exists and is non-empty, we skip the
# step with a log line instead of failing the boot, so the same image works
# before and after the baseline arrives.
set -e

MIGRATIONS_DIR="/app/prisma/migrations"

if [ -d "$MIGRATIONS_DIR" ] && [ -n "$(ls -A "$MIGRATIONS_DIR" 2>/dev/null)" ]; then
  echo "[entrypoint] prisma/migrations found — running prisma migrate deploy"
  npx prisma migrate deploy --schema /app/prisma/schema.prisma
else
  echo "[entrypoint] no prisma/migrations baseline yet — skipping migrate deploy"
fi

exec "$@"
