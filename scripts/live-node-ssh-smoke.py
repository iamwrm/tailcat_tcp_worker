#!/usr/bin/env python3
"""Test Node-only SSH/SFTP/PTY and real rsync through an existing gateway.

Set TAILCAT_ADDR, SSH_USER, SSH_KEY and SSH_HOST_KEY first. Optional TAILCAT_URL
and SSH_KEY_PASSPHRASE are inherited. Creates and removes one remote /tmp tree.
Actual client processes get a PATH containing no ssh/scp executable.
Requires POSIX Python, Node, and rsync (the synchronization engine, not SSH).
"""
import datetime, fcntl, hashlib, json, os, re, select, shlex, shutil, signal
import struct, subprocess, tempfile, termios, time
from pathlib import Path

root = Path(__file__).resolve().parents[1]
node = shutil.which('node'); rsync = shutil.which('rsync')
if not node or not rsync:
    raise SystemExit('Install Node and rsync to run this integration test')
for name in ('TAILCAT_ADDR', 'SSH_USER', 'SSH_KEY', 'SSH_HOST_KEY'):
    if not os.environ.get(name): raise SystemExit('Set '+name)
cli = str(root / 'client/ssh.mjs')
report = {'verified_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'gateway': os.environ.get('TAILCAT_URL', 'https://tailcat-ssh-worker.iamwrm.workers.dev'),
          'ssh_executable_on_client_path': False, 'checks': {}}
remote_dir = None

def digest(data): return hashlib.sha256(data).hexdigest()

with tempfile.TemporaryDirectory(prefix='tailcat-node-ssh-') as temporary:
    local = Path(temporary); no_binaries = local/'empty-path'; no_binaries.mkdir()
    env = {**os.environ, 'PATH': str(no_binaries), 'TERM': 'xterm-256color'}
    assert shutil.which('ssh', path=env['PATH']) is None
    def run(args, expected=0, data=b'', override=None):
        p = subprocess.run([node, cli, *args], input=data, capture_output=True,
                           env={**env, **(override or {})}, timeout=75)
        if p.returncode != expected:
            raise RuntimeError(f'Node {args[0]} returned {p.returncode}: '+p.stderr.decode(errors='replace'))
        time.sleep(.3)
        return p
    def remote(command, expected=0): return run(['exec', '--timeout', '60', '--', command], expected)
    def pty_session(disconnect=False):
        master, slave = os.openpty()
        before = termios.tcgetattr(slave)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 90, 0, 0))
        process = subprocess.Popen([node, cli, 'shell', '--timeout', '60', *(['--ask-passphrase'] if os.environ.get('SSH_KEY_PASSPHRASE') and not disconnect else [])], stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
        output = bytearray()
        def pump():
            if select.select([master], [], [], .1)[0]:
                try: output.extend(os.read(master, 65536))
                except OSError: pass
        def until(predicate):
            deadline = time.monotonic()+25
            while not predicate():
                pump()
                if process.poll() is not None or time.monotonic()>deadline:
                    raise RuntimeError('PTY check failed: '+bytes(output[-1500:]).decode(errors='replace'))
        def text(): return bytes(output).replace(b'\r\n', b'\n').replace(b'\r', b'\n')
        try:
            if os.environ.get('SSH_KEY_PASSPHRASE') and not disconnect:
                until(lambda: b'SSH key passphrase: ' in text())
                os.write(master, os.environ['SSH_KEY_PASSPHRASE'].encode()+b'\r')
                until(lambda: b'SSH key passphrase: \n' in text())
            until(lambda: not termios.tcgetattr(slave)[3] & termios.ICANON)
            os.write(master, b"printf '\\nNODE_SHELL_READY\\n'\r")
            until(lambda: b'\nNODE_SHELL_READY\n' in text())
            if disconnect:
                os.write(master, b'\x1d'); expected=0
            else:
                os.write(master, b'stty size\r');until(lambda:b'\n30 90\n' in text())
                fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 42, 111, 0, 0));os.kill(process.pid, signal.SIGWINCH)
                time.sleep(.1);os.write(master,b'stty size\r');until(lambda:b'\n42 111\n' in text())
                os.write(master,b'sleep 10\r');time.sleep(.3);os.write(master,b'\x03')
                os.write(master,b"printf '\\nNODE_INTERRUPT_OK\\n'\r");until(lambda:b'\nNODE_INTERRUPT_OK\n' in text())
                os.write(master,b"printf '\\nNODE_HISTORY\\n'\r");until(lambda:text().count(b'\nNODE_HISTORY\n')==1)
                os.write(master,b'\x1b[A\r');until(lambda:text().count(b'\nNODE_HISTORY\n')==2)
                os.write(master,b'exit 7\r');expected=7
            deadline=time.monotonic()+15
            while process.poll() is None and time.monotonic()<deadline:pump()
            assert process.poll()==expected,(process.poll(),bytes(output[-1000:]))
            if os.environ.get('SSH_KEY_PASSPHRASE'):assert os.environ['SSH_KEY_PASSPHRASE'].encode() not in output,'Passphrase was echoed'
            after=termios.tcgetattr(slave)
            for index in (0,1,2):assert before[index]==after[index],('terminal flags',index)
            mask=termios.ICANON|termios.ECHO|termios.ISIG|termios.IEXTEN
            assert before[3]&mask==after[3]&mask,'terminal local flags'
        finally:
            if process.poll() is None:process.terminate();process.wait(timeout=10)
            os.close(master);os.close(slave)
        time.sleep(.3)
    try:
        p=remote("printf 'NODE_EXEC_OK\\n'; printf 'NODE_STDERR_OK\\n' >&2; exit 7",7)
        assert p.stdout==b'NODE_EXEC_OK\n' and p.stderr==b'NODE_STDERR_OK\n'
        report['checks']['exec_and_exit_status']=True
        wrong=run(['exec','--','printf MUST_NOT_RUN'],255,override={'SSH_HOST_KEY':'SHA256:'+'A'*43})
        assert b'host key mismatch' in wrong.stderr and not wrong.stdout
        report['checks']['host_key_rejected']=True
        remote_dir=remote('mktemp -d /tmp/tailcat-node-ssh-test.XXXXXX').stdout.decode().strip()
        assert re.fullmatch(r'/tmp/tailcat-node-ssh-test\.[A-Za-z0-9]+',remote_dir), 'Unexpected temporary directory'
        payload=os.urandom(20003);(local/'input file.bin').write_bytes(payload)
        run(['upload',str(local/'input file.bin'),remote_dir+'/file with spaces.bin'])
        run(['download',remote_dir+'/file with spaces.bin',str(local/'output.bin')])
        assert (local/'output.bin').read_bytes()==payload
        # Exercise atomic overwrite on real OpenSSH, including empty files.
        (local/'input file.bin').write_bytes(b'')
        run(['upload',str(local/'input file.bin'),remote_dir+'/file with spaces.bin'])
        run(['download',remote_dir+'/file with spaces.bin',str(local/'output.bin')])
        assert (local/'output.bin').read_bytes()==b''
        report['checks']['sftp_binary_and_atomic_overwrite']={'bytes':len(payload),'sha256':digest(payload),'empty_file':True}
        (local/'tree/sub').mkdir(parents=True);(local/'tree/sub/🐈 file.txt').write_text('recursive Unicode\n')
        run(['upload','--recursive',str(local/'tree'),remote_dir+'/tree'])
        run(['download','--recursive',remote_dir+'/tree',str(local/'tree-out')])
        assert (local/'tree-out/sub/🐈 file.txt').read_text()=='recursive Unicode\n'
        report['checks']['recursive_sftp']=True
        pty_session();pty_session(True)
        report['checks']['interactive_shell']={'ctrl_c':True,'arrow_history':True,'resize':'30x90 -> 42x111','exit_code':7,'local_disconnect':True,'terminal_restored':True,'passphrase_prompt_tested':bool(os.environ.get('SSH_KEY_PASSPHRASE'))}
        (local/'sync').mkdir();sync_data=os.urandom(24003);(local/'sync/data.bin').write_bytes(sync_data);(local/'sync/unchanged.txt').write_text('leave unchanged\n')
        rsh=shlex.quote(node)+' '+shlex.quote(cli)+' rsh'
        def synchronize(src,dst):
            p=subprocess.run([rsync,'-rt','--stats','-e',rsh,src,dst],capture_output=True,env=env,timeout=90)
            if p.returncode:raise RuntimeError('rsync failed: '+p.stderr.decode(errors='replace'))
            time.sleep(.3);return p.stdout.decode()
        target=os.environ['SSH_USER']+'@tailcat-target:'+remote_dir+'/sync/'
        synchronize(str(local/'sync')+'/',target)
        sync_data=b'changed'+sync_data[7:];p=local/'sync/data.bin';old=p.stat().st_mtime;p.write_bytes(sync_data);os.utime(p,(old+3,old+3))
        stats=synchronize(str(local/'sync')+'/',target)
        assert re.search(r'Number of (?:regular )?files transferred:\s*1\b',stats),stats
        (local/'sync-out').mkdir();synchronize(target,str(local/'sync-out')+'/')
        assert (local/'sync-out/data.bin').read_bytes()==sync_data
        assert (local/'sync-out/unchanged.txt').read_text()=='leave unchanged\n'
        report['checks']['rsync']={'upload':True,'download':True,'second_run_files_transferred':1,'sha256':digest(sync_data)}
        report['complete']=True
    finally:
        if remote_dir and re.fullmatch(r'/tmp/tailcat-node-ssh-test\.[A-Za-z0-9]+',remote_dir):
            remote('rm -rf -- '+shlex.quote(remote_dir));report['remote_temporary_files_removed']=True
    print(json.dumps(report,indent=2))
