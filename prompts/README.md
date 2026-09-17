# SSH setup prompts

1. [Build the credential ZIP](01-build-credential-zip.md) — use an agent with
   trusted SSH access to your server to create and authorize a dedicated key.
2. [Use the ZIP with local WASM SSH](02-web-agent-wasm-ssh.md) — upload the ZIP
   privately to a web agent and paste this prompt to test the connection.

Both prompts default to user `wr`, port `22`; the setup prompt targets
`ubuntu-n150-1`. Edit those settings for another server. The existing address
file path is a server-side location, not a Cloudflare dependency.

The ZIP contains three files at its root: `id_ed25519`, `tailcat-address.txt`,
and `ssh-host-key.pub`. It grants access to the target and must stay private.
See [the client documentation](../transport/README.md) for interactive shells,
SFTP transfers, proxy settings, and other commands.
