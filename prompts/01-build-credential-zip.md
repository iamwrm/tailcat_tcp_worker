# Build the credential ZIP

Provide your hostname and SSH username, then paste this into an agent with
trusted SSH access. This prompt authorizes adding one dedicated public key.

```text
Create a private credential ZIP for local Tailcat WASM SSH.
Hostname or SSH alias: <HOSTNAME>
SSH username: <USERNAME>
SSH destination port: <PORT, default 22>
Repository: https://github.com/iamwrm/tailcat_wasm
Ask me for any missing hostname or username; never guess or use placeholders.

1. Connect to my hostname as my supplied username using existing trusted
   SSH access. Keep host verification enabled. If the server is not already
   trusted, ask me for a trusted host key; do not trust ssh-keyscan alone.

2. Create a private staging directory (700) outside the repository.
   Generate a fresh Ed25519 key named id_ed25519, without a passphrase,
   for unattended use, with a unique key comment. Never reuse, replace,
   or print an existing private key.

3. Append the new public key to the supplied user's authorized_keys file.
   Preserve existing entries/options, avoid duplicates, and use correct
   ownership and permissions (.ssh 700, authorized_keys 600). Do not change
   sshd configuration, other accounts, or other access settings.

4. Locate this host's existing Tailcat service and its short address file;
   ask me for the file location if it cannot be identified. Read it privately
   into tailcat-address.txt. Obtain the active SSH server's host public key
   over the trusted connection and save it as ssh-host-key.pub.
   Confirm Tailcat exposes my requested SSH port. If the service or address
   is unavailable, report the prerequisite instead of creating a new service.

5. Clone/update the repository; run npm ci --omit=dev and npm run check.
   Substitute my username, port, and staging path safely in this command:
   node apps/ssh.mjs exec --credentials-dir PRIVATE_DIR \
     --user USERNAME --port PORT --timeout 60 -- 'hostname; id'
   Keep host-key/TLS verification enabled; enforce a 75-second outer timeout.

6. After success, create a mode-600 ZIP outside the repository in my private
   output directory; do not overwrite an existing ZIP. Include exactly these
   root entries: id_ed25519, tailcat-address.txt, ssh-host-key.pub.
   Verify names/contents without printing secrets, then remove staging copies.

7. Report the ZIP path, supplied hostname/username/port, actual remote
   hostname, sanitized test result, and new key comment/public fingerprint
   for later revocation. Never commit or publicly upload the ZIP or secrets.
   The ZIP contains unencrypted credentials; I will upload it privately.
```
