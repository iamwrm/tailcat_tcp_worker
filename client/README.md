# Client tools

Run these from the repository root. Node.js 22.15+ is required. The application adapter uses the pinned `ssh2` package over the local WASM transport:

```sh
npm ci --omit=dev
export TAILCAT_ADDR='tc…'
export SSH_USER='your-user'
export SSH_KEY="$HOME/.ssh/id_ed25519"
export SSH_HOST_KEY='SHA256:trusted-server-fingerprint'
```

Obtain the fingerprint through a trusted channel, for example on the target:
`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256`. Supply the actual
fingerprint, not the placeholder above. The private key and its passphrase remain
local. Host-key verification is mandatory and happens before user authentication.
The target still needs an SSH server; file copies also need its SFTP subsystem.

## SSH commands and interactive shells

These commands do not invoke a local `ssh` executable:

```sh
node wasm_client/ssh.mjs exec -- 'uname -a && uptime'
node wasm_client/ssh.mjs shell
```

`exec` forwards stdin, stdout and stderr as binary streams and returns the remote
exit code. A connection failure or missing SSH exit status returns 255. Signals
return conventional 128+signal statuses. Diagnostics go to stderr only.

`shell` allocates a remote PTY and forwards terminal resizing. Ctrl+C interrupts
the remote foreground job; Ctrl+] disconnects locally. Terminal mode is restored
on normal exits, connection errors and handled termination signals.

For an encrypted key, add `--ask-passphrase` before `--` or positional arguments.
The prompt requires a terminal. Noninteractive clients can provide
`SSH_KEY_PASSPHRASE` in their process environment instead. Passphrases are never
command-line arguments.

Options `--user`, `--key` and `--host-key` override the corresponding environment
variables. `--port` defaults to 22;
`--timeout` defaults to 1800 seconds, maximum 3600. `TAILCAT_CLIENT_KEY` is optional
for a Tailcat server that restricts client identities.

The Node client uses explicit credentials and a fingerprint. It does not read
OpenSSH's `~/.ssh/config`, `known_hosts`, or agent settings.

## File copies without scp

Uploads and downloads use SFTP; neither `scp` nor `sftp` needs to be installed on
the client. These are file-copy operations, not the legacy SCP wire protocol or a
complete clone of scp's command-line syntax.

```sh
node wasm_client/ssh.mjs upload './local file.txt' '/tmp/remote file.txt'
node wasm_client/ssh.mjs download '/tmp/remote file.txt' './downloaded file.txt'
node wasm_client/ssh.mjs upload --recursive ./project /tmp/project-copy
node wasm_client/ssh.mjs download --recursive /tmp/project-copy ./downloaded-project
```

Destinations are **exact paths**, including directory copies. Their parent
must exist. A recursive directory copy creates the destination directory and
copies its contents; it does not add another source-basename directory. There
is no wildcard or `~` expansion. Relative remote paths resolve from the SSH
account's SFTP starting directory.

Regular files and directories are supported. Symbolic links and special files
are rejected. Permission bits are copied, excluding special bits; ownership,
ACLs and timestamps are not preserved. Existing regular files may be replaced.
Each file streams through a random temporary sibling and is renamed on success;
a failed whole-tree copy may leave already completed files. Cleanup of incomplete
temporary files is best-effort if the connection is lost. Atomic replacement of
an existing remote file needs the OpenSSH POSIX-rename extension; older servers
may reject replacement instead of risking deletion of the destination.

## Real rsync without a local SSH executable

Install **rsync locally and on the server**. The Node program supplies SSH; rsync
still provides synchronization, delta transfer, metadata and its own options.

```sh
rsync -rt --stats \
  -e 'node wasm_client/ssh.mjs rsh' \
  ./source/ "$SSH_USER@target:/tmp/destination/"

rsync -rt \
  -e 'node wasm_client/ssh.mjs rsh' \
  "$SSH_USER@target:/tmp/destination/" ./download/
```

`target` is a label: **TAILCAT_ADDR chooses the server**, and SSH_HOST_KEY verifies
it. The adapter accepts rsync's `-l USER` argument and forwards its remote command
using OpenSSH-compatible argument joining. The command stream never allocates a
PTY, and stdout contains only remote bytes. Use absolute paths to Node and
`wasm_client/ssh.mjs` in `-e` if rsync starts from another directory.

## Application SDK

Application code can import `connectSSH` and `runCommand` from `ssh-client.mjs`,
and `copyFiles` from `sftp.mjs`. `connectSSH` opens a local WASM transport by
default; a caller may provide an `openTcp` implementation for another adapter.
Always close the returned SSH session in `finally`.

For file-based credential loading, diagnostics, and generic TCP use, see
[the local WASM documentation](../wasm_client/README.md).
