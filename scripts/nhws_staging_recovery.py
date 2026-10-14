#!/usr/bin/env python3
"""Restricted staging recovery worker. Restic remains the encryption engine."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import select
import secrets
import socket
import subprocess
import sys
import time
import urllib.request
import urllib.error

CONFIG_PATH = Path('/etc/nhweb-backups/staging-recovery.json')
ROLLOUT_LOCK = Path('/data/coolify/dzdistro-staging-rollout.lock')
FENCE_STATE = Path('/run/nhws-staging-recovery/fence.json')
JOB_ID = re.compile(r'^[0-9a-f]{32}$')
SNAPSHOT_ID = re.compile(r'^[0-9a-f]{64}$')
MAX_DUMP = 256 * 1024 * 1024
TARGET = 'dzdistro-staging'
DATABASE = 'dzdistro_staging'


class Refusal(Exception):
    pass


class LockBusy(Refusal):
    pass


def require(condition, message):
    if not condition:
        raise Refusal(message)


def no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'Duplicate JSON property.')
        result[key] = value
    return result


def read_json(path):
    return json.loads(path.read_text(), object_pairs_hook=no_duplicates)


def save_json(path, value, mode=0o600):
    temporary = path.with_suffix('.pending')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, mode)
    with os.fdopen(descriptor, 'w') as stream:
        json.dump(value, stream, separators=(',', ':'))
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def identifier(value):
    require(isinstance(value, str) and re.fullmatch(r'[a-z][a-z0-9_]{0,62}', value), 'Invalid database identity.')
    return '"' + value + '"'


def process_identity(pid):
    try:
        fields = Path('/proc/' + str(pid) + '/stat').read_text().rsplit(')', 1)[1].split()
        if fields[0] == 'Z':
            return None
        start = fields[19]
        return {'pid': pid, 'start': start, 'boot': Path('/proc/sys/kernel/random/boot_id').read_text().strip()}
    except OSError:
        return None


def worker_hash():
    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def ssh_sessions():
    result = []
    pid = os.getpid()
    if not os.environ.get('SSH_CONNECTION'):
        return result
    while pid > 1:
        stat = Path('/proc/' + str(pid) + '/stat').read_text()
        name, tail = stat.rsplit(')', 1)
        if name.split('(', 1)[1].startswith('sshd'):
            identity = process_identity(pid)
            require(identity is not None, 'SSH session ended before resume.')
            result.append(identity)
        pid = int(tail.split()[1])
    require(result, 'Cannot verify the SSH recovery session.')
    return result


def sessions_alive(job):
    return all(process_identity(item['pid']) == item for item in job.get('sessions', []))


def load_config(path):
    require(path.is_file() and not path.is_symlink(), 'Worker configuration is unavailable.')
    require(path.stat().st_mode & 0o077 == 0, 'Worker configuration must be private.')
    value = read_json(path)
    keys = {'schemaVersion', 'environment', 'container', 'writers', 'repository', 'repositoryId',
            'passwordFile', 'sshConfig', 'stateDir', 'publicURL', 'fenceBackend', 'proxyConfig'}
    require(isinstance(value, dict) and set(value) == keys, 'Unknown worker configuration.')
    require(type(value['schemaVersion']) is int and value['schemaVersion'] == 1 and value['environment'] == 'staging', 'Only staging recovery is supported.')
    require(isinstance(value['container'], str) and recovery_name(value['container']), 'Invalid staging container.')
    require(SNAPSHOT_ID.fullmatch(value['repositoryId'] or '') is not None, 'Pin the restic repository ID.')
    require(isinstance(value['writers'], dict) and set(value['writers']) == {'web', 'queue', 'scheduler', 'pulse', 'release'}, 'Pin all five staging application roles.')
    require(len(set(value['writers'].values())) == 5 and all(recovery_name(v) for v in value['writers'].values()), 'Invalid application identities.')
    require(value['publicURL'] == 'https://test.dzdistro.com', 'Only the staging public endpoint is supported.')
    require(value['proxyConfig'] == '/data/coolify/proxy/dynamic/nhws-staging-recovery.yml', 'Only the owned staging fence configuration may be changed.')
    require(re.fullmatch(r'http://(?:host\.docker\.internal|172\.(?:1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3}):8790', value['fenceBackend']) is not None, 'Invalid private maintenance responder.')
    for key in ['passwordFile', 'sshConfig', 'stateDir']:
        require(isinstance(value[key], str) and Path(value[key]).is_absolute(), 'Worker paths must be absolute.')
    for key in ['passwordFile', 'sshConfig']:
        file = Path(value[key])
        require(file.is_file() and not file.is_symlink() and file.stat().st_mode & 0o077 == 0, 'Recovery credentials must be private regular files.')
    return value


def recovery_name(value):
    return isinstance(value, str) and re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}', value) is not None


class System:
    def __init__(self, config):
        self.config = config
        self.target_id = self.target()['Id']

    def run(self, args, *, data=None, output=None, timeout=120):
        result = subprocess.run(args, input=data, stdout=output or subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        if result.returncode:
            directory = Path(self.config['stateDir'])
            if directory.is_dir() and not directory.is_symlink() and directory.stat().st_mode & 0o077 == 0:
                with (directory / 'worker-errors.log').open('ab') as log:
                    os.chmod(log.name, 0o600)
                    log.write(result.stderr[-65536:] + b'\n')
        require(result.returncode == 0, 'Server operation failed; refresh recovery status and inspect the restricted worker logs.')
        return result.stdout

    def target(self):
        result = json.loads(self.run(['docker', 'inspect', self.config['container']]))[0]
        labels = result['Config']['Labels'] or {}
        require(all(labels.get(k) == v for k, v in {'coolify.projectName': 'dzdistro', 'coolify.environmentName': 'staging', 'coolify.resourceName': 'dzdistro-staging-postgres', 'coolify.type': 'database'}.items()), 'Database container is outside staging.')
        require(result['State']['Running'] and not result['State'].get('Paused'), 'Staging PostgreSQL is not running normally.')
        return result

    def sql(self, query, database='postgres', role=DATABASE):
        require(self.target()['Id'] == self.target_id, 'Database container changed during recovery.')
        return self.run(['docker', 'exec', '-i', '-e', 'PGOPTIONS=-c search_path=pg_catalog', self.target_id, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', role, '-d', database, '-At', '-c', query]).decode().strip()

    def oid(self, database):
        identifier(database)
        value = self.sql("SELECT oid FROM pg_database WHERE datname='" + database + "'")
        return int(value) if value else None

    def validate(self, database, role=None):
        if role:
            self.sql('ALTER ROLE ' + identifier(role) + ' LOGIN')
        try:
            return self.validate_contents(database, role or DATABASE)
        finally:
            if role:
                self.sql('ALTER ROLE ' + identifier(role) + ' NOLOGIN')

    def validate_contents(self, database, role):
        def sql(query):
            return self.sql(query, database, role)
        tables = sql("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public' ORDER BY tablename").splitlines()
        require({'migrations', 'users', 'businesses', 'documents'}.issubset(tables), 'Required DZDistro tables are missing.')
        require(sql("SELECT count(*) FROM pg_catalog.pg_constraint WHERE connamespace='public'::regnamespace AND NOT convalidated") == '0', 'Database constraints are not validated.')
        schema = sql("SELECT table_name||':'||column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,'') FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position")
        schema += '\n' + sql("SELECT conrelid::regclass::text||':'||contype::text||':'||pg_get_constraintdef(oid) FROM pg_catalog.pg_constraint WHERE connamespace='public'::regnamespace ORDER BY conrelid::regclass::text,conname")
        schema += '\n' + sql("SELECT migration FROM public.migrations ORDER BY migration")
        schema += '\n' + sql("SELECT indexdef FROM pg_catalog.pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname")
        counts = {table: int(sql('SELECT count(*) FROM public.' + '"' + table.replace('"', '""') + '"')) for table in tables}
        return {'schemaHash': hashlib.sha256(schema.encode()).hexdigest(), 'tables': len(tables), 'rows': sum(counts.values()), 'tableRows': counts}

    def restic(self, args, *, output=None):
        env = os.environ.copy()
        env.pop('RESTIC_PASSWORD', None)
        env['RESTIC_PASSWORD_FILE'] = self.config['passwordFile']
        env['RESTIC_CACHE_DIR'] = str(Path(self.config['stateDir']) / 'cache')
        command = ['/usr/local/bin/restic', '-r', self.config['repository'], '--retry-lock', '10m']
        if self.config['repository'].startswith('sftp:'):
            command += ['-o', 'sftp.command=ssh -F ' + self.config['sshConfig'] + ' -s dzdistro-staging-storage sftp']
        def bound_file():
            import resource
            resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_DUMP, MAX_DUMP))
        result = subprocess.run(command + args, env=env, stdout=output or subprocess.PIPE, stderr=subprocess.PIPE, timeout=1200, preexec_fn=bound_file if output else None)
        require(result.returncode == 0, 'Encrypted snapshot could not be read; no database switch was made.')
        return result.stdout

    def prepare(self, job, dump_path, persist):
        repository = json.loads(self.restic(['cat', 'config']))
        require(repository['id'] == self.config['repositoryId'], 'Restic repository identity changed.')
        snapshots = json.loads(self.restic(['snapshots', '--json', job['snapshotId']]))
        require(len(snapshots) == 1 and snapshots[0]['id'] == job['snapshotId'] and 'staging-postgres' in snapshots[0].get('tags', []), 'Snapshot does not belong to the staging backup stream.')
        require(snapshots[0]['paths'] in [['dzdistro_staging.dump'], ['/dzdistro_staging.dump']], 'Snapshot has unexpected contents.')
        job['snapshotTime'] = snapshots[0]['time']
        with dump_path.open('xb') as dump:
            os.chmod(dump_path, 0o600)
            self.restic(['dump', job['snapshotId'], '/dzdistro_staging.dump'], output=dump)
        require(0 < dump_path.stat().st_size <= MAX_DUMP, 'Dump exceeds the staging recovery size limit.')
        with dump_path.open('rb') as dump:
            require(dump.read(5) == b'PGDMP', 'Snapshot is not a PostgreSQL custom archive.')
        with dump_path.open('rb') as dump:
            job['dumpSha256'] = hashlib.file_digest(dump, 'sha256').hexdigest()
        job['dumpBytes'] = dump_path.stat().st_size
        require(self.oid(job['candidateDatabase']) is None, 'Candidate database already exists.')
        role = 'dzdistro_recovery_' + job['id']
        require(self.sql("SELECT rolsuper FROM pg_roles WHERE rolname='" + DATABASE + "'") == 't', 'The pinned staging application role must retain access to recovered objects.')
        require(self.sql("SELECT count(*) FROM pg_roles WHERE rolname='" + role + "'") == '0', 'Recovery role already exists.')
        self.sql('CREATE ROLE ' + identifier(role) + ' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD NULL')
        job['candidateRole'] = role
        persist(job)
        self.sql('CREATE DATABASE ' + identifier(job['candidateDatabase']) + ' TEMPLATE template0 OWNER ' + identifier(role))
        job['candidateOID'] = self.oid(job['candidateDatabase'])
        persist(job)
        with dump_path.open('rb') as dump:
            result = subprocess.run(['docker', 'exec', '-i', self.target_id, 'pg_restore', '--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', '-U', role, '-d', job['candidateDatabase']], stdin=dump, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=1200)
        require(result.returncode == 0, 'Isolated PostgreSQL restore failed. Current staging was not replaced.')
        self.sql('ALTER ROLE ' + identifier(role) + ' NOLOGIN')
        job['validation'] = self.validate(job['candidateDatabase'], role)
        current = self.validate(DATABASE)
        require(current['schemaHash'] == job['validation']['schemaHash'], 'Snapshot schema is incompatible with the current staging application.')
        self.sql('ALTER DATABASE ' + identifier(job['candidateDatabase']) + ' ALLOW_CONNECTIONS false')

    def writers(self):
        ids = self.run(['docker', 'ps', '-q', '--filter', 'label=coolify.projectName=dzdistro', '--filter', 'label=coolify.environmentName=staging', '--filter', 'label=coolify.type=application']).decode().split()
        require(ids, 'Staging application roles are missing.')
        containers = json.loads(self.run(['docker', 'inspect', *ids]))
        result = []
        for item in containers:
            labels = item['Config']['Labels'] or {}
            app_id = labels.get('coolify.applicationUuid')
            role = next((r for r, value in self.config['writers'].items() if value == app_id), None)
            require(role is not None and labels.get('coolify.resourceName') == 'dzdistro-staging-image-' + role and labels.get('coolify.pullRequestId') == '0', 'Unknown or preview staging writer detected.')
            require(item['State']['Running'], 'All pinned application roles must be running before recovery.')
            result.append({'id': item['Id'], 'role': role, 'image': item['Image'], 'paused': item['State']['Paused'],
                           'configHash': hashlib.sha256(json.dumps(item['Config'].get('Env', []), sort_keys=True).encode()).hexdigest()})
        require(len(result) == 5 and {item['role'] for item in result} == set(self.config['writers']), 'Staging deployment is incomplete or overlapping.')
        require(len({item['image'] for item in result}) == 1, 'Application roles are on different releases.')
        return sorted(result, key=lambda item: item['role'])

    def verify_writers(self, job, paused):
        actual = self.writers()
        expected = {item['id']: item for item in job['writers']}
        require({item['id'] for item in actual} == set(expected), 'Staging writer identity drifted.')
        require(all(item['image'] == expected[item['id']]['image'] and item['configHash'] == expected[item['id']]['configHash'] and item['paused'] == paused for item in actual), 'Staging writer state, image or configuration drifted.')

    def fence(self, job, enable):
        path = Path(self.config['proxyConfig'])
        if enable:
            require(not path.exists(), 'Another maintenance fence is active.')
            FENCE_STATE.parent.mkdir(parents=True, exist_ok=True)
            save_json(FENCE_STATE, {'jobId': job['id']}, 0o644)
            route = {'http': {'routers': {
                'nhws-staging-http': {'rule': 'Host(`test.dzdistro.com`)', 'entryPoints': ['http'], 'priority': 1000000, 'service': 'nhws-staging-fence'},
                'nhws-staging-https': {'rule': 'Host(`test.dzdistro.com`)', 'entryPoints': ['https'], 'priority': 1000000, 'service': 'nhws-staging-fence', 'tls': {}}},
                'services': {'nhws-staging-fence': {'loadBalancer': {'servers': [{'url': self.config['fenceBackend']}]}}}}}
            save_json(path, route, 0o644)
            job['fenceHash'] = hashlib.sha256(path.read_bytes()).hexdigest()
        else:
            require(path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == job['fenceHash'] and read_json(FENCE_STATE)['jobId'] == job['id'], 'Maintenance fence ownership changed.')
            path.unlink()
            FENCE_STATE.unlink()

    def probe_fence(self, job):
        deadline = time.monotonic() + 45
        checks = [('/', 'GET', 'text/html'), ('/', 'GET', 'application/json'), ('/', 'HEAD', 'text/html'), ('/health', 'GET', 'application/json'), ('/ready', 'GET', 'application/json')]
        for path, method, accept in checks:
            while True:
                request = urllib.request.Request(self.config['publicURL'] + path, method=method, headers={'Accept': accept})
                try:
                    urllib.request.urlopen(request, timeout=5)
                    valid = False
                except urllib.error.HTTPError as response:
                    valid = response.code == 503 and response.headers.get('X-NHWS-Recovery-Job') == job['id'] and response.headers.get('Cache-Control') == 'no-store' and response.headers.get('Retry-After') == '120'
                    response.close()
                except OSError:
                    valid = False
                if valid:
                    break
                require(time.monotonic() < deadline, 'Independent staging maintenance fence did not verify.')
                time.sleep(1)

    def pause(self, container, paused):
        if paused:
            self.run(['docker', 'pause', container])
            return
        require(hasattr(self, 'guard_socket'), 'Unpause requires the independent executor.')
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(130)
            connection.connect(str(self.guard_socket))
            connection.sendall(json.dumps({'container': container}).encode() + b'\n')
            response = connection.recv(1024)
            require(response == b'completed\n', 'Independent executor did not verify unpause completion; inspect recovery status.')

    def hold_writers(self, job):
        failures = []
        for saved in job['writers']:
            try:
                item = json.loads(self.run(['docker', 'inspect', saved['id']]))[0]
                labels = item['Config']['Labels'] or {}
                require(item['Id'] == saved['id'] and item['Image'] == saved['image'] and item['State']['Running'], 'Cannot re-pause a changed staging writer.')
                require(all(labels.get(k) == v for k, v in {'coolify.projectName': 'dzdistro', 'coolify.environmentName': 'staging', 'coolify.type': 'application', 'coolify.applicationUuid': self.config['writers'][saved['role']], 'coolify.resourceName': 'dzdistro-staging-image-' + saved['role'], 'coolify.pullRequestId': '0'}.items()), 'Cannot re-pause an unverified writer.')
                require(hashlib.sha256(json.dumps(item['Config'].get('Env', []), sort_keys=True).encode()).hexdigest() == saved['configHash'], 'Cannot re-pause changed writer configuration.')
                if not item['State']['Paused']:
                    self.pause(item['Id'], True)
            except Exception:
                failures.append(saved['role'])
        require(not failures, 'Writer containment could not verify every recorded role; inspect staging immediately.')

    def start_guard(self, job):
        reader, writer = os.pipe()
        try:
            process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--guard-resume', job['id'], '--ready-fd', str(writer)],
                                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       pass_fds=(writer,), start_new_session=True)
            os.close(writer)
            writer = None
            require(select.select([reader], [], [], 15)[0] and os.read(reader, 16) == b'ready\n', 'Independent resume guard did not start.')
            identity = process_identity(process.pid)
            require(identity is not None, 'Independent resume guard exited.')
            self.guard_socket = Path(self.config['stateDir']) / (job['id'] + '.guard.sock')
            return identity
        finally:
            os.close(reader)
            if writer is not None:
                os.close(writer)

    def check_guard(self, job):
        require(sessions_alive(job) and process_identity(job['guard']['pid']) == job['guard'], 'Independent resume guard or SSH session is unavailable.')

    def probe_web(self, job):
        web = next(item for item in job['writers'] if item['role'] == 'web')
        for path in ['/health', '/ready']:
            self.run(['docker', 'exec', web['id'], 'curl', '-fsS', '--max-time', '10', '-o', '/dev/null', 'http://127.0.0.1:8000' + path])

    def switch(self, job, rollback):
        source = job['retainedDatabase'] if rollback else job['candidateDatabase']
        retained = job['afterDatabase'] if rollback else job['retainedDatabase']
        expected_active = job['candidateOID'] if rollback else job['originalOID']
        expected_source = job['originalOID'] if rollback else job['candidateOID']
        require(self.oid(DATABASE) == expected_active and self.oid(source) == expected_source and self.oid(retained) is None, 'Database OID or rollback identity drifted.')
        self.sql('ALTER DATABASE ' + identifier(DATABASE) + ' ALLOW_CONNECTIONS false')
        self.sql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='" + DATABASE + "' AND pid<>pg_backend_pid()")
        self.sql('BEGIN; ALTER DATABASE ' + identifier(DATABASE) + ' RENAME TO ' + identifier(retained) + '; ALTER DATABASE ' + identifier(source) + ' RENAME TO ' + identifier(DATABASE) + '; ALTER DATABASE ' + identifier(DATABASE) + ' ALLOW_CONNECTIONS true; COMMIT;')
        require(self.oid(DATABASE) == expected_source and self.oid(retained) == expected_active, 'Database switch outcome is uncertain; staging remains held.')


class Workflow:
    def __init__(self, config, system):
        self.config, self.system = config, system
        self.directory = Path(config['stateDir'])
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        require(not self.directory.is_symlink() and self.directory.stat().st_mode & 0o077 == 0, 'Recovery state directory must be private.')

    def path(self, job_id):
        require(JOB_ID.fullmatch(job_id or '') is not None, 'Invalid recovery job.')
        return self.directory / (job_id + '.json')

    @contextmanager
    def transition(self, job):
        with self.path(job['id']).with_suffix('.transition.lock').open('a') as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            yield

    def released_path(self, job):
        require(re.fullmatch(r'[0-9]{10,}-[0-9a-f]{32}', job['lockOwner']) is not None, 'Invalid release identity.')
        return ROLLOUT_LOCK.with_name(ROLLOUT_LOCK.name + '.released-' + job['lockOwner'])

    def released(self, job):
        path = self.released_path(job)
        if not path.exists():
            return False
        require(not path.is_symlink() and read_json(path / 'owner.json') == {'schema_version': 1, 'environment': 'staging', 'rollout_id': job['lockOwner']}, 'Release receipt belongs to another operation.')
        return True

    def persist(self, job):
        if job['phase'] in {'preparing', 'freezing', 'switching', 'resuming'}:
            job['process'] = process_identity(os.getpid())
        save_json(self.path(job['id']), job)

    def audit(self, request, phase):
        with (self.directory / 'audit.jsonl').open('a') as stream:
            os.chmod(stream.name, 0o600)
            stream.write(json.dumps({'time': time.time(), 'actor': request['actor'], 'action': request['action'], 'jobId': request.get('jobId'), 'phase': phase}) + '\n')
            stream.flush()
            os.fsync(stream.fileno())

    def owned_lock(self, job):
        owner = read_json(ROLLOUT_LOCK / 'owner.json')
        require(owner == {'schema_version': 1, 'environment': 'staging', 'rollout_id': job['lockOwner']}, 'Shared staging rollout lock is owned by another operation.')

    def acquire(self, job):
        try:
            ROLLOUT_LOCK.mkdir(mode=0o750)
        except FileExistsError:
            raise LockBusy('A staging deployment or recovery already holds the shared rollout lock.') from None
        save_json(ROLLOUT_LOCK / 'owner.json', {'schema_version': 1, 'environment': 'staging', 'rollout_id': job['lockOwner']}, 0o640)

    def release(self, job):
        if self.released(job):
            return
        self.owned_lock(job)
        os.rename(ROLLOUT_LOCK, self.released_path(job))
        descriptor = os.open(ROLLOUT_LOCK.parent, os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def check_target(self, job):
        require(self.system.target()['Id'] == job['containerId'], 'The PostgreSQL container changed; recovery refuses to advance.')

    def handle(self, request):
        require(isinstance(request, dict) and set(request).issubset({'action', 'jobId', 'snapshotId', 'confirmation', 'environment', 'actor', 'queuesReconciled'}), 'Unknown recovery request.')
        require(request.get('environment') == 'staging' and isinstance(request.get('actor'), str) and 0 < len(request['actor']) <= 128, 'Authenticated staging operator required.')
        action = request.get('action')
        require(action in {'status', 'prepare', 'freeze', 'restore', 'resume', 'freeze-rollback', 'rollback', 'abort'}, 'Unsupported recovery action.')
        if action == 'status':
            job_id = request.get('jobId')
            path = self.path(job_id) if job_id else max(self.directory.glob('[0-9a-f]' * 32 + '.json'), key=lambda p: p.stat().st_mtime, default=None)
            job = read_json(path) if path and path.exists() else None
            if job and job['phase'] in {'preparing', 'freezing', 'switching', 'resuming'}:
                identity = job.get('process')
                if not identity or process_identity(identity['pid']) != identity:
                    guard = job.get('guard')
                    job['phase'] = 'containing' if job['phase'] == 'resuming' and guard and process_identity(guard['pid']) == guard else 'held'
                    job['interrupted'] = True
            return job
        job_id = request.get('jobId')
        path = self.path(job_id)
        require(not path.is_symlink(), 'Recovery journal is not a regular file.')
        if action == 'prepare':
            require(not path.exists() and SNAPSHOT_ID.fullmatch(request.get('snapshotId', '')) is not None, 'Select a new staging snapshot job.')
            for other in self.directory.glob('[0-9a-f]' * 32 + '.json'):
                require(read_json(other)['phase'] in {'resumed', 'aborted', 'failed'}, 'Finish the existing recovery job first.')
            job = {'id': job_id, 'snapshotId': request['snapshotId'], 'phase': 'preparing', 'actor': request['actor'],
                   'candidateDatabase': 'dzdistro_restore_' + job_id, 'retainedDatabase': 'dzdistro_before_' + job_id,
                   'afterDatabase': 'dzdistro_after_' + job_id, 'originalOID': self.system.oid(DATABASE),
                   'containerId': self.system.target()['Id'], 'lockOwner': str(int(time.time())) + '-' + job_id,
                   'configHash': hashlib.sha256(json.dumps(self.config, sort_keys=True).encode()).hexdigest(), 'workerHash': worker_hash()}
            require(job['originalOID'] is not None, 'Current staging database is missing.')
            job['validationWriters'] = self.system.writers()
            self.audit(request, 'intent')
            self.persist(job)
            dump = self.directory / (job_id + '.dump')
            try:
                self.system.prepare(job, dump, self.persist)
                job['phase'] = 'validated'
                self.persist(job)
                self.audit(request, 'validated')
                return job
            except Exception:
                job['phase'] = 'failed'
                if job.get('candidateOID') and self.system.oid(job['candidateDatabase']) == job['candidateOID']:
                    self.system.sql('DROP DATABASE ' + identifier(job['candidateDatabase']) + ' WITH (FORCE)')
                    job['candidateOID'] = None
                if job.get('candidateRole'):
                    self.system.sql('DROP ROLE ' + identifier(job['candidateRole']))
                    job['candidateRole'] = None
                self.persist(job)
                raise
            finally:
                if dump.exists():
                    dump.unlink()
        require(path.is_file(), 'Recovery job does not exist.')
        job = read_json(path)
        require(job['id'] == job_id, 'Recovery journal identity mismatch.')
        require(job.get('workerHash') == worker_hash(), 'Worker implementation changed after validation; finish or inspect the existing recovery before upgrading.')
        require(job['configHash'] == hashlib.sha256(json.dumps(self.config, sort_keys=True).encode()).hexdigest(), 'Worker configuration changed after validation.')
        self.check_target(job)
        phrase = {'freeze': 'PAUSE DZDISTRO STAGING', 'freeze-rollback': 'PAUSE DZDISTRO STAGING',
                  'restore': 'RESTORE DZDISTRO STAGING ' + job['snapshotId'][:8],
                  'rollback': 'ROLLBACK DZDISTRO STAGING ' + job_id[:8],
                  'resume': 'RESUME DZDISTRO STAGING ' + job_id[:8], 'abort': 'DISCARD TEST RESTORE ' + job_id[:8]}[action]
        require(request.get('confirmation') == phrase, 'Typed confirmation does not match this staging operation.')
        if action in {'freeze', 'freeze-rollback'}:
            expected_phase = 'validated' if action == 'freeze' else 'resumed'
            require(job['phase'] == expected_phase and not (action == 'freeze-rollback' and job.get('rolledBack')), 'Job is not eligible for this pause.')
            expected_oid = job['originalOID'] if action == 'freeze' else job['candidateOID']
            require(self.system.oid(DATABASE) == expected_oid, 'Current staging database belongs to another recovery.')
            require(self.system.validate(DATABASE, job.get('candidateRole') if action == 'freeze-rollback' else None)['schemaHash'] == job['validation']['schemaHash'], 'Staging schema changed after validation.')
            job['writers'] = self.system.writers()
            require([{k: item[k] for k in ['id', 'image', 'configHash']} for item in job['writers']] == [{k: item[k] for k in ['id', 'image', 'configHash']} for item in job['validationWriters']], 'Staging release changed after the test restore; validate again.')
            require(not any(item['paused'] for item in job['writers']), 'Another operator already paused staging.')
            job['lockOwner'] = str(int(time.time())) + '-' + secrets.token_hex(16)
            self.audit(request, 'intent')
            job['phase'] = 'freezing'
            self.persist(job)
            try:
                self.acquire(job)
                self.system.fence(job, True)
                self.persist(job)
                self.system.probe_fence(job)
                for item in job['writers']:
                    self.system.pause(item['id'], True)
                self.system.verify_writers(job, True)
                self.system.probe_fence(job)
                job['phase'] = 'frozen' if action == 'freeze' else 'frozen-rollback'
                self.persist(job)
            except LockBusy:
                job['phase'] = expected_phase
                self.persist(job)
                raise
            except Exception:
                job['phase'] = 'held'
                self.persist(job)
                raise
        elif action in {'restore', 'rollback'}:
            require(job['phase'] == ('frozen' if action == 'restore' else 'frozen-rollback'), 'Staging must be paused and verified before a switch.')
            self.owned_lock(job)
            self.system.verify_writers(job, True)
            self.system.probe_fence(job)
            self.audit(request, 'intent')
            job['phase'] = 'switching'
            self.persist(job)
            try:
                self.system.switch(job, action == 'rollback')
                self.system.verify_writers(job, True)
                job['rolledBack'] = action == 'rollback'
                job['phase'] = 'rolled-back' if job['rolledBack'] else 'restored'
                self.persist(job)
            except Exception:
                job['phase'] = 'held'
                self.persist(job)
                raise
        elif action == 'resume':
            require(request.get('queuesReconciled') is True, 'Confirm queue and cache reconciliation before resuming staging.')
            require(job['phase'] in {'restored', 'rolled-back', 'resume-committed'}, 'Only a verified switched database may resume.')
            if job['phase'] == 'resume-committed':
                self.finish_resume(job)
                self.audit(request, job['phase'])
                return job
            self.owned_lock(job)
            expected_oid = job['originalOID'] if job.get('rolledBack') else job['candidateOID']
            require(self.system.oid(DATABASE) == expected_oid, 'Active database identity changed.')
            require(self.system.validate(DATABASE, None if job.get('rolledBack') else job.get('candidateRole'))['schemaHash'] == job['validation']['schemaHash'], 'Restored staging schema did not validate.')
            self.system.verify_writers(job, True)
            self.system.probe_fence(job)
            self.audit(request, 'intent-after-operator-queue-cache-checks')
            job['phase'] = 'resuming'
            job['sessions'] = ssh_sessions()
            self.persist(job)
            committed = False
            try:
                job['guard'] = self.system.start_guard(job)
                with self.transition(job):
                    require(read_json(self.path(job['id']))['phase'] == 'resuming', 'Resume was already contained.')
                    self.system.check_guard(job)
                    self.persist(job)
                web = next(item for item in job['writers'] if item['role'] == 'web')
                self.system.check_guard(job)
                self.system.pause(web['id'], False)
                self.system.probe_web(job)
                for item in job['writers']:
                    if item['role'] != 'web':
                        self.system.check_guard(job)
                        self.system.pause(item['id'], False)
                with self.transition(job):
                    require(read_json(self.path(job['id']))['phase'] == 'resuming', 'Resume was already contained.')
                    self.system.verify_writers(job, False)
                    self.system.check_guard(job)
                    job['phase'] = 'resume-committed'
                    self.persist(job)
                    committed = True
                self.finish_resume(job)
            except Exception:
                if not committed:
                    with self.transition(job):
                        try:
                            self.system.hold_writers(job)
                        finally:
                            job['phase'] = 'held'
                            self.persist(job)
                raise
        elif action == 'abort':
            require(job['phase'] in {'validated', 'failed'}, 'A paused or switched recovery cannot be discarded.')
            candidate = job.get('candidateOID')
            require(self.system.oid(DATABASE) == job['originalOID'], 'Current database identity changed.')
            self.audit(request, 'intent')
            if candidate:
                require(self.system.oid(job['candidateDatabase']) == candidate, 'Candidate database identity changed.')
                self.system.sql('DROP DATABASE ' + identifier(job['candidateDatabase']) + ' WITH (FORCE)')
                if job.get('candidateRole'):
                    self.system.sql('DROP ROLE ' + identifier(job['candidateRole']))
            job['phase'] = 'aborted'
            self.persist(job)
        self.audit(request, job['phase'])
        return job

    def finish_resume(self, job):
        expected = job['originalOID'] if job.get('rolledBack') else job['candidateOID']
        require(self.system.oid(DATABASE) == expected, 'Committed database identity changed.')
        self.system.verify_writers(job, False)
        self.system.probe_web(job)
        released = self.released(job)
        if ROLLOUT_LOCK.exists() and not released:
            self.owned_lock(job)
        path = Path(self.config['proxyConfig'])
        if path.exists():
            require(not released and ROLLOUT_LOCK.exists(), 'Cannot remove a fence without its owned lock.')
            self.system.fence(job, False)
        self.release(job)
        job['phase'] = 'resumed'
        self.persist(job)

    def guard_resume(self, job_id, ready_fd):
        job = read_json(self.path(job_id))
        require(job['phase'] == 'resuming' and job.get('workerHash') == worker_hash(), 'Resume guard identity changed.')
        require(job['configHash'] == hashlib.sha256(json.dumps(self.config, sort_keys=True).encode()).hexdigest(), 'Resume guard configuration changed.')
        self.check_target(job)
        self.owned_lock(job)
        self.system.verify_writers(job, True)
        self.system.probe_fence(job)
        path = self.path(job_id).with_suffix('.guard.sock')
        with socket.socket(socket.AF_UNIX) as server:
            server.bind(str(path))
            os.chmod(path, 0o600)
            server.listen(1)
            os.write(ready_fd, b'ready\n')
            os.close(ready_fd)
            try:
                while True:
                    with self.transition(job):
                        current = read_json(self.path(job_id))
                        if current['phase'] not in {'resuming', 'held'}:
                            return
                        identity = current['process']
                        if current['phase'] == 'held' or process_identity(identity['pid']) != identity or not sessions_alive(current):
                            self.owned_lock(current)
                            self.system.hold_writers(current)
                            if current['phase'] != 'held':
                                current['phase'] = 'held'
                                current['interrupted'] = True
                                try:
                                    self.persist(current)
                                except OSError:
                                    pass
                    if not select.select([server], [], [], 0.25)[0]:
                        continue
                    with server.accept()[0] as connection:
                        connection.settimeout(10)
                        data = bytearray()
                        while b'\n' not in data and len(data) <= 1024:
                            chunk = connection.recv(1024)
                            if not chunk:
                                break
                            data.extend(chunk)
                        request = json.loads(data, object_pairs_hook=no_duplicates)
                        require(set(request) == {'container'} and request['container'] in {item['id'] for item in job['writers']}, 'Unpause executor rejected an unrecorded identity.')
                        with self.transition(job):
                            current = read_json(self.path(job_id))
                            identity = current['process']
                            if current['phase'] != 'resuming' or process_identity(identity['pid']) != identity or not sessions_alive(current):
                                continue
                            self.owned_lock(current)
                            try:
                                self.system.run(['docker', 'unpause', request['container']])
                                require(process_identity(identity['pid']) == identity and sessions_alive(current), 'Resume owner disappeared during unpause.')
                                connection.sendall(b'completed\n')
                            except Exception:
                                self.system.hold_writers(current)
                                current['phase'] = 'held'
                                try:
                                    self.persist(current)
                                except OSError:
                                    pass
            finally:
                path.unlink(missing_ok=True)


class Fence(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.respond(False)

    def do_HEAD(self):
        self.respond(True)

    def respond(self, head):
        try:
            job_id = read_json(FENCE_STATE)['jobId']
            require(JOB_ID.fullmatch(job_id) is not None, 'Invalid maintenance identity.')
        except Exception:
            self.send_error(404)
            return
        json_response = 'application/json' in self.headers.get('Accept', '')
        body = json.dumps({'status': 'maintenance', 'message': 'Staging database recovery in progress.'}).encode() if json_response else b'<!doctype html><title>NHWeb Services Backups</title><h1>Staging recovery in progress</h1><p>Please try again shortly.</p>'
        self.send_response(503)
        for key, value in {'Content-Type': 'application/json' if json_response else 'text/html; charset=utf-8', 'Content-Length': str(len(body)), 'Cache-Control': 'no-store', 'Retry-After': '120', 'X-NHWS-Recovery-Job': job_id}.items():
            self.send_header(key, value)
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def log_message(self, *args):
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--serve-fence', action='store_true')
    parser.add_argument('--guard-resume')
    parser.add_argument('--ready-fd', type=int)
    args = parser.parse_args()
    if args.serve_fence:
        http.server.ThreadingHTTPServer(('0.0.0.0', 8790), Fence).serve_forever()
        return
    result = {'environment': 'staging', 'target': TARGET}
    try:
        require(os.environ.get('SSH_ORIGINAL_COMMAND', 'nhws-staging-recovery') == 'nhws-staging-recovery', 'Unsupported SSH command.')
        config = load_config(CONFIG_PATH)
        if args.guard_resume:
            Workflow(config, System(config)).guard_resume(args.guard_resume, args.ready_fd)
            return
        raw = sys.stdin.buffer.read(16385)
        require(len(raw) <= 16384, 'Recovery request is too large.')
        request = json.loads(raw, object_pairs_hook=no_duplicates)
        workflow = Workflow(config, System(config))
        import fcntl
        with (workflow.directory / '.request.lock').open('a') as lock:
            if request.get('action') != 'status':
                try:
                    fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    raise Refusal('Another recovery action is running; inspect status before retrying.') from None
            result['job'] = workflow.handle(request)
    except Refusal as error:
        result['error'] = str(error)
    except Exception:
        result['error'] = 'Recovery stopped. Refresh its status and inspect the restricted worker journal before advancing.'
    print(json.dumps(result))
    raise SystemExit(1 if result.get('error') else 0)


if __name__ == '__main__':
    main()
