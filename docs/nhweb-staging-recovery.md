# NHWeb Services Backups: guided staging recovery

This fork retains Backrest and restic. It changes the branding and adds an authenticated, operator-allowlisted database recovery page. Restic's encryption format, repository credentials, existing snapshots, backup plans and retention are unchanged. This first version supports DZDistro staging only.

## Operator workflow

1. **Select a snapshot** from before the incident and test the restore. The worker independently checks the pinned restic repository ID, staging tag and exact dump path. It decrypts through restic on the staging host, imports into a new isolated PostgreSQL database, checks table/constraint/schema and migration compatibility, reports row counts and the dump checksum, and removes the plaintext archive. The candidate is sealed against connections after validation.
2. **Pause staging.** Type `PAUSE DZDISTRO STAGING`. Recovery takes the existing shared staging deployment lock, activates an independent maintenance responder for the staging hostname, verifies HTML/JSON/HEAD and `/health`/`/ready` maintenance behavior, and pauses the five exact application containers. Image, container and configuration drift refuses advancement.
3. **Restore staging.** Type the snapshot-bound confirmation shown in the page. The worker rechecks the owned lock, fence, paused writers and database OIDs. It blocks connections to the old database and uses a transaction to rename both databases. The current database is retained as `dzdistro_before_<job>`; it is never dropped by recovery.
4. **Reconcile queued work and cached data** using the existing staging operational tools while maintenance remains active. This workflow intentionally does not flush Redis or discard queued work automatically. The acknowledgement is required by the UI, backend and worker and recorded under the authenticated operator.
5. **Resume staging.** Type the job-bound resume confirmation. The same web container is unpaused first and its direct `/health` and `/ready` endpoints must pass before background roles resume. There is no container restart, release replay or migration execution. After all roles verify, recovery removes only its owned fence and releases only its own shared lock.
6. **Rollback if needed.** Prepare rollback pauses staging again. A separate job-bound confirmation swaps the retained pre-recovery database back. The database containing post-restore changes is retained as `dzdistro_after_<job>`. Reconcile queued work/cache and resume again.

Prepare alone never replaces staging. Discard is limited to the isolated database owned by that job. Snapshot deletion and retention remain Backrest/restic operations, separate from database recovery.

## Deployment boundary

Installing a recovery key/worker grants a new, staging-scoped database control capability. Build/test/source review does not deploy it, authorize a real database restore, or authorize production. Install only after approval of the concrete configuration and image. Keep the running panel and existing timers until the fork's acceptance succeeds.

The panel receives a private `BACKREST_DATABASE_RESTORE_CONFIG` file using `examples/nhweb/backrest-recovery.example.json`. Pin the existing Backrest repository GUID and explicitly allow trusted operator account names. All Backrest accounts are already trusted administrators with powerful configuration/hooks; this allowlist is an additional recovery gate, not a sandbox against another fully trusted Backrest administrator.

The panel's separate recovery SSH key must be restricted on the staging VPS to this forced command:

```text
restrict,command="/usr/bin/python3 /usr/local/libexec/nhweb-backups/staging_recovery.py" ssh-ed25519 REPLACE_WITH_DEDICATED_RECOVERY_PUBLIC_KEY
```

The worker refuses other SSH commands and accepts bounded JSON for named recovery actions only. It cannot receive arbitrary SQL, uploaded dumps, container arguments, hostnames or a production target from the browser. SSH uses strict host verification, explicit identities and no agent/port forwarding. The panel needs neither the staging Docker socket nor an unrestricted staging shell.

Install the worker and private configuration on the staging host:

- `/usr/local/libexec/nhweb-backups/staging_recovery.py`: root-owned, readable/executable by the maintenance service, not writable by it.
- `/etc/nhweb-backups/staging-recovery.json`: root-owned0600; populate `examples/nhweb/staging-worker.example.json` from verified staging identities. Placeholders deliberately fail validation.
- `/var/lib/nhweb-backups/staging-recovery`: root-owned0700; journals/audit/private archives belong here.
- Existing restic0.19.1, private staging password and pinned Storage Box SSH configuration are reused. Python3.11+ and Docker CLI are required.
- Install the independent fence systemd unit from `examples/nhweb/nhws-staging-recovery-fence.service`. Its unprivileged responder reads only `/run/nhws-staging-recovery/fence.json`, containing a nonsecret job reference. Allow port8790 only from the local proxy network. Confirm the proxy resolves `host.docker.internal` (or pin its verified private bridge gateway) and watches `/data/coolify/proxy/dynamic` before enabling recovery.

The worker writes one owned Traefik configuration file, scoped only to `test.dzdistro.com`. It does not restart the shared proxy, change other routers, alter TLS validation or touch production. The public fence must verify both before and after pausing web; missing reachability holds before a database switch.

## Failure and restart behavior

Intent, immutable container/image/config/worker identity, database OIDs and phase are persisted atomically. Audit records are appended before dangerous effects. A lost switch response, interrupted worker, partial pause/resume or ambiguous SQL outcome holds recovery. Refresh status; never repeat an uncertain switch. The owned staging lock and maintenance fence have no TTL, automatic theft or force bypass. An administrator must reconcile an uncertain journal against the exact container, database OIDs, writer state and fence ownership; there is no generic unlock button.

On a failed resume the worker attempts to re-pause only the unchanged, verified containers. If a container drifted or Docker is unavailable, an administrator must inspect writer state immediately; a held journal alone cannot prove every writer is paused.

A known competing deployment lock refuses before fencing or pausing and leaves the test restore validated. Finish that deployment before trying pause again. Updating worker code/configuration during an open recovery refuses further mutation; finish recovery before upgrading it.

## Verification

Frontend uses the upstream locked dependencies; no application dependency was added. With pnpm12, allow only the two existing build dependencies when installing: `pnpm install --frozen-lockfile --allow-build=esbuild --allow-build=@parcel/watcher`. Node24 is used for the upstream jsdom test harness; Node26's native Web Storage currently conflicts with that harness. No global Node version switch is needed.

Focused checks:

```text
go test ./internal/api -run '^TestDatabaseRecovery'
pnpm run check
pnpm exec vitest run src/features/recovery/DatabaseRestore.test.tsx
pnpm run build
docker build -f test/fixtures/nhws-recovery/Dockerfile -t nhws-recovery-fixture:local .
docker run --rm --network none -v "$PWD/scripts:/tests:ro" --entrypoint python3 nhws-recovery-fixture:local /tests/test_nhws_staging_recovery.py
```

`scripts/test_nhws_recovery_postgres.py` rehearses native restic encryption/decryption, a real PostgreSQL17 import, checksum, active-database switch and retained-database rollback against a uniquely named, explicitly labelled local fixture. Its fence/writer adapter is simulated; it is not browser or live staging acceptance. A Docker socket mount is permitted only for the disposable local fixture, never for the deployed Backrest panel.

The `test-database-recovery` CI job runs worker refusal/failure tests and this PostgreSQL rehearsal. Full browser acceptance additionally needs the authenticated panel, restricted SSH worker, five actual paused containers and TLS maintenance routing; those are not simulated by the PostgreSQL core test.

## Initial limits

- Database-only recovery: uploads, application secrets, cluster roles/ACLs and PITR are outside this backup.
- The current staging schema must remain readable and compatible. Missing/corrupt schema or a migration mismatch requires an explicitly assessed manual recovery; there is no force option.
- Decrypted archives are bounded to256MiB. Normal completion/failure deletes them; a process/host crash can leave a private archive requiring operator cleanup.
- Retained databases and test-restores consume PostgreSQL disk space. This workflow never automatically deletes pre-recovery or post-restore history.
- Queue/cache reconciliation is an operator step; it is not inferred from database row counts or a checkbox alone.
- Source/fixture proof does not establish installed bytes, proxy reachability, live application acceptance or authority for a real staging cutover.
