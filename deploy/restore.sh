#!/usr/bin/env bash
# Lumi 出图 — restore a PostgreSQL backup made by deploy/backup.sh.
#
#   deploy/restore.sh --test  /var/backups/lumi/lumi-db-20260101-033000.dump.gz
#       restore into a throwaway database `lumi_restore_test`, print table counts, drop it.
#       Production data is NOT touched. Run this monthly as a restore drill.
#
#   deploy/restore.sh         /var/backups/lumi/lumi-db-20260101-033000.dump.gz[.age]
#       REPLACE the live `lumi` database. Stops api/worker/cron, restores, starts them again.
#       Asks you to type RESTORE unless --yes is given.
#
# Encrypted (.age) files need the private key:  AGE_IDENTITY=/path/to/key.txt deploy/restore.sh ...
# Download from off-site first if needed:        rclone copy r2:lumi-backups/db/<file> /tmp/
#
# Exit codes: 0 ok · 1 restore failed · 2 usage / prerequisite error · 130 aborted by user

set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

log() { printf '%s [restore] %s\n' "$(date '+%F %T')" "$*"; }
die() { local c="$1"; shift; log "ERROR: $*"; exit "$c"; }

MODE=live; YES=0; FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --test) MODE=test ;;
    --yes|-y) YES=1 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    -*) die 2 "unknown option $1" ;;
    *) FILE="$1" ;;
  esac
  shift
done
[[ -n "$FILE" && -f "$FILE" ]] || die 2 "usage: $0 [--test] [--yes] <backup file>"
docker compose version >/dev/null 2>&1 || die 2 "docker compose v2 not available"
docker compose ps --status running --services | grep -qx postgres || die 2 "postgres service is not running (docker compose up -d postgres)"

# Stream: [age -d] -> gunzip -> stdout
stream() {
  if [[ "$FILE" == *.age ]]; then
    [[ -n "${AGE_IDENTITY:-}" && -f "${AGE_IDENTITY}" ]] || die 2 "encrypted backup: set AGE_IDENTITY=/path/to/age key file"
    command -v age >/dev/null || die 2 "'age' not installed"
    age -d -i "$AGE_IDENTITY" "$FILE" | gunzip -c
  else
    gunzip -c "$FILE"
  fi
}

PSQL=(docker compose exec -T postgres psql -U lumi -v ON_ERROR_STOP=1)

if [[ "$MODE" == test ]]; then
  DB=lumi_restore_test
  log "restore drill into $DB"
  "${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB OWNER lumi" >/dev/null
  if stream | docker compose exec -T postgres pg_restore -U lumi -d "$DB" --no-owner --exit-on-error; then
    "${PSQL[@]}" -d "$DB" -c "SELECT count(*) AS migrations FROM schema_migrations" \
                 -c "SELECT relname AS table, n_live_tup AS rows FROM pg_stat_user_tables ORDER BY relname" || true
    "${PSQL[@]}" -d postgres -c "DROP DATABASE $DB" >/dev/null
    log "restore drill OK"
    exit 0
  fi
  "${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS $DB" >/dev/null || true
  die 1 "restore drill FAILED — this backup is not usable"
fi

log "about to REPLACE the live database 'lumi' with $(basename "$FILE")"
if [[ "$YES" != 1 ]]; then
  read -r -p "Type RESTORE to continue: " ans
  [[ "$ans" == RESTORE ]] || { log "aborted"; exit 130; }
fi

log "stopping api / worker / cron"
docker compose stop api worker cron
restart_app() { log "starting api / worker / cron"; docker compose up -d api worker cron; }
trap restart_app EXIT

"${PSQL[@]}" -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='lumi' AND pid <> pg_backend_pid()" >/dev/null
"${PSQL[@]}" -d postgres -c "DROP DATABASE lumi" -c "CREATE DATABASE lumi OWNER lumi" >/dev/null
if ! stream | docker compose exec -T postgres pg_restore -U lumi -d lumi --no-owner --exit-on-error; then
  die 1 "pg_restore failed — database is incomplete; restore another backup before going live"
fi
log "restore OK"
