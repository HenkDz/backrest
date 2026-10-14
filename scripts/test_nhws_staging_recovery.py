import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('recovery', Path(__file__).with_name('nhws_staging_recovery.py'))
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)

JOB = 'a' * 32
SNAPSHOT = 'b' * 64


class FakeSystem:
    def __init__(self):
        self.databases = {recovery.DATABASE: 10}
        self.rows = {10: 2, 20: 1}
        self.states = {role: False for role in ['web', 'queue', 'scheduler', 'pulse', 'release']}
        self.fenced = False
        self.events = []
        self.drift = False
        self.lose_switch_response = False
        self.target_id = 'pinned-staging-container'

    def target(self):
        return {'Id': self.target_id}

    def oid(self, name):
        return self.databases.get(name)

    def validate(self, database, role=None):
        return {'schemaHash': 'same-current-release-schema', 'tables': 4, 'rows': self.rows[self.databases[database]], 'tableRows': {}}

    def prepare(self, job, dump, persist):
        self.events.append('isolated-restore')
        dump.write_bytes(b'PGDMPsynthetic-archive')
        job['candidateOID'] = 20
        self.databases[job['candidateDatabase']] = 20
        job['validation'] = self.validate(job['candidateDatabase'])
        job['dumpSha256'] = 'test-checksum'
        persist(job)

    def writers(self):
        return [{'id': role, 'role': role, 'image': 'same-image', 'configHash': 'same-config', 'paused': self.states[role]} for role in ['web', 'queue', 'scheduler', 'pulse', 'release']]

    @property
    def paused(self):
        return all(self.states.values())

    def verify_writers(self, job, paused):
        recovery.require(not self.drift and all(state == paused for state in self.states.values()), 'Writer identity or state changed.')

    def fence(self, job, enabled):
        self.events.append('fence-on' if enabled else 'fence-off')
        self.fenced = enabled
        job['fenceHash'] = 'owned-fence'
        if enabled:
            self.fence_path.write_text('owned-fence')
        else:
            self.fence_path.unlink()

    def probe_fence(self, job):
        recovery.require(self.fenced, 'Maintenance fence is not active.')

    def pause(self, container, paused):
        self.events.append(('pause-' if paused else 'unpause-') + container)
        self.states[container] = paused

    def probe_web(self, job):
        self.events.append('probe-web')

    def hold_writers(self, job):
        self.events.append('re-pause-writers')
        self.states = dict.fromkeys(self.states, True)

    def start_guard(self, job):
        return {'test': 'independent-guard'}

    def check_guard(self, job):
        pass

    def switch(self, job, rollback):
        self.events.append('switch')
        source = job['retainedDatabase'] if rollback else job['candidateDatabase']
        retained = job['afterDatabase'] if rollback else job['retainedDatabase']
        self.databases[retained] = self.databases[recovery.DATABASE]
        self.databases[recovery.DATABASE] = self.databases.pop(source)
        if self.lose_switch_response:
            raise TimeoutError('Lost response after applied transaction')

    def sql(self, query, database='postgres'):
        self.events.append(query)
        if query.startswith('DROP DATABASE'):
            self.databases.pop(query.split('"')[1])
        return ''


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        recovery.ROLLOUT_LOCK = self.root / 'rollout.lock'
        recovery.FENCE_STATE = self.root / 'fence.json'
        self.config = {'stateDir': str(self.root / 'private-state'), 'environment': 'staging', 'proxyConfig': str(self.root / 'fence.yml')}
        self.system = FakeSystem()
        self.system.fence_path = Path(self.config['proxyConfig'])
        self.flow = recovery.Workflow(self.config, self.system)

    def tearDown(self):
        self.temp.cleanup()

    def call(self, operation, confirmation='', **extra):
        request = {'action': operation, 'jobId': JOB, 'environment': 'staging', 'actor': 'approved-operator', 'confirmation': confirmation}
        request.update(extra)
        return self.flow.handle(request)

    def prepare(self):
        return self.call('prepare', snapshotId=SNAPSHOT)

    def freeze(self):
        return self.call('freeze', 'PAUSE DZDISTRO STAGING')

    def restore(self):
        return self.call('restore', 'RESTORE DZDISTRO STAGING ' + SNAPSHOT[:8])

    def resume(self):
        return self.call('resume', 'RESUME DZDISTRO STAGING ' + JOB[:8], queuesReconciled=True)

    def test_guided_restore_and_rollback_preserve_both_databases(self):
        self.prepare()
        self.assertEqual(self.system.databases[recovery.DATABASE], 10)
        self.assertFalse((self.root / 'private-state' / (JOB + '.dump')).exists())
        self.freeze()
        restored = self.restore()
        self.assertEqual(self.system.databases[recovery.DATABASE], 20)
        self.assertEqual(self.system.databases[restored['retainedDatabase']], 10)
        self.resume()
        self.assertFalse(recovery.ROLLOUT_LOCK.exists())
        self.assertLess(self.system.events.index('probe-web'), self.system.events.index('unpause-queue'))
        self.call('freeze-rollback', 'PAUSE DZDISTRO STAGING')
        rolled_back = self.call('rollback', 'ROLLBACK DZDISTRO STAGING ' + JOB[:8])
        self.assertEqual(self.system.databases[recovery.DATABASE], 10)
        self.assertEqual(self.system.databases[rolled_back['afterDatabase']], 20)
        self.resume()

    def test_direct_switch_and_wrong_confirmation_have_no_mutations(self):
        self.prepare()
        before = self.system.events.copy()
        with self.assertRaises(recovery.Refusal):
            self.restore()
        self.assertEqual(self.system.events, before)
        self.freeze()
        before = self.system.events.copy()
        with self.assertRaises(recovery.Refusal):
            self.call('restore', 'RESTORE PRODUCTION')
        self.assertEqual(self.system.events, before)

    def test_existing_deployment_lock_is_preserved_and_pause_can_be_retried_later(self):
        self.prepare()
        recovery.ROLLOUT_LOCK.mkdir()
        owner = {'schema_version': 1, 'environment': 'staging', 'rollout_id': 'another-deployment'}
        recovery.save_json(recovery.ROLLOUT_LOCK / 'owner.json', owner)
        with self.assertRaises(recovery.LockBusy):
            self.freeze()
        self.assertEqual(recovery.read_json(recovery.ROLLOUT_LOCK / 'owner.json'), owner)
        self.assertEqual(self.call('status')['phase'], 'validated')
        self.assertFalse(self.system.fenced)

    def test_applied_switch_with_lost_response_is_held_and_not_replayed(self):
        self.prepare()
        self.freeze()
        self.system.lose_switch_response = True
        with self.assertRaises(TimeoutError):
            self.restore()
        self.assertEqual(self.call('status')['phase'], 'held')
        self.assertTrue(self.system.paused and self.system.fenced and recovery.ROLLOUT_LOCK.exists())
        self.assertEqual(self.system.databases[recovery.DATABASE], 20)
        before = self.system.events.copy()
        with self.assertRaises(recovery.Refusal):
            self.restore()
        self.assertEqual(self.system.events, before)

    def test_configuration_container_and_writer_drift_refuse_before_switch(self):
        self.prepare()
        self.freeze()
        for mode in ['config', 'container', 'writers']:
            original_config = self.config.copy()
            original_id = self.system.target_id
            if mode == 'config':
                self.config['environment'] = 'production'
            elif mode == 'container':
                self.system.target_id = 'unrelated-container'
            else:
                self.system.drift = True
            before = self.system.events.copy()
            with self.assertRaises(recovery.Refusal):
                self.restore()
            self.assertEqual(self.system.events, before)
            self.config.clear()
            self.config.update(original_config)
            self.system.target_id = original_id
            self.system.drift = False

    def test_switch_replay_and_resume_without_queue_acknowledgement_are_refused(self):
        self.prepare()
        self.freeze()
        self.restore()
        before = self.system.events.copy()
        with self.assertRaises(recovery.Refusal):
            self.restore()
        with self.assertRaises(recovery.Refusal):
            self.call('resume', 'RESUME DZDISTRO STAGING ' + JOB[:8])
        self.assertEqual(self.system.events, before)

    def test_failed_web_health_repauses_writers_and_preserves_fence_and_lock(self):
        self.prepare()
        self.freeze()
        self.restore()
        def fail(job):
            raise recovery.Refusal('Web health did not pass')
        self.system.probe_web = fail
        with self.assertRaises(recovery.Refusal):
            self.resume()
        self.assertEqual(self.call('status')['phase'], 'held')
        self.assertTrue(self.system.paused and self.system.fenced and recovery.ROLLOUT_LOCK.exists())
        self.assertNotIn('unpause-queue', self.system.events)

    def test_containment_runs_even_when_held_journal_cannot_be_written(self):
        self.prepare()
        self.freeze()
        self.restore()
        persist = self.flow.persist
        def write(job):
            if job['phase'] == 'held':
                raise OSError('ENOSPC')
            persist(job)
        self.flow.persist = write
        self.system.probe_web = lambda job: (_ for _ in ()).throw(recovery.Refusal('Health failed'))
        with self.assertRaises(OSError):
            self.resume()
        self.assertTrue(all(self.system.states.values()))
        self.assertTrue(self.system.fenced and recovery.ROLLOUT_LOCK.exists())

    def test_commit_persistence_failure_holds_all_roles_before_teardown(self):
        self.prepare()
        self.freeze()
        self.restore()
        persist = self.flow.persist
        def write(job):
            if job['phase'] == 'resume-committed':
                raise OSError('ENOSPC')
            persist(job)
        self.flow.persist = write
        with self.assertRaises(OSError):
            self.resume()
        self.assertTrue(all(self.system.states.values()))
        self.assertTrue(self.system.fenced and recovery.ROLLOUT_LOCK.exists())
        self.assertEqual(self.call('status')['phase'], 'held')

    def test_durable_resume_commit_precedes_fence_lock_and_final_journal_failures(self):
        for failure in ['fence', 'lock', 'journal']:
            with self.subTest(failure=failure):
                self.tearDown()
                self.setUp()
                self.prepare()
                self.freeze()
                self.restore()
                def fail(*args):
                    raise OSError('Injected I/O failure')
                if failure == 'fence':
                    self.system.fence = fail
                elif failure == 'lock':
                    self.flow.release = fail
                else:
                    persist = self.flow.persist
                    def write(job):
                        if job['phase'] == 'resumed':
                            fail()
                        persist(job)
                    self.flow.persist = write
                with self.assertRaises(OSError):
                    self.resume()
                self.assertEqual(self.call('status')['phase'], 'resume-committed')
                self.assertFalse(any(self.system.states.values()))

    def test_partial_release_keeps_owned_receipt_and_retry_never_unpauses(self):
        self.prepare()
        self.freeze()
        self.restore()
        release = self.flow.release
        def fail_after_move(job):
            release(job)
            raise OSError('Failure after atomic lock move')
        self.flow.release = fail_after_move
        with self.assertRaises(OSError):
            self.resume()
        committed = self.call('status')
        self.assertEqual(committed['phase'], 'resume-committed')
        self.assertFalse(recovery.ROLLOUT_LOCK.exists())
        self.assertTrue(self.flow.released(committed))
        before = [event for event in self.system.events if event.startswith('unpause-') or event == 'switch']
        recovery.ROLLOUT_LOCK.mkdir()
        foreign = {'schema_version': 1, 'environment': 'staging', 'rollout_id': 'another-deployment'}
        recovery.save_json(recovery.ROLLOUT_LOCK / 'owner.json', foreign)
        self.flow.release = release
        self.assertEqual(self.resume()['phase'], 'resumed')
        self.assertEqual(recovery.read_json(recovery.ROLLOUT_LOCK / 'owner.json'), foreign)
        self.assertEqual([event for event in self.system.events if event.startswith('unpause-') or event == 'switch'], before)

    def test_unknown_and_production_requests_have_no_effects(self):
        for extra in [{'environment': 'production'}, {'command': 'shell'}, {'action': 'run-command'}, {'jobId': '../other'}, {'actor': []}]:
            with self.assertRaises(recovery.Refusal):
                self.call('prepare', snapshotId=SNAPSHOT, **extra)
        self.assertEqual(self.system.events, [])

    def test_abort_only_drops_the_owned_isolated_database(self):
        job = self.prepare()
        self.call('abort', 'DISCARD TEST RESTORE ' + JOB[:8])
        self.assertEqual(self.system.databases, {recovery.DATABASE: 10})
        self.assertEqual(self.call('status')['phase'], 'aborted')

    def test_duplicate_json_properties_are_rejected(self):
        with self.assertRaises(recovery.Refusal):
            json.loads('{"environment":"staging","environment":"production"}', object_pairs_hook=recovery.no_duplicates)

    def test_production_container_labels_are_refused(self):
        system = object.__new__(recovery.System)
        system.config = {'container': 'fixture'}
        system.run = lambda _: json.dumps([{'Id': 'other', 'State': {'Running': True}, 'Config': {'Labels': {'coolify.projectName': 'dzdistro', 'coolify.environmentName': 'production'}}}]).encode()
        with self.assertRaises(recovery.Refusal):
            system.target()


if __name__ == '__main__':
    unittest.main()
