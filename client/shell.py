#!/usr/bin/env python3
"""Interactive SSH through Tailcat, using curl as the network transport.

Python's standard library handles terminal modes and WebSocket framing. Curl
performs TLS verification and carries all network traffic. No pip packages.
"""
import argparse
import base64
import getpass
import hashlib
import json
import os
from pathlib import Path
import select
import shutil
import signal
import struct
import subprocess
import sys
import termios
import time
import tty
from urllib.parse import urlparse


class CurlWebSocket:
    """Bounded RFC 6455 framing over curl's raw HTTP/1.1 Upgrade stream."""
    def __init__(self, origin):
        parsed = urlparse(origin)
        if parsed.scheme != 'https' or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/'):
            raise ValueError('URL must be an HTTPS origin without credentials or a path')
        curl = shutil.which('curl')
        if not curl:
            raise ValueError('curl is required')
        self.key = base64.b64encode(os.urandom(16)).decode()
        expected = hashlib.sha1((self.key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()
        self.accept = base64.b64encode(expected).decode()
        self.upgraded = self.closed = False
        self.outgoing = bytearray()
        self.incoming = bytearray()
        self.fragments = bytearray()
        self.fragment_opcode = None
        self.errors = bytearray()
        env = dict(os.environ)
        for name in ('TAILCAT_ADDR', 'TAILCAT_CLIENT_KEY'):
            env.pop(name, None)
        # No --max-time: older curl releases block stdin until that deadline.
        # The wrapper and Worker enforce their own deadlines instead.
        command = [curl, '--disable', '--http1.1', '--no-buffer', '--silent', '--show-error',
                   '--no-progress-meter', '--connect-timeout', '15', '--include',
                   '--suppress-connect-headers', '--request', 'GET',
                   '--header', 'Connection: Upgrade', '--header', 'Upgrade: websocket',
                   '--header', 'Sec-WebSocket-Version: 13', '--header', 'Sec-WebSocket-Key: ' + self.key,
                   '--header', 'Transfer-Encoding:', '--header', 'Expect:',
                   '--upload-file', '.', origin.rstrip('/') + '/api/shell']
        self.proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        for pipe in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            os.set_blocking(pipe.fileno(), False)

    def frame(self, opcode, data):
        if len(data) > 262144 or len(self.outgoing) > 524288:
            raise ValueError('Terminal send buffer is full')
        mask = os.urandom(4)
        header = bytes([0x80 | opcode])
        if len(data) < 126:
            header += bytes([0x80 | len(data)])
        elif len(data) < 65536:
            header += bytes([0x80 | 126]) + struct.pack('!H', len(data))
        else:
            header += bytes([0x80 | 127]) + struct.pack('!Q', len(data))
        self.outgoing.extend(header + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def send(self, value):
        self.frame(1, json.dumps(value, separators=(',', ':')).encode() + b'\n')

    def parse(self):
        events = []
        if not self.upgraded:
            at = self.incoming.find(b'\r\n\r\n')
            if at < 0:
                if len(self.incoming) > 16384:
                    raise ValueError('Oversized upgrade response')
                return events
            header = bytes(self.incoming[:at]).decode('iso-8859-1')
            del self.incoming[:at + 4]
            lines = header.split('\r\n')
            fields = dict((k.lower().strip(), v.strip()) for k, v in (line.split(':', 1) for line in lines[1:] if ':' in line))
            if len(lines[0].split()) < 2 or lines[0].split()[1] != '101':
                raise ValueError('Worker refused the WebSocket connection: ' + lines[0])
            if fields.get('sec-websocket-accept') != self.accept or fields.get('upgrade', '').lower() != 'websocket':
                raise ValueError('Invalid WebSocket upgrade response')
            self.upgraded = True
        while len(self.incoming) >= 2 and not self.closed:
            first, second = self.incoming[0:2]
            opcode, final = first & 15, bool(first & 128)
            if first & 0x70 or second & 128:
                raise ValueError('Invalid server WebSocket frame')
            length, offset = second & 127, 2
            if length == 126:
                if len(self.incoming) < 4:
                    break
                length, offset = struct.unpack('!H', self.incoming[2:4])[0], 4
            elif length == 127:
                if len(self.incoming) < 10:
                    break
                length, offset = struct.unpack('!Q', self.incoming[2:10])[0], 10
            if length > 262144 or (opcode >= 8 and (not final or length > 125)):
                raise ValueError('Oversized or invalid server frame')
            if len(self.incoming) < offset + length:
                break
            payload = bytes(self.incoming[offset:offset + length])
            del self.incoming[:offset + length]
            if opcode == 8:
                self.closed = True
                break
            if opcode == 9:
                self.frame(10, payload)
                continue
            if opcode == 10:
                continue
            if opcode == 1 and self.fragment_opcode is None:
                self.fragment_opcode = opcode
            elif opcode != 0 or self.fragment_opcode is None:
                raise ValueError('Unexpected server WebSocket frame')
            self.fragments.extend(payload)
            if len(self.fragments) > 262144:
                raise ValueError('Oversized server message')
            if final:
                message = bytes(self.fragments)
                self.fragments.clear()
                self.fragment_opcode = None
                self.send(dict(type='ack', bytes=len(message)))
                for line in message.decode().splitlines():
                    if line.strip():
                        events.append(json.loads(line))
        return events

    def pump(self, timeout=0.05):
        if self.closed:
            return []
        stdin, stdout, stderr = (p.fileno() for p in (self.proc.stdin, self.proc.stdout, self.proc.stderr))
        readable, writable, _ = select.select([stdout, stderr], [stdin] if self.outgoing and self.upgraded else [], [], timeout)
        events = []
        if stdout in readable:
            data = os.read(stdout, 65536)
            if data:
                self.incoming.extend(data)
                events = self.parse()
            else:
                self.closed = True
        if stderr in readable:
            self.errors.extend(os.read(stderr, 4096))
            del self.errors[:-4096]
        if stdin in writable and not self.closed:
            try:
                n = os.write(stdin, self.outgoing[:16384])
                del self.outgoing[:n]
            except BlockingIOError:
                pass
            except BrokenPipeError:
                self.closed = True
        return events

    def close(self):
        self.closed = True
        self.proc.stdin.close()
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        self.proc.stdout.close()
        self.proc.stderr.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='https://tailcat-ssh-worker.iamwrm.workers.dev')
    parser.add_argument('--user', default=getpass.getuser())
    parser.add_argument('--key', default='~/.ssh/id_ed25519')
    parser.add_argument('--host-key', default=os.environ.get('SSH_HOST_KEY'))
    parser.add_argument('--port', type=int, default=22)
    parser.add_argument('--timeout', type=int, default=1800, help='Session limit, 1–3600 seconds')
    parser.add_argument('--ask-passphrase', action='store_true')
    args = parser.parse_args()
    address = os.environ.get('TAILCAT_ADDR', '').strip()
    if not address or not args.host_key:
        parser.error('Set TAILCAT_ADDR and supply --host-key (or SSH_HOST_KEY).')
    if not 1 <= args.timeout <= 3600 or not 1 <= args.port <= 65535:
        parser.error('Invalid timeout or port')
    private_key = Path(args.key).expanduser().read_text()
    passphrase = getpass.getpass('SSH key passphrase: ') if args.ask_passphrase else ''
    terminal = os.open('/dev/tty', os.O_RDWR)
    settings = termios.tcgetattr(terminal)
    size = os.get_terminal_size(terminal)
    request = dict(tailcat_address=address, username=args.user, private_key=private_key,
                   host_key_sha256=args.host_key, port=args.port, timeout_seconds=args.timeout,
                   rows=max(1, size.lines), cols=max(1, size.columns), term=os.environ.get('TERM', 'xterm-256color'))
    if passphrase:
        request['passphrase'] = passphrase
    if os.environ.get('TAILCAT_CLIENT_KEY'):
        request['tailcat_client_key'] = os.environ['TAILCAT_CLIENT_KEY']
    ws = None
    resized = True
    def resize(*_):
        nonlocal resized
        resized = True
    def terminate(*_):
        raise KeyboardInterrupt
    original = {s: signal.getsignal(s) for s in (signal.SIGWINCH, signal.SIGTERM, signal.SIGHUP)}
    signal.signal(signal.SIGWINCH, resize)
    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGHUP, terminate)
    remote_exit = None
    try:
        os.write(terminal, b'Connecting through curl. Ctrl+] disconnects locally.\r\n')
        ws = CurlWebSocket(args.url)
        ws.send(request)
        request.clear()
        private_key = passphrase = address = ''
        tty.setraw(terminal)
        deadline = time.monotonic() + args.timeout + 15
        connected_by = time.monotonic() + 30
        running = False
        while not ws.closed:
            if time.monotonic() >= deadline or (not running and time.monotonic() > connected_by):
                raise TimeoutError('Session or connection timed out')
            for event in ws.pump():
                kind = event.get('type')
                if kind in ('stdout', 'stderr'):
                    view = memoryview(base64.b64decode(event['data'], validate=True))
                    while view:
                        view = view[os.write(terminal, view):]
                elif kind == 'status' and event.get('stage') == 'running':
                    running = True
                elif kind == 'exit':
                    remote_exit = event['code']
                elif kind == 'error':
                    os.write(terminal, ('\r\n' + str(event.get('message', 'Session failed')) + '\r\n').encode())
                    remote_exit = 1
            if remote_exit is not None:
                return remote_exit if 0 <= remote_exit <= 255 else 1
            if resized and running:
                resized = False
                size = os.get_terminal_size(terminal)
                ws.send(dict(type='resize', rows=max(1, size.lines), cols=max(1, size.columns)))
            if len(ws.outgoing) < 65536 and select.select([terminal], [], [], 0)[0]:
                data = os.read(terminal, 4096)
                if not data or b'\x1d' in data:
                    return 0
                if running:
                    ws.send(dict(type='input', data=base64.b64encode(data).decode()))
        message = next((line for line in ws.errors.decode(errors='replace').splitlines() if line.startswith('curl:')), 'Connection ended without a remote exit status')
        os.write(terminal, ('\r\n' + message + '\r\n').encode())
        return 1
    except KeyboardInterrupt:
        return 130
    finally:
        termios.tcsetattr(terminal, termios.TCSADRAIN, settings)
        if ws is not None:
            ws.close()
        for s, handler in original.items():
            signal.signal(s, handler)
        os.write(terminal, b'\r\nDisconnected.\r\n')
        os.close(terminal)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        print('Terminal connection failed: ' + str(exc), file=sys.stderr)
        sys.exit(1)
