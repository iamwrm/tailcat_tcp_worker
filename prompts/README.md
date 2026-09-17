# Prompts

1. [Create the ZIP](01-build-credential-zip.md) with an agent that has SSH access.
2. Upload the ZIP privately, then give a web agent the [SSH prompt](02-web-agent-wasm-ssh.md).

Supply the hostname or SSH alias and username. The agent asks if either is
missing. The SSH port defaults to 22.

The ZIP contains `id_ed25519`, `tailcat-address.txt`, and `ssh-host-key.pub`.
Keep it private. The Tailcat address selects the server; the host key verifies it.

See [usage](../transport/README.md) for SSH, file transfers, and proxy settings.
