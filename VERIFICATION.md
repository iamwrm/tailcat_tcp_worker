# Verification

The implementation was exercised in Cloudflare's local workerd runtime and on a
Cloudflare Workers Free deployment. Tests use generated SSH keys and synthetic
protocol services; the fixture never runs client-supplied OS commands.

## Local checks

```sh
npm ci
npm run build
npm run check -- --outdir .wrangler/build
npm test
```

The 35 integration cases cover legacy SSH exec and PTY operation, authentication
and host-key rejection, Unicode, resize and Ctrl+C, deadlines and cleanup, binary
TCP (17,891,328-byte echo with matching hash), both TCP half-close directions,
flow-control limits, malformed messages, native OpenSSH, local HTTP forwarding,
admission reservation while a connection is idle, Node SSH with separate stdout/
stderr and exit status, binary backpressure, host verification before user
authentication, PTY resizing, encrypted SSH keys, SFTP file/tree copies and
cleanup, and Node exec/rsync adapters with no SSH executable on PATH.

Half-close testing caught a shutdown race: destroying the network stack immediately
after CloseWrite could discard queued bytes. The build adds the reviewed method
in `scripts/gonet-drain.go.txt` to a private copy of pinned gVisor so shutdown waits
for TCP acknowledgement. The shared Go module cache remains unchanged.

## Node-only client live verification

The new client tools were tested through the existing deployed Worker against a
real Ubuntu OpenSSH server. **The Worker was not redeployed.** Test processes used
a PATH without `ssh` or `scp`; Node and rsync were invoked by absolute path.

- Executed a command, preserved separate stdout/stderr, and returned exit code 7.
- Rejected a mismatched host key.
- Used an encrypted temporary SSH key, including a hidden terminal passphrase
  prompt; the passphrase was checked not to appear in captured terminal output.
- Round-tripped 20,003 random bytes using SFTP and checked exact contents.
- Atomically replaced an existing remote file with an empty file; verified the
  result by downloading over an existing local file.
- Recursively copied a directory containing a Unicode filename in both directions.
- Opened a real PTY, resized 30×90 to 42×111, used Ctrl+C and arrow history,
  returned exit code 7, disconnected with Ctrl+], and checked local terminal
  flags were restored after both sessions.
- Used actual rsync over the Node remote-shell adapter to upload and download a
  directory. A second upload transferred only the changed file; the downloaded
  result matched its SHA256 and the unchanged file remained intact.
- Removed the remote temporary directory and generated SSH key authorization;
  restored the original authorized_keys exactly. No existing personal SSH key
  was uploaded to the Worker.

To reproduce with your own credentials and an SSH server with SFTP and rsync:

```sh
# Set TAILCAT_ADDR, SSH_USER, SSH_KEY and SSH_HOST_KEY first.
# Set SSH_KEY_PASSPHRASE if the key is encrypted.
python3 scripts/live-node-ssh-smoke.py
```

The live harness needs POSIX Python, Node and rsync. It creates a temporary
remote /tmp directory and cleans it up. It does not configure authorization or
read existing personal SSH keys itself; the Node client reads the key you select.

## Deployment observations

Live tests passed for native OpenSSH with host verification and a real remote PTY,
HTTP, both half-close directions, a 256 KiB binary echo, and the legacy curl shell
with resizing, Ctrl+C and 35 seconds idle followed by more input. Temporary SSH
authorizations used for the real-host test were removed afterward.

A sustained 17 MiB transfer exceeded the Free deployment's CPU limit. A legacy
HTTP `/api/exec` check also returned Cloudflare error 1102 (CPU limit). These routes
pass locally, but local success does not establish production CPU capacity.
Native SSH and the Node SSH client over `/v1/transport` are live-tested command paths. This is a light-use
prototype, with one active runtime per Worker isolate, not a throughput or
concurrency guarantee. No paid-plan change was made.

See the live smoke scripts in `scripts/` and protocol details in `PROTOCOL.md`.
