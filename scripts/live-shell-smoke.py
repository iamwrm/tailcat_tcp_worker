#!/usr/bin/env python3
"""Exercise the real curl WebSocket transport with ephemeral fixture credentials."""
import base64
import json
from pathlib import Path
import os
import runpy
import select
import subprocess
import time

root = Path(__file__).resolve().parents[1] / 'worker'
CurlWebSocket = runpy.run_path(str(root.parent / 'client/shell.py'))['CurlWebSocket']
(root / 'test/.tmp').mkdir(parents=True, exist_ok=True)
subprocess.run(['go', 'build', '-o', 'test/.tmp/fixture', './test/fixture'], cwd=root,
               env={**os.environ, 'GOTOOLCHAIN': 'go1.27.1'}, check=True)
fixture = subprocess.Popen([str(root / 'test/.tmp/fixture')], env={**os.environ, 'PUBLIC_DERP': '1', 'TS_DEBUG_USE_DERP_HTTP': 'false'}, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
ws = None
try:
    if not select.select([fixture.stdout], [], [], 45)[0]:
        raise TimeoutError('Fixture startup')
    credentials = json.loads(fixture.stdout.readline())
    request = {k: v for k, v in credentials.items() if k not in ('command', 'host_key_public', 'wrong_private_key', 'map_url', 'stats_url')}
    request.update(rows=30, cols=90, timeout_seconds=90)
    origin = 'https://tailcat-ssh-worker.iamwrm.workers.dev'
    ws = CurlWebSocket(origin)
    ws.send(request)
    output = ''
    events = []
    started = time.monotonic()
    def until(predicate, timeout=20):
        global output
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() > deadline or ws.closed:
                raise RuntimeError('Terminal timed out/closed; events=' + json.dumps(events[-5:]) + '; output=' + output[-1000:])
            for event in ws.pump():
                events.append(event)
                if event.get('type') in ('stdout', 'stderr'):
                    output += base64.b64decode(event['data']).decode()
                if event.get('type') == 'error':
                    raise RuntimeError(event['message'])
    def send(value):
        ws.send(dict(type='input', data=base64.b64encode(value).decode()))
    until(lambda: 'PTY ready:30x90' in output)
    print('Live curl received the PTY prompt', flush=True)
    send(b'typed live\n')
    until(lambda: 'echo:typed live' in output)
    ws.send(dict(type='resize', rows=40, cols=120))
    until(lambda: 'resize:40x120' in output)
    send(b'\x03')
    until(lambda: 'interrupted' in output)
    # Prove this is a live session beyond waitUntil's post-response grace period.
    idle_until = time.monotonic() + 35
    while time.monotonic() < idle_until:
        ws.pump(0.1)
        if ws.closed:
            raise RuntimeError('Connection closed during idle interval')
    send(b'after idle\n')
    until(lambda: 'echo:after idle' in output)
    send(b'exit\n')
    until(lambda: any(e.get('type') == 'exit' for e in events))
    assert next(e['code'] for e in events if e.get('type') == 'exit') == 0
    print(json.dumps(dict(origin=origin, elapsed_seconds=round(time.monotonic()-started, 2), output=output, exit_code=0, idle_35_seconds=True), indent=2))
finally:
    if ws:
        ws.close()
    fixture.terminate()
    fixture.wait(timeout=10)
