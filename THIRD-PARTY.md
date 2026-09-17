# Third-party software

- [Tailcat](https://github.com/tailscale/tailcat), copyright Tailscale Inc and contributors,
  BSD-3-Clause. Pinned source: `79dc7eff30d78fbe9a2c69c725eb05c82d0d542d`.
  Its license is reproduced in `TAILCAT-LICENSE`.
- [Go](https://go.dev/), copyright The Go Authors, BSD-style license reproduced
  in `GO-LICENSE`. `transport/dist/go-runtime.js` is derived from Go 1.27.1's
  `wasm_exec.js`; the build script records the small scoping adaptations.
  The same runtime and compiled transport are distributed in `transport/dist/`;
  the root license files also apply to those prebuilt artifacts.
- [golang.org/x/crypto](https://pkg.go.dev/golang.org/x/crypto), Go Authors,
  BSD-3-Clause. Its SSH implementation is used by the Go test fixture.
- [Tailscale](https://github.com/tailscale/tailscale), Tailscale Inc and contributors,
  BSD-3-Clause, and the networking and cryptography dependencies listed in `transport/go/go.mod`.
- [gVisor](https://gvisor.dev/), Google LLC and contributors, Apache-2.0,
  license reproduced in `GVISOR-LICENSE`. During the build a private copy of the
  pinned dependency receives the additional method in `scripts/gonet-drain.go.txt`
  to wait for TCP shutdown acknowledgement; the shared module cache is unchanged.
- [ssh2](https://github.com/mscdex/ssh2), Brian White and contributors, MIT,
  pinned in `package-lock.json`. Used only by the Node SSH/SFTP client tools.
  Its copyright and license accompany the installed package.
- [Undici](https://github.com/nodejs/undici), MIT, pinned in `package-lock.json`.
  The local WASM client uses its Fetch, WebSocket, and environment-proxy support.
  Its copyright and license accompany the installed package.

The dependency graph and exact versions are recorded in `transport/go/go.mod`, `transport/go/go.sum`, and
`package-lock.json`. This prototype is independent and is not an official Tailscale
product.
