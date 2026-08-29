#!/usr/bin/env bash
# =============================================================================
# Nightly encrypted, off-site PostgreSQL backup for the Gates PD RMS
# database. Intended to run from cron/systemd-timer as the postgres system
# user (or any user with pg_dump access to the database).
#
# Pipeline: pg_dump (custom format) -> gpg symmetric encryption -> local
# retention directory -> off-site push via rclone to S3-compatible object
# storage. The dump is encrypted BEFORE it ever leaves this host and before
# it touches the off-site bucket -- the bucket/vault only ever holds
# ciphertext, so a compromised or misconfigured bucket does not expose live
# court/citation/PII data directly.
#
# One-time setup (see deploy/backup/README.md for the full walkthrough):
#   1. Generate a strong passphrase and store it ONLY in
#      /etc/gates-pd-backup/passphrase (root-only readable, chmod 600) --
#      never in this script, never in cron, never in shell history. Losing
#      this passphrase means the backups are permanently unrecoverable, so
#      it also needs to be written down/escrowed somewhere durable OUTSIDE
#      this server (a password manager, a sealed physical copy, etc.).
#   2. `rclone config` once, interactively, to create a remote named
#      `offsite` pointing at your S3-compatible bucket (AWS S3, Backblaze
#      B2, Wasabi, MinIO, etc.). Its credentials live in rclone's own config
#      file, not in this script.
#   3. Add a cron entry (as root, or whichever user owns the config dir):
#        0 3 * * * /opt/gates-pd-api/deploy/backup/backup_database.sh >> /var/log/gates-pd-backup.log 2>&1
# =============================================================================
set -euo pipefail

# --- Configuration (override any of these via environment variables) -------
DB_NAME="${BACKUP_DB_NAME:-gates_pd_dev}"
DB_HOST="${BACKUP_DB_HOST:-127.0.0.1}"
DB_PORT="${BACKUP_DB_PORT:-5432}"
DB_USER="${BACKUP_DB_USER:-postgres}"

CONFIG_DIR="${BACKUP_CONFIG_DIR:-/etc/gates-pd-backup}"
PASSPHRASE_FILE="${BACKUP_PASSPHRASE_FILE:-$CONFIG_DIR/passphrase}"
LOCAL_BACKUP_DIR="${BACKUP_LOCAL_DIR:-/var/backups/gates-pd}"
RCLONE_REMOTE="${BACKUP_RCLONE_REMOTE:-offsite:gates-pd-backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP_FILE="$LOCAL_BACKUP_DIR/${DB_NAME}_${TIMESTAMP}.dump"
ENCRYPTED_FILE="${DUMP_FILE}.gpg"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
fail() { log "ERROR: $*"; exit 1; }

# --- Preflight checks --------------------------------------------------------
command -v pg_dump >/dev/null 2>&1 || fail "pg_dump not found on PATH."
command -v gpg >/dev/null 2>&1 || fail "gpg not found on PATH."
command -v rclone >/dev/null 2>&1 || fail "rclone not found on PATH (see script header for setup)."
[ -r "$PASSPHRASE_FILE" ] || fail "Passphrase file $PASSPHRASE_FILE is missing or unreadable. See setup notes above."

PASSPHRASE_PERMS="$(stat -c '%a' "$PASSPHRASE_FILE")"
if [ "$PASSPHRASE_PERMS" != "600" ] && [ "$PASSPHRASE_PERMS" != "400" ]; then
  fail "$PASSPHRASE_FILE has permissions $PASSPHRASE_PERMS -- expected 600 or 400. Run: chmod 600 $PASSPHRASE_FILE"
fi

mkdir -p "$LOCAL_BACKUP_DIR"
chmod 700 "$LOCAL_BACKUP_DIR"

# --- 1. Dump -----------------------------------------------------------------
# Custom format (-Fc): compressed, and restorable selectively/in parallel via
# pg_restore -- see restore_database.sh.
log "Dumping $DB_NAME from $DB_HOST:$DB_PORT..."
pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -Fc -f "$DUMP_FILE" "$DB_NAME"
DUMP_SIZE=$(stat -c '%s' "$DUMP_FILE")
[ "$DUMP_SIZE" -gt 0 ] || fail "pg_dump produced an empty file -- aborting before it overwrites a good backup off-site."
log "Dump complete: $DUMP_FILE ($DUMP_SIZE bytes)"

# --- 2. Encrypt --------------------------------------------------------------
log "Encrypting dump with gpg (AES256, symmetric)..."
gpg --batch --yes --pinentry-mode loopback \
    --passphrase-file "$PASSPHRASE_FILE" \
    --symmetric --cipher-algo AES256 \
    --output "$ENCRYPTED_FILE" \
    "$DUMP_FILE"

# The plaintext dump only ever needs to exist locally for the moment between
# pg_dump and gpg above -- never leave an unencrypted copy of court/citation
# data sitting on disk (or, worse, in the off-site vault).
shred -u "$DUMP_FILE" 2>/dev/null || rm -f "$DUMP_FILE"
chmod 600 "$ENCRYPTED_FILE"
log "Encrypted: $ENCRYPTED_FILE"

# --- 3. Verify the encrypted archive decrypts cleanly before trusting it ----
# A backup nobody has ever proven can be restored is not a backup -- this is
# the cheap, automatic half of that; see deploy/backup/README.md for the
# recommended periodic FULL restore drill (decrypt + pg_restore into a scratch
# database), which this script deliberately does not do automatically every
# night (that's a much heavier, slower operation than a nightly job should do
# unattended).
log "Verifying the encrypted archive integrity (decrypt to /dev/null)..."
gpg --batch --yes --pinentry-mode loopback \
    --passphrase-file "$PASSPHRASE_FILE" \
    --decrypt "$ENCRYPTED_FILE" > /dev/null
log "Integrity check passed."

# --- 4. Push off-site ---------------------------------------------------------
log "Uploading to off-site remote: $RCLONE_REMOTE..."
rclone copy "$ENCRYPTED_FILE" "$RCLONE_REMOTE/" --checksum
log "Upload complete."

# --- 5. Local retention: keep the last N days only ---------------------------
# The off-site vault is the durable copy; local disk is only a staging area
# and a fast-restore convenience, so it doesn't need its own long retention.
log "Pruning local backups older than $RETENTION_DAYS days..."
find "$LOCAL_BACKUP_DIR" -name "${DB_NAME}_*.dump.gpg" -mtime "+$RETENTION_DAYS" -print -delete

log "Backup run complete: ${DB_NAME}_${TIMESTAMP}.dump.gpg"
