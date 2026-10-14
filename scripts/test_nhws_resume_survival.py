"""Linux-only destructive fault rehearsal, restricted to the labelled local fixture."""
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import subprocess
import sys
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
effect = Path('/run/nhws-recovery-fixture-effect')
fault = Path('/run/nhws-recovery-fixture-fault')
shim.write_text('''#!/usr/bin/python3
import json,sys,subprocess,time,os
from pathlib import Path
p=Path('/run/nhws-recovery-fixture-barrier.json')
def block(c):
  Path('/run/nhws-recovery-fixture-marker.json').write_text(json.dumps({'pid':os.getpid()}))
  deadline=time.monotonic()+60
  while time.monotonic()<deadline:
   if json.loads(p.read_text()).get('release'):
    return
   time.sleep(.05)
c=json.loads(p.read_text()) if p.exists() else {}
if len(sys.argv)==3 and sys.argv[2]==c.get('container') and sys.argv[1]==c.get('fault'):
 try:
  descriptor=os.open('/run/nhws-recovery-fixture-fault',os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
  os.close(descriptor)
  sys.stderr.write('Injected one-shot Docker containment failure')
  sys.exit(1)
 except FileExistsError: pass
matched=len(sys.argv)==3 and sys.argv[1]=='unpause' and sys.argv[2]==c.get('container')
if matched and c['when']=='before': block(c)
code=subprocess.run([REAL_DOCKER,*sys.argv[1:]]).returncode
if matched and code==0: Path('/run/nhws-recovery-fixture-effect').touch()
if matched and c['when']=='after': block(c)
if matched and json.loads(p.read_text()).get('fail'):
 sys.stderr.write('Injected synthetic unpause failure')
 sys.exit(1)
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
    cases = [(mode, role, when) for mode in ['hard-kill', 'SSH-disconnect'] for role in ['web', 'queue', 'scheduler', 'pulse', 'release'] for when in ['before', 'after']]
    cases.append(('journal-write-failure', 'queue', 'after'))
    cases.extend((mode, 'queue', 'after') for mode in ['transient-inspect', 'transient-pause', 'late-effect'])
    for mode, role, when in cases:
        job = recovery.read_json(flow.path(job_id))
        previous_guard = job.get('guard')
        with flow.transition(job):
            job['phase'] = 'restored'
            recovery.save_json(flow.path(job_id), job)
        if previous_guard:
            wait_for(lambda: recovery.process_identity(previous_guard['pid']) != previous_guard)
        system.verify_writers(job, True)
        selected = next(item['id'] for item in job['writers'] if item['role'] == role)
        settings = {'container': selected, 'when': when}
        if mode.startswith('transient-'):
            settings['fault'] = mode.removeprefix('transient-')
        barrier.write_text(json.dumps(settings))
        effect.unlink(missing_ok=True)
        fault.unlink(missing_ok=True)
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
        if mode in {'hard-kill', 'transient-inspect', 'transient-pause', 'late-effect'}:
            os.kill(pending['process']['pid'], signal.SIGKILL)
        elif mode == 'SSH-disconnect':
            client.kill()
        elif mode == 'journal-write-failure':
            failed_journal.symlink_to('/dev/full')
        settings = json.loads(barrier.read_text())
        settings['release'] = True
        settings['fail'] = mode == 'journal-write-failure'
        barrier.write_text(json.dumps(settings))
        wait_for(effect.exists)
        wait_for(lambda: all(item['paused'] for item in system.writers()))
        if mode.startswith('transient-'):
            assert fault.exists()
        if mode == 'late-effect':
            wait_for(lambda: call('status')['phase'] == 'held')
            subprocess.run([real_docker, 'unpause', selected], check=True, stdout=subprocess.DEVNULL)
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
        wait_for(lambda: call('status')['phase'] == 'held')
        receipts.append({'mode': mode, 'role': role, 'barrier': when, 'delayedEffectCompleted': True, 'allFiveRolesPaused': True, 'activeOIDUnchanged': True, 'fenceAndLockRetained': True})
        print(json.dumps(receipts[-1]), flush=True)
        if client.poll() is None:
            client.kill()
        client.wait(timeout=10)
    job = recovery.read_json(flow.path(job_id))
    previous_guard = job['guard']
    with flow.transition(job):
        job['phase'] = 'restored'
        recovery.save_json(flow.path(job_id), job)
    wait_for(lambda: recovery.process_identity(previous_guard['pid']) != previous_guard)
    barrier.unlink()
    marker.unlink(missing_ok=True)
    effect.unlink(missing_ok=True)
    fault.unlink(missing_ok=True)
    socket_marker = Path('/run/nhws-recovery-fixture-empty-socket')
    socket_marker.unlink(missing_ok=True)
    socket_child = '''import importlib.util,sys,time
from pathlib import Path
spec=importlib.util.spec_from_file_location('r','/usr/local/libexec/nhweb-backups/staging_recovery.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
c=r.load_config(r.CONFIG_PATH);s=r.System(c);w=r.Workflow(c,s)
original=r.socket.socket
counter=[0]
class Socket(original):
 def connect(self,address):
  super().connect(address)
  self.guard=isinstance(address,str) and address.endswith('.guard.sock')
 def sendall(self,data):
  if getattr(self,'guard',False):
   counter[0]+=1
   if counter[0]==2:
    Path('/run/nhws-recovery-fixture-empty-socket').touch()
    time.sleep(60)
  return super().sendall(data)
r.socket.socket=Socket
w.handle({'action':'resume','jobId':sys.argv[1],'actor':'synthetic-empty-socket','environment':'staging','confirmation':'RESUME DZDISTRO STAGING '+sys.argv[1][:8],'queuesReconciled':True})
'''
    empty_worker = subprocess.Popen([sys.executable, '-c', socket_child, job_id], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    wait_for(socket_marker.exists, 30)
    assert not next(item['paused'] for item in system.writers() if item['role'] == 'web')
    empty_pending = recovery.read_json(flow.path(job_id))
    empty_worker.kill()
    empty_worker.wait(timeout=10)
    wait_for(lambda: call('status')['phase'] == 'held' and all(item['paused'] for item in system.writers()))
    assert recovery.process_identity(empty_pending['guard']['pid']) == empty_pending['guard']
    flow.owned_lock(empty_pending)
    assert Path(config['proxyConfig']).exists()
    receipts.append({'ownerDeathAfterSocketConnectBeforeSend': True, 'webUnpauseProven': True, 'guardSurvives': True, 'allFiveRolesPaused': True, 'protectionsRetained': True})
    print(json.dumps(receipts[-1]), flush=True)
    job = recovery.read_json(flow.path(job_id))
    previous_guard = job['guard']
    with flow.transition(job):
        job['phase'] = 'restored'
        recovery.save_json(flow.path(job_id), job)
    wait_for(lambda: recovery.process_identity(previous_guard['pid']) != previous_guard)
    socket_marker.unlink()
    child_code = '''import importlib.util,json,subprocess,sys,time
from pathlib import Path
spec=importlib.util.spec_from_file_location('r','/usr/local/libexec/nhweb-backups/staging_recovery.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
c=r.load_config(r.CONFIG_PATH);s=r.System(c);w=r.Workflow(c,s)
sentinel=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'])
identity=r.process_identity(sentinel.pid)
r.ssh_sessions=lambda:[identity]
original=s.check_guard
counter=[0]
mode=sys.argv[2]
def check(job):
 counter[0]+=1
 if counter[0]!=7: return original(job)
 if mode=='commit-wins': original(job)
 Path('/run/nhws-recovery-fixture-commit.json').write_text(json.dumps({'sessionPID':sentinel.pid}))
 deadline=time.monotonic()+30
 while not Path('/run/nhws-recovery-fixture-commit-release').exists():
  assert time.monotonic()<deadline
  time.sleep(.05)
 if mode=='containment-wins': original(job)
s.check_guard=check
try:
 w.handle({'action':'resume','jobId':sys.argv[1],'actor':'synthetic-interleaving','environment':'staging','confirmation':'RESUME DZDISTRO STAGING '+sys.argv[1][:8],'queuesReconciled':True})
finally:
 sentinel.terminate();sentinel.wait()
'''
    commit_marker = Path('/run/nhws-recovery-fixture-commit.json')
    commit_release = Path('/run/nhws-recovery-fixture-commit-release')
    for mode in ['containment-wins', 'commit-wins']:
        if mode == 'commit-wins':
            job = recovery.read_json(flow.path(job_id))
            previous_guard = job['guard']
            with flow.transition(job):
                job['phase'] = 'restored'
                recovery.save_json(flow.path(job_id), job)
            wait_for(lambda: recovery.process_identity(previous_guard['pid']) != previous_guard)
        commit_marker.unlink(missing_ok=True)
        commit_release.unlink(missing_ok=True)
        process = subprocess.Popen([sys.executable, '-c', child_code, job_id, mode], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        wait_for(commit_marker.exists, 30)
        os.kill(json.loads(commit_marker.read_text())['sessionPID'], signal.SIGKILL)
        commit_release.touch()
        process.wait(timeout=30)
        current = call('status')
        if mode == 'containment-wins':
            wait_for(lambda: call('status')['phase'] == 'held')
            assert all(item['paused'] for item in system.writers()) and recovery.ROLLOUT_LOCK.exists() and Path(config['proxyConfig']).exists()
        else:
            assert process.returncode == 0 and current['phase'] == 'resumed'
            wait_for(lambda: recovery.process_identity(current['guard']['pid']) != current['guard'])
            assert not any(item['paused'] for item in system.writers()) and not recovery.ROLLOUT_LOCK.exists() and not Path(config['proxyConfig']).exists()
        receipts.append({'interleaving': mode, 'terminalStateAndProtectionsCoherent': True})
        print(json.dumps(receipts[-1]), flush=True)
    commit_marker.unlink(missing_ok=True)
    commit_release.unlink(missing_ok=True)
    call('freeze-rollback', 'PAUSE DZDISTRO STAGING')
    call('rollback', 'ROLLBACK DZDISTRO STAGING ' + job_id[:8])
    call('resume', 'RESUME DZDISTRO STAGING ' + job_id[:8], queuesReconciled=True)
    assert system.sql('SELECT count(*) FROM public.documents', recovery.DATABASE) == '2'
    assert system.sql('SELECT sum(amount) FROM public.documents', recovery.DATABASE) == '300.00'
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
