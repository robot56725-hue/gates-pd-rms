#!/usr/bin/env bash
# =============================================================================
# Restores a Gates PD RMS database backup produced by backup_database.sh.
#
# Usage:
#   deploy/backup/restore_database.sh <path-to-.dump.gpg> <target-db-name>
#
# By default this restores into a NEW database (created fresh) rather than
# overwriting an existing one -- pass an already-existing target only if you
# have deliberately dropped/recreated it yourself, so a restore can never
# silently clobber a live database by accident.
#
# This script is also the mechanism for the periodic restore-drill
# recommended in README.md: run it against a scratch database on a
# non-production host on a schedule (monthly, at minimum) and confirm the
# row counts/spot-check data -- an untested backup is not a verified backup.
# =============================================================================
set -euo pipefail

ENCRYPTED_FILE="${1:?Usage: $0 <path-to-.dump.gpg> <target-db-name>}"
TARGET_DB="${2:?Usage: $0 <path-to-.dump.gpg> <target-db-name>}"

DB_HOST="${BACKUP_DB_HOST:-127.0.0.1}"
DB_PORT="${BACKUP_DB_PORT:-5432}"
DB_USER="${BACKUP_DB_USER:-postgres}"
CONFIG_DIR="${BACKUP_CONFIG_DIR:-/etc/gates-pd-backup}"
PASSPHRASE_FILE="${BACKUP_PASSPHRASE_FILE:-$CONFIG_DIR/passphrase}"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
fail() { log "ERROR: $*"; exit 1; }

[ -r "$ENCRYPTED_FILE" ] || fail "Cannot read $ENCRYPTED_FILE"
[ -r "$PASSPHRASE_FILE" ] || fail "Cannot read passphrase file $PASSPHRASE_FILE"

if psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -tAc \
     "SELECT 1 FROM pg_database WHERE datname = '$TARGET_DB'" | grep -q 1; then
  fail "Database '$TARGET_DB' already exists. Drop it first (or pick a scratch name) -- this script refuses to restore over an existing database."
fi

TMP_DUMP="$(mktemp --suffix=.dump)"
trap 'shred -u "$TMP_DUMP" 2>/dev/null || rm -f "$TMP_DUMP"' EXIT

log "Decrypting $ENCRYPTED_FILE..."
gpg --batch --yes --pinentry-mode loopback \
    --passphrase-file "$PASSPHRASE_FILE" \
    --decrypt "$ENCRYPTED_FILE" > "$TMP_DUMP"

log "Creating database '$TARGET_DB'..."
createdb -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$TARGET_DB"

log "Restoring into '$TARGET_DB' (this can take a while for a large database)..."
pg_restore -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$TARGET_DB" --no-owner --jobs=4 "$TMP_DUMP"

log "Restore complete. Spot-check row counts before trusting this backup, e.g.:"
echo ""
echo "  psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $TARGET_DB -c \"SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY relname;\""
