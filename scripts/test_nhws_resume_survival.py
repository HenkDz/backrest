"""Linux-only destructive fault rehearsal, restricted to the labelled local fixture."""
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import subprocess
import time

worker = Path('/usr/local/libexec/nhweb-backups/staging_recovery.py')
spec = importlib.util.spec_from_file_location('recovery', worker)
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)
config = recovery.load_config(recovery.CONFIG_PATH)
assert config['container'].startswith('nhws-recovery-ui-') and config['repository'].startswith('/var/lib/fixture-repo')
system = recovery.System(config)
target = system.target()
assert target['Config']['Labels'].get('nhws.recovery-fixture') == 'true'
assert all(value.startswith('nhws-recovery-ui-') for value in config['writers'].values())
flow = recovery.Workflow(config, system)
snapshots = json.loads(system.restic(['snapshots', '--json']))
snapshot = next(item['id'] for item in reversed(snapshots) if item['paths'] == ['/dzdistro_staging.dump'] and item['summary']['total_bytes_processed'] > 0)
job_id = secrets.token_hex(16)

def call(action, confirmation='', **extra):
    return flow.handle({'action': action, 'jobId': job_id, 'actor': 'synthetic-survival-test', 'environment': 'staging', 'confirmation': confirmation} | extra)

job = call('prepare', snapshotId=snapshot)
call('freeze', 'PAUSE DZDISTRO STAGING')
call('restore', 'RESTORE DZDISTRO STAGING ' + snapshot[:8])
job = call('status')
active_oid = system.oid(recovery.DATABASE)
real_docker = shutil.which('docker')
shim = Path('/usr/local/bin/docker')
assert str(shim) != real_docker and not shim.exists()
barrier = Path('/run/nhws-recovery-fixture-barrier.json')
marker = Path('/run/nhws-recovery-fixture-marker.json')
shim.write_text('''#!/usr/bin/python3
import json,sys,subprocess,time,os
from pathlib import Path
code=subprocess.run([REAL_DOCKER,*sys.argv[1:]]).returncode
p=Path('/run/nhws-recovery-fixture-barrier.json')
if code==0 and p.exists() and len(sys.argv)==3 and sys.argv[1]=='unpause':
 c=json.loads(p.read_text())
 if sys.argv[2]==c['container']:
  Path('/run/nhws-recovery-fixture-marker.json').write_text(json.dumps({'pid':os.getpid()}))
  deadline=time.monotonic()+60
  while time.monotonic()<deadline:
   if json.loads(p.read_text()).get('release'):
    sys.stderr.write('Injected synthetic post-unpause failure')
    sys.exit(1)
   time.sleep(.05)
sys.exit(code)
'''.replace('REAL_DOCKER', repr(real_docker)))
shim.chmod(0o755)
key = Path('/root/.ssh/survival-fixture-key')
key.write_bytes(Path('/fixture/fixture-ssh').read_bytes())
key.chmod(0o600)
known_hosts = Path('/root/.ssh/survival-fixture-known-hosts')
public = Path('/etc/ssh/ssh_host_ed25519_key.pub').read_text().split()
known_hosts.write_text('localhost ' + public[0] + ' ' + public[1] + '\n')
clients = []
receipts = []

def wait_for(predicate, seconds=20):
    deadline = time.monotonic() + seconds
    while not predicate():
        assert time.monotonic() < deadline, 'Fixture fault did not reach the expected state'
        time.sleep(.1)

try:
    cases = [(mode, role) for mode in ['hard-kill', 'SSH-disconnect'] for role in ['web', 'queue', 'scheduler', 'pulse', 'release']]
    cases.append(('journal-write-failure', 'queue'))
    for mode, role in cases:
        job = recovery.read_json(flow.path(job_id))
        job['phase'] = 'restored'
        recovery.save_json(flow.path(job_id), job)
        system.verify_writers(job, True)
        barrier.write_text(json.dumps({'container': next(item['id'] for item in job['writers'] if item['role'] == role)}))
        if marker.exists():
            marker.unlink()
        client = subprocess.Popen(['ssh', '-i', str(key), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + str(known_hosts), 'root@localhost', 'nhws-staging-recovery'], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        clients.append(client)
        client.stdin.write(json.dumps({'action': 'resume', 'jobId': job_id, 'actor': 'synthetic-survival-test', 'environment': 'staging', 'confirmation': 'RESUME DZDISTRO STAGING ' + job_id[:8], 'queuesReconciled': True}).encode())
        client.stdin.close()
        wait_for(marker.exists, 30)
        pending = recovery.read_json(flow.path(job_id))
        assert pending['phase'] == 'resuming' and pending['sessions']
        assert recovery.process_identity(pending['guard']['pid']) == pending['guard']
        blocked_pid = json.loads(marker.read_text())['pid']
        failed_journal = flow.path(job_id).with_suffix('.pending')
        if mode == 'hard-kill':
            os.kill(pending['process']['pid'], signal.SIGKILL)
        elif mode == 'SSH-disconnect':
            client.kill()
        else:
            failed_journal.symlink_to('/dev/full')
            settings = json.loads(barrier.read_text())
            settings['release'] = True
            barrier.write_text(json.dumps(settings))
        wait_for(lambda: all(item['paused'] for item in system.writers()))
        assert flow.owned_lock(job) is None and Path(config['proxyConfig']).exists()
        assert system.oid(recovery.DATABASE) == active_oid
        if mode != 'journal-write-failure':
            try:
                os.kill(blocked_pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        wait_for(lambda: recovery.process_identity(pending['process']['pid']) != pending['process'])
        if failed_journal.is_symlink():
            assert os.readlink(failed_journal) == '/dev/full'
            failed_journal.unlink()
        assert call('status')['phase'] == 'held'
        receipts.append({'mode': mode, 'afterUnpause': role, 'allFiveRolesPaused': True, 'activeOIDUnchanged': True, 'fenceAndLockRetained': True})
        print(json.dumps(receipts[-1]), flush=True)
        if client.poll() is None:
            client.kill()
        client.wait(timeout=10)
    job = recovery.read_json(flow.path(job_id))
    job['phase'] = 'restored'
    recovery.save_json(flow.path(job_id), job)
    barrier.unlink()
    marker.unlink(missing_ok=True)
    call('resume', 'RESUME DZDISTRO STAGING ' + job_id[:8], queuesReconciled=True)
    call('freeze-rollback', 'PAUSE DZDISTRO STAGING')
    call('rollback', 'ROLLBACK DZDISTRO STAGING ' + job_id[:8])
    call('resume', 'RESUME DZDISTRO STAGING ' + job_id[:8], queuesReconciled=True)
    assert system.sql('SELECT count(*) FROM documents', recovery.DATABASE) == '2'
    assert system.sql('SELECT sum(amount) FROM documents', recovery.DATABASE) == '300.00'
    print(json.dumps({'resume_survival': 'PASS', 'cases': len(receipts), 'scope': 'labelled synthetic Linux fixture; real SSH disconnect and SIGKILL; no live staging access'}))
finally:
    for client in clients:
        if client.poll() is None:
            client.kill()
        client.wait(timeout=10)
    shim.unlink()
    barrier.unlink(missing_ok=True)
    marker.unlink(missing_ok=True)
    key.unlink(missing_ok=True)
    known_hosts.unlink(missing_ok=True)
