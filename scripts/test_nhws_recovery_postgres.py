"""Real PostgreSQL/restic rehearsal; fence/writer control is covered separately."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

spec = importlib.util.spec_from_file_location('recovery', Path(__file__).with_name('nhws_staging_recovery.py'))
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)

container = sys.argv[1]
assert container.startswith('nhws-recovery-test-')
inspection = json.loads(subprocess.check_output(['docker', 'inspect', container]))[0]
assert inspection['Config']['Labels'].get('nhws.recovery-fixture') == 'true'


class PostgreSQLRehearsal(recovery.System):
    def validate(self, database, role=None):
        if role:
            self.last_restricted_validation = role
        return super().validate(database, role)

    def writers(self):
        return [{'id': role, 'role': role, 'image': 'synthetic-image', 'configHash': 'synthetic-config', 'paused': self.paused} for role in ['web', 'queue', 'scheduler', 'pulse', 'release']]

    def fence(self, job, enable):
        self.fenced = enable
        job['fenceHash'] = 'synthetic-fence'
        path = Path(self.config['proxyConfig'])
        if enable:
            path.write_text('synthetic-fence')
        else:
            path.unlink()

    def probe_fence(self, job):
        assert self.fenced

    def verify_writers(self, job, paused):
        assert self.paused == paused

    def pause(self, container, paused):
        self.paused = paused

    def probe_web(self, job):
        assert self.sql('SELECT count(*) FROM public.documents', recovery.DATABASE) in {'1', '2'}

    def start_guard(self, job):
        return {'test': 'guard adapter; survival is tested separately'}

    def check_guard(self, job):
        pass


with tempfile.TemporaryDirectory(prefix='nhws-pg-rehearsal-') as temporary:
    root = Path(temporary)
    password = root / 'password'
    password.write_text('synthetic-repository-password-only')
    password.chmod(0o600)
    env = os.environ | {'RESTIC_PASSWORD_FILE': str(password)}
    repo = root / 'repository'
    command = ['/usr/local/bin/restic', '-r', str(repo)]
    subprocess.run(command + ['init'], env=env, check=True, stdout=subprocess.DEVNULL)
    repository_id = json.loads(subprocess.check_output(command + ['cat', 'config'], env=env))['id']
    config = {'container': container, 'repository': str(repo), 'repositoryId': repository_id,
              'passwordFile': str(password), 'stateDir': str(root / 'state'), 'environment': 'staging', 'proxyConfig': str(root / 'fence.yml')}
    system = PostgreSQLRehearsal(config)
    system.paused, system.fenced = False, False
    system.sql('''CREATE TABLE public.migrations(id serial PRIMARY KEY, migration text NOT NULL, batch int NOT NULL);
CREATE TABLE public.users(id serial PRIMARY KEY, name text NOT NULL);
CREATE TABLE public.businesses(id serial PRIMARY KEY, user_id int NOT NULL REFERENCES public.users(id));
CREATE TABLE public.documents(id serial PRIMARY KEY, business_id int NOT NULL REFERENCES public.businesses(id), amount numeric(12,2) NOT NULL CHECK(amount>=0));
INSERT INTO public.migrations(migration,batch) VALUES('synthetic_initial_schema',1);
INSERT INTO public.users(name) VALUES('Synthetic operator');
INSERT INTO public.businesses(user_id) VALUES(1);
INSERT INTO public.documents(business_id,amount) VALUES(1,100.00);''', recovery.DATABASE)
    dump = subprocess.check_output(['docker', 'exec', system.target_id, 'pg_dump', '-U', recovery.DATABASE, '-d', recovery.DATABASE, '-Fc', '--no-owner', '--no-acl'])
    subprocess.run(command + ['backup', '--stdin', '--stdin-filename', 'dzdistro_staging.dump', '--tag', 'staging-postgres'], input=dump, env=env, check=True, stdout=subprocess.DEVNULL)
    snapshot = json.loads(subprocess.check_output(command + ['snapshots', '--json'], env=env))[0]['id']
    system.sql('INSERT INTO public.documents(business_id,amount) VALUES(1,200.00)', recovery.DATABASE)
    assert system.sql('SELECT count(*) FROM public.documents', recovery.DATABASE) == '2'
    recovery.ROLLOUT_LOCK = root / 'shared-staging-rollout.lock'
    flow = recovery.Workflow(config, system)
    job_id = 'c' * 32

    def call(action, confirmation='', **extra):
        return flow.handle({'action': action, 'jobId': job_id, 'environment': 'staging', 'actor': 'synthetic-operator', 'confirmation': confirmation} | extra)

    job = call('prepare', snapshotId=snapshot)
    assert job['phase'] == 'validated' and job['validation']['tables'] == 4 and job['validation']['rows'] == 4
    assert job['dumpSha256'] == hashlib.sha256(dump).hexdigest()
    assert not list((root / 'state').glob('*.dump'))
    assert system.sql('SELECT count(*) FROM public.documents', recovery.DATABASE) == '2'
    call('freeze', 'PAUSE DZDISTRO STAGING')
    call('restore', 'RESTORE DZDISTRO STAGING ' + snapshot[:8])
    assert system.sql('SELECT count(*) FROM public.documents', recovery.DATABASE) == '1'
    assert system.sql('SELECT sum(amount) FROM public.documents', recovery.DATABASE) == '100.00'
    assert system.oid(job['retainedDatabase']) == job['originalOID']
    call('resume', 'RESUME DZDISTRO STAGING ' + job_id[:8], queuesReconciled=True)
    call('freeze-rollback', 'PAUSE DZDISTRO STAGING')
    call('rollback', 'ROLLBACK DZDISTRO STAGING ' + job_id[:8])
    assert system.sql('SELECT count(*) FROM public.documents', recovery.DATABASE) == '2'
    assert system.sql('SELECT sum(amount) FROM public.documents', recovery.DATABASE) == '300.00'
    assert system.oid(job['afterDatabase']) == job['candidateOID']
    call('resume', 'RESUME DZDISTRO STAGING ' + job_id[:8], queuesReconciled=True)
    active_oid = system.oid(recovery.DATABASE)
    system.sql('''CREATE FUNCTION public.archive_callback() RETURNS boolean LANGUAGE plpgsql AS $function$
BEGIN
 IF current_database() LIKE 'dzdistro_restore_%' THEN
  EXECUTE $command$COPY (SELECT 1) TO PROGRAM 'psql -U dzdistro_staging -d dzdistro_staging -c "TRUNCATE documents"'$command$;
 END IF;
 RETURN true;
END $function$;
ALTER TABLE public.documents ADD CONSTRAINT archive_callback_check CHECK (public.archive_callback());''', recovery.DATABASE)
    hostile_dump = subprocess.check_output(['docker', 'exec', system.target_id, 'pg_dump', '-U', recovery.DATABASE, '-d', recovery.DATABASE, '-Fc', '--no-owner', '--no-acl'])
    subprocess.run(command + ['backup', '--stdin', '--stdin-filename', 'dzdistro_staging.dump', '--tag', 'staging-postgres'], input=hostile_dump, env=env, check=True, stdout=subprocess.DEVNULL)
    hostile_snapshot = json.loads(subprocess.check_output(command + ['snapshots', '--json'], env=env))[-1]['id']
    job_id = 'd' * 32
    try:
        call('prepare', snapshotId=hostile_snapshot)
        raise AssertionError('Archive callback unexpectedly passed')
    except recovery.Refusal:
        pass
    assert call('status')['phase'] == 'failed'
    assert system.oid(recovery.DATABASE) == active_oid
    assert system.sql('SELECT count(*) FROM public.documents', recovery.DATABASE) == '2'
    assert system.sql('SELECT sum(amount) FROM public.documents', recovery.DATABASE) == '300.00'
    assert not list((root / 'state').glob('*.dump'))
    system.sql('''ALTER TABLE public.documents DROP CONSTRAINT archive_callback_check;
DROP FUNCTION public.archive_callback();
CREATE FUNCTION public.archive_prepare() RETURNS boolean LANGUAGE plpgsql AS $function$
BEGIN
 IF current_database() LIKE 'dzdistro_restore_%' THEN
  EXECUTE 'ALTER DATABASE '||quote_ident(current_database())||' SET search_path TO public,pg_catalog';
 END IF;
 RETURN true;
END $function$;
CREATE FUNCTION public.validation_callback() RETURNS boolean LANGUAGE plpgsql AS $function$
BEGIN
 IF current_database() LIKE 'dzdistro_restore_%' THEN
  EXECUTE $command$COPY (SELECT 1) TO PROGRAM 'psql -U dzdistro_staging -d dzdistro_staging -c "TRUNCATE documents"'$command$;
 END IF;
 RETURN true;
END $function$;
CREATE VIEW public.pg_tables AS SELECT schemaname,tablename FROM pg_catalog.pg_tables WHERE public.validation_callback();
ALTER TABLE public.documents ADD CONSTRAINT archive_prepare_check CHECK (public.archive_prepare());
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents FORCE ROW LEVEL SECURITY;
CREATE POLICY deferred_validation ON public.documents FOR SELECT USING (public.validation_callback());''', recovery.DATABASE)
    deferred_dump = subprocess.check_output(['docker', 'exec', system.target_id, 'pg_dump', '-U', recovery.DATABASE, '-d', recovery.DATABASE, '-Fc', '--no-owner', '--no-acl'])
    subprocess.run(command + ['backup', '--stdin', '--stdin-filename', 'dzdistro_staging.dump', '--tag', 'staging-postgres'], input=deferred_dump, env=env, check=True, stdout=subprocess.DEVNULL)
    deferred_snapshot = json.loads(subprocess.check_output(command + ['snapshots', '--json'], env=env))[-1]['id']
    job_id = 'e' * 32
    try:
        call('prepare', snapshotId=deferred_snapshot)
        raise AssertionError('Deferred validation callback unexpectedly passed')
    except recovery.Refusal:
        pass
    assert call('status')['phase'] == 'failed'
    assert system.last_restricted_validation == 'dzdistro_recovery_' + job_id
    assert system.oid(recovery.DATABASE) == active_oid
    assert system.sql('SELECT count(*) FROM public.documents', recovery.DATABASE) == '2'
    assert system.sql('SELECT sum(amount) FROM public.documents', recovery.DATABASE) == '300.00'
    assert not list((root / 'state').glob('*.dump'))
    system.sql('''DROP POLICY deferred_validation ON public.documents;
ALTER TABLE public.documents DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.documents DROP CONSTRAINT archive_prepare_check;
DROP VIEW public.pg_tables;
DROP FUNCTION public.validation_callback(); DROP FUNCTION public.archive_prepare();
CREATE FUNCTION public.write_callback() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
 IF current_user='dzdistro_staging' THEN
  EXECUTE $command$COPY (SELECT 1) TO PROGRAM 'psql -U dzdistro_staging -d dzdistro_staging -c "TRUNCATE documents"'$command$;
 END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER archive_write_callback BEFORE INSERT ON public.documents FOR EACH ROW EXECUTE FUNCTION public.write_callback();''', recovery.DATABASE)
    trigger_dump = subprocess.check_output(['docker', 'exec', system.target_id, 'pg_dump', '-U', recovery.DATABASE, '-d', recovery.DATABASE, '-Fc', '--no-owner', '--no-acl'])
    subprocess.run(command + ['backup', '--stdin', '--stdin-filename', 'dzdistro_staging.dump', '--tag', 'staging-postgres'], input=trigger_dump, env=env, check=True, stdout=subprocess.DEVNULL)
    trigger_snapshot = json.loads(subprocess.check_output(command + ['snapshots', '--json'], env=env))[-1]['id']
    system.sql('DROP TRIGGER archive_write_callback ON public.documents; DROP FUNCTION public.write_callback()', recovery.DATABASE)
    job_id = 'f' * 32
    try:
        call('prepare', snapshotId=trigger_snapshot)
        raise AssertionError('Archive introduced executable schema into the trusted release')
    except recovery.Refusal:
        pass
    assert call('status')['phase'] == 'failed'
    assert system.oid(recovery.DATABASE) == active_oid
    system.sql('INSERT INTO public.documents(business_id,amount) VALUES(1,50.00)', recovery.DATABASE)
    assert system.sql('SELECT count(*) FROM public.documents', recovery.DATABASE) == '3'
    assert system.sql('SELECT sum(amount) FROM public.documents', recovery.DATABASE) == '350.00'
    assert system.oid(job['afterDatabase']) == job['candidateOID']
    print(json.dumps({'real_postgresql_restore': 'PASS', 'native_restic_encryption_and_decryption': 'PASS',
                      'archive_sha256_matches': True, 'snapshot_documents': 1, 'restored_total': '100.00',
                      'rollback_documents': 2, 'rollback_total': '300.00', 'original_database_retained': True,
                      'post_restore_database_retained_after_rollback': True, 'plaintext_dump_removed': True,
                      'encrypted_restore_callback_cannot_modify_active_staging': True,
                      'deferred_validation_callback_cannot_modify_active_staging': True,
                      'archive_trigger_rejected_before_application_write': True,
                      'scope': 'synthetic local PostgreSQL17; fence/writer adapter in this test is simulated'}))
