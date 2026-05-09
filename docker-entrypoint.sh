#!/bin/sh
set -eu

CONFIG_PATH="${CONFIG_PATH:-/app/config.yaml}"
export CONFIG_PATH
MIGRATIONS_DIR="${MIGRATIONS_DIR:-/data/drizzle}"
export MIGRATIONS_DIR

if [ ! -f "$CONFIG_PATH" ]; then
  echo "Config file not found: $CONFIG_PATH" >&2
  echo "Mount config.yaml to /app/config.yaml, or set CONFIG_PATH to the mounted path." >&2
  exit 1
fi

if [ "${MIGRATE_ON_STARTUP:-true}" = "true" ]; then
  max_attempts="${MIGRATION_ATTEMPTS:-30}"
  delay_seconds="${MIGRATION_DELAY_SECONDS:-2}"
  attempt=1

  mkdir -p "$MIGRATIONS_DIR"

  echo "Running database migrations..."
  while ! sh -c './node_modules/.bin/drizzle-kit generate --config ./drizzle.config.ts && node --import tsx ./src/migrate.ts'; do
    if [ "$attempt" -ge "$max_attempts" ]; then
      echo "Database migration failed after $max_attempts attempts." >&2
      exit 1
    fi

    echo "Database migration failed. Retrying in ${delay_seconds}s ($attempt/$max_attempts)..." >&2
    attempt=$((attempt + 1))
    sleep "$delay_seconds"
  done
fi

exec "$@"
