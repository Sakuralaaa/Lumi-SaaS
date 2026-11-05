#!/usr/bin/env bash
# Lumi 出图 — daily PostgreSQL backup.
#
#   deploy/backup.sh            # run from anywhere; operates on the compose project next to this script
#
# Steps: pg_dump (custom format) via `docker compose exec` -> gzip -> optional age encryption
#        -> keep newest $BACKUP_KEEP locally -> optional rclone upload -> webhook alert on failure.
#
# Settings (environment overrides .env, .env overrides defaults):
#   BACKUP_DIR=/var/backups/lumi   BACKUP_KEEP=14
#   AGE_RECIPIENT=age1...          encrypt with this public key (install `age`; keep the private key OFF the server)
#   RCLONE_REMOTE=r2:lumi-backups/db   upload each backup (install + `rclone config` first)
#   BACKUP_FILES=1                 also tar the local storage volume (only useful with STORAGE_DRIVER=local)
#   ALERT_WEBHOOK_URL=...          POST a message here when the backup fails (飞书/企业微信/钉钉/Slack/generic)
#
# Exit codes: 0 ok · 1 dump failed · 2 config/prereq error · 3 encryption failed · 4 upload failed
#             (local copy kept) · 5 another backup is running
#
# Cron (root crontab, daily 03:30 server time):
#   30 3 * * * /opt/lumi/deploy/backup.sh >> /var/log/lumi-backup.log 2>&1

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$APP_DIR"

# Read KEY=value from .env without executing it (values may contain $ & etc.).
env_get() {
  local key="$1" line
  [[ -f .env ]] || return 0
  line="$(grep -E "^[[:space:]]*${key}=" .env | tail -n1 || true)"
  line="${line#*=}"; line="${line%\"}"; line="${line#\"}"; line="${line%\'}"; line="${line#\'}"
  printf '%s' "$line"
}
cfg() { local v="${!1:-}"; [[ -n "$v" ]] && printf '%s' "$v" || { v="$(env_get "$1")"; printf '%s' "${v:-${2:-}}"; }; }

BACKUP_DIR="$(cfg BACKUP_DIR /var/backups/lumi)"
BACKUP_KEEP="$(cfg BACKUP_KEEP 14)"
AGE_RECIPIENT="$(cfg AGE_RECIPIENT)"
RCLONE_REMOTE="$(cfg RCLONE_REMOTE)"
BACKUP_FILES="$(cfg BACKUP_FILES 0)"
ALERT_WEBHOOK_URL="$(cfg ALERT_WEBHOOK_URL)"
HOSTNAME_S="$(hostname -s 2>/dev/null || hostname)"

log() { printf '%s [backup] %s\n' "$(date '+%F %T')" "$*"; }

alert() {
  local msg="【Lumi 告警】数据库备份失败 @ ${HOSTNAME_S}: $1"
  [[ -n "$ALERT_WEBHOOK_URL" ]] || return 0
  command -v curl >/dev/null || return 0
  local host body esc
  host="$(printf '%s' "$ALERT_WEBHOOK_URL" | sed -E 's#^[a-z]+://([^/:]+).*#\1#')"
  esc="$(printf '%s' "$msg" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  case "$host" in
    *feishu.cn|*larksuite.com) body="{\"msg_type\":\"text\",\"content\":{\"text\":\"$esc\"}}" ;;
    qyapi.weixin.qq.com|oapi.dingtalk.com) body="{\"msgtype\":\"text\",\"text\":{\"content\":\"$esc\"}}" ;;
    hooks.slack.com) body="{\"text\":\"$esc\"}" ;;
    *discord.com|*discordapp.com) body="{\"content\":\"$esc\"}" ;;
    *) body="{\"type\":\"backup_failed\",\"service\":\"lumi\",\"message\":\"$esc\"}" ;;
  esac
  curl -fsS -m 10 -H 'Content-Type: application/json' -d "$body" "$ALERT_WEBHOOK_URL" >/dev/null || log "alert webhook failed"
}

fail() { local code="$1"; shift; log "ERROR: $*"; alert "$*"; exit "$code"; }

# --- prerequisites -----------------------------------------------------------
command -v docker >/dev/null || fail 2 "docker not found"
docker compose version >/dev/null 2>&1 || fail 2 "docker compose v2 not available"
[[ "$BACKUP_KEEP" =~ ^[0-9]+$ && "$BACKUP_KEEP" -ge 1 ]] || fail 2 "BACKUP_KEEP must be a positive integer"
if [[ -n "$AGE_RECIPIENT" ]]; then command -v age >/dev/null || fail 2 "AGE_RECIPIENT set but 'age' is not installed"; fi
if [[ -n "$RCLONE_REMOTE" ]]; then command -v rclone >/dev/null || fail 2 "RCLONE_REMOTE set but 'rclone' is not installed"; fi
mkdir -p "$BACKUP_DIR" || fail 2 "cannot create $BACKUP_DIR"

exec 9>"$BACKUP_DIR/.lock"
flock -n 9 || { log "another backup is running"; exit 5; }

trap 'rm -f "$BACKUP_DIR"/.tmp-* 2>/dev/null || true' EXIT
trap 'fail 1 "unexpected error at line $LINENO"' ERR

docker compose ps --status running --services 2>/dev/null | grep -qx postgres || fail 1 "postgres service is not running"

STAMP="$(date +%Y%m%d-%H%M%S)"
NAME="lumi-db-$STAMP.dump.gz"
TMP="$BACKUP_DIR/.tmp-$NAME"

# --- dump --------------------------------------------------------------------
log "dumping database -> $NAME"
if ! docker compose exec -T postgres pg_dump -U lumi -d lumi --format=custom --compress=0 --no-owner | gzip -6 > "$TMP"; then
  fail 1 "pg_dump failed"
fi
gzip -t "$TMP" || fail 1 "gzip integrity check failed"
SIZE=$(stat -c %s "$TMP")
[[ "$SIZE" -gt 1024 ]] || fail 1 "dump suspiciously small (${SIZE} bytes)"

# --- encrypt -------------------------------------------------------------------
FINAL="$BACKUP_DIR/$NAME"
if [[ -n "$AGE_RECIPIENT" ]]; then
  FINAL="$FINAL.age"
  age -r "$AGE_RECIPIENT" -o "$TMP.age" "$TMP" || fail 3 "age encryption failed"
  rm -f "$TMP"; mv "$TMP.age" "$FINAL"
else
  mv "$TMP" "$FINAL"
fi
log "wrote $FINAL ($(du -h "$FINAL" | cut -f1))"

# --- optional: local file storage ------------------------------------------------
FILES_FINAL=""
if [[ "$BACKUP_FILES" == "1" ]]; then
  FNAME="lumi-files-$STAMP.tar.gz"
  FTMP="$BACKUP_DIR/.tmp-$FNAME"
  log "archiving local storage volume -> $FNAME"
  docker compose exec -T api tar -C /app/data -cf - storage | gzip -1 > "$FTMP" || fail 1 "storage archive failed"
  FILES_FINAL="$BACKUP_DIR/$FNAME"
  if [[ -n "$AGE_RECIPIENT" ]]; then
    FILES_FINAL="$FILES_FINAL.age"
    age -r "$AGE_RECIPIENT" -o "$FTMP.age" "$FTMP" || fail 3 "age encryption (files) failed"
    rm -f "$FTMP"; mv "$FTMP.age" "$FILES_FINAL"
  else
    mv "$FTMP" "$FILES_FINAL"
  fi
fi

# --- rotate ------------------------------------------------------------------------
rotate() { # keep newest $BACKUP_KEEP files matching prefix
  ls -1t "$BACKUP_DIR"/"$1"* 2>/dev/null | tail -n +"$((BACKUP_KEEP + 1))" | while read -r old; do
    rm -f -- "$old" && log "pruned $(basename "$old")"
  done || true   # no matching files is fine
}
rotate lumi-db-
rotate lumi-files-

# --- upload --------------------------------------------------------------------------
if [[ -n "$RCLONE_REMOTE" ]]; then
  trap - ERR
  for f in "$FINAL" ${FILES_FINAL:+"$FILES_FINAL"}; do
    log "uploading $(basename "$f") -> $RCLONE_REMOTE"
    rclone copy --retries 3 "$f" "$RCLONE_REMOTE/" || fail 4 "rclone upload failed (local copy kept: $f)"
  done
fi

log "backup OK"
exit 0
