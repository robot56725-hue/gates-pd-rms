# Gates PD RMS — Encrypted Off-Site Database Backups

This directory implements the second item of the deployment note: automated
daily `pg_dump` backups, encrypted, and shipped off-site to a password-protected
vault, since this application handles active court files and fine tracking.

Pipeline: `pg_dump` (custom format) → GPG symmetric encryption (AES256) →
local retention directory → off-site push via `rclone` to S3-compatible
object storage. The dump is encrypted **before** it ever leaves this host, so
a compromised or misconfigured bucket only ever exposes ciphertext, never
live PII/court data.

Every run also decrypts the archive back to `/dev/null` as a cheap integrity
check (proves the passphrase/cipher round-trip works), but that is not the
same as proving `pg_restore` can rebuild a working database from it — that's
what the restore drill below is for.

## One-time setup

1. **Create the passphrase file** (root-only readable):
   ```
   sudo mkdir -p /etc/gates-pd-backup
   sudo bash -c 'umask 077; head -c 48 /dev/urandom | base64 > /etc/gates-pd-backup/passphrase'
   sudo chmod 600 /etc/gates-pd-backup/passphrase
   sudo chown postgres:postgres /etc/gates-pd-backup/passphrase
   ```
   Losing this passphrase means every backup is permanently unrecoverable, so
   also escrow a copy somewhere durable and *off this server* — a password
   manager or a sealed physical copy. Never put it in this script, in cron,
   or in shell history.

2. **Configure the off-site remote.** These scripts use `rclone` so the same
   pipeline works against AWS S3, Backblaze B2, Wasabi, MinIO, or any other
   S3-compatible provider. Run once, interactively, as the same user that
   will run the backup job (typically `postgres`):
   ```
   sudo -u postgres rclone config
   ```
   Create a remote named `offsite`. Its credentials live in rclone's own
   config file (`~postgres/.config/rclone/rclone.conf`), never in this
   script. Then create the bucket/path once:
   ```
   sudo -u postgres rclone mkdir offsite:gates-pd-backups
   ```

3. **Give the backup user `pg_dump` access.** If running as the `postgres`
   system user, this is already true via local peer auth. If running as a
   different account, grant it read access to the database (a role with the
   built-in `pg_read_all_data` role is sufficient, and safer than a
   superuser).

4. **Schedule the nightly job** (as root, or whichever user owns the config
   dir — the script itself should run as `postgres`):
   ```
   sudo crontab -u postgres -e
   ```
   and add:
   ```
   0 3 * * * /opt/gates-pd-api/deploy/backup/backup_database.sh >> /var/log/gates-pd-backup.log 2>&1
   ```
   (A systemd timer works equally well if you prefer that over cron — the
   script itself doesn't care how it's invoked.)

5. **Confirm the first run manually** before trusting the cron entry:
   ```
   sudo -u postgres /opt/gates-pd-api/deploy/backup/backup_database.sh
   ```
   Check `/var/backups/gates-pd/` for the new `.dump.gpg` file and confirm it
   also landed in the off-site bucket (`rclone ls offsite:gates-pd-backups`).

### Configuration reference

All of the following are optional environment-variable overrides read by
`backup_database.sh` (defaults shown):

| Variable | Default | Purpose |
|---|---|---|
| `BACKUP_DB_NAME` | `gates_pd_dev` | Database to dump |
| `BACKUP_DB_HOST` | `127.0.0.1` | Postgres host (use a Unix socket dir, e.g. `/var/run/postgresql`, for peer auth) |
| `BACKUP_DB_PORT` | `5432` | Postgres port |
| `BACKUP_DB_USER` | `postgres` | Postgres role to dump as |
| `BACKUP_CONFIG_DIR` | `/etc/gates-pd-backup` | Base config directory |
| `BACKUP_PASSPHRASE_FILE` | `$BACKUP_CONFIG_DIR/passphrase` | GPG symmetric passphrase |
| `BACKUP_LOCAL_DIR` | `/var/backups/gates-pd` | Local staging/retention directory |
| `BACKUP_RCLONE_REMOTE` | `offsite:gates-pd-backups` | rclone remote:path for the off-site vault |
| `BACKUP_RETENTION_DAYS` | `14` | How long encrypted dumps are kept **locally** (the off-site copy is the durable one and isn't pruned by this script) |

## Restoring a backup

```
deploy/backup/restore_database.sh <path-to-.dump.gpg> <target-db-name>
```

To restore the latest off-site backup onto a scratch host:

```
sudo -u postgres rclone copy offsite:gates-pd-backups/<file>.dump.gpg /tmp/
sudo -u postgres deploy/backup/restore_database.sh /tmp/<file>.dump.gpg gates_pd_restore_test
```

The script always creates a **new** database and refuses to restore over an
existing one, so it can never silently clobber a live database. It prints a
row-count spot-check query at the end — run it, and compare the counts
against the source database, before considering any restore trustworthy.

## Recommended periodic restore drill

An untested backup is not a verified backup — the nightly job's built-in
integrity check only proves the ciphertext decrypts, not that `pg_restore`
can rebuild a working database from it. At minimum monthly, on a
non-production host:

1. Pull the most recent off-site archive.
2. Run `restore_database.sh` against a scratch database name.
3. Run the printed spot-check query and compare row counts, table-by-table,
   against the live database.
4. Drop the scratch database (`dropdb gates_pd_restore_test`) once confirmed.

This was exercised during development: a full backup → encrypt → upload →
download → decrypt → restore cycle was run end-to-end, and the resulting
row counts matched the source database exactly across every table.

## Security notes

- The off-site bucket only ever holds GPG ciphertext — treat the passphrase
  file, not the bucket's access policy, as the actual secret boundary.
- `backup_database.sh` shreds the plaintext `pg_dump` output immediately
  after encryption; `restore_database.sh` shreds its decrypted temp file on
  exit (including on failure, via a `trap`).
- Rotate the passphrase by re-encrypting existing archives (or accepting
  that older archives need the old passphrase kept in escrow) — there is no
  automatic re-key mechanism here.
