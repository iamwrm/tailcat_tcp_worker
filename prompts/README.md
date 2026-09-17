# SSH setup prompts

1. [Build the credential ZIP](01-build-credential-zip.md) — use an agent with
   trusted SSH access to your server to create and authorize a dedicated key.
2. [Use the ZIP with local WASM SSH](02-web-agent-wasm-ssh.md) — upload the ZIP
   privately to a web agent and paste this prompt to test the connection.

Provide the target **hostname (or SSH alias)** and **SSH username** in both
prompts. If omitted, the agent asks for them. The SSH port defaults to `22`.
The setup agent locates the existing Tailcat address file or asks for its path.
For the web agent, the hostname labels the intended server; routing comes from
`tailcat-address.txt`, and `ssh-host-key.pub` verifies the server identity.

The ZIP contains three files at its root: `id_ed25519`, `tailcat-address.txt`,
and `ssh-host-key.pub`. It grants access to the target and must stay private.
See [the client documentation](../transport/README.md) for interactive shells,
SFTP transfers, proxy settings, and other commands.
