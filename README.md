# Local Tailcat WASM SSH

SSH commands, interactive terminals, and SFTP file transfers through Tailcat,
running entirely in a local Node.js process. The transport is Go WebAssembly;
SSH is handled locally by `ssh2`. No native `ssh` or `tailcat` executable,
TUN device, netlink access, or hosted gateway is required.

```text
Local application → Tailcat WASM → DERP WebSocket → remote Tailcat → sshd
```

## Quick start

Use Node.js 22.15 or newer. Obtain the Tailcat address, SSH private key, and
trusted server host public key through a secure channel. Put them in a private
directory as `tailcat-address.txt`, `id_ed25519`, and `ssh-host-key.pub`.

```sh
npm ci --omit=dev
npm run check
node apps/ssh.mjs exec \
  --credentials-dir /private/credentials \
  --user wr --timeout 60 -- 'hostname; id; uname -a'
```

Host-key and TLS verification are mandatory. The private SSH key stays in the
local SSH adapter. The bundled relay map avoids a bootstrap fetch; HTTPS/WSS
uses the existing proxy and trusted-CA configuration.

```sh
node apps/ssh.mjs shell --credentials-dir /private/credentials --user wr
node apps/ssh.mjs upload --credentials-dir /private/credentials --user wr ./file.txt /tmp/file.txt
node apps/ssh.mjs download --credentials-dir /private/credentials --user wr /tmp/file.txt ./file.txt
```

SFTP needs no local `scp` or `sftp`. The `rsh` adapter supports rsync with rsync
installed locally and remotely. Other applications can use the local TCP SDK.

- [Usage, configuration, and generic TCP SDK](transport/README.md)
- [SSH/SFTP and rsync details](apps/README.md)
- [Credential ZIP setup and web-agent SSH prompts](prompts/README.md)
- [Validation results](transport/VALIDATION.md)
- [Local transport contract](PROTOCOL.md)

## Development

```sh
npm ci
npm run build
npm test
npm run check
```

Builds and integration tests require Go; normal use runs the checked-in WASM
artifact. The build pins Go 1.27.1 and all dependencies.

- `transport/`: TCP SDK, WASM runtime, Go source, build tooling, and transport tests.
- `apps/`: SSH entry point, interactive shell, SFTP and rsync adapters, and application tests.
- `scripts/`: Go build tags and the TCP shutdown patch.
- `prompts/`: credential setup and web-agent SSH instructions.

The Cloudflare implementation and deployment tooling have been removed. This
repository has one runtime path: local WASM. Its GitHub repository name remains
`tailcat_tcp_worker`.
