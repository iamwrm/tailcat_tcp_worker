# Third-party software

- [Tailcat](https://github.com/tailscale/tailcat), copyright Tailscale Inc and contributors,
  BSD-3-Clause. Pinned source: `79dc7eff30d78fbe9a2c69c725eb05c82d0d542d`.
  Its license is reproduced in `TAILCAT-LICENSE`.
- [Go](https://go.dev/), copyright The Go Authors, BSD-style license reproduced
  in `GO-LICENSE`. `worker/src/generated/go-runtime.js` is derived from Go 1.27.1's
  `wasm_exec.js`; the build script records the small scoping adaptations.
- [golang.org/x/crypto](https://pkg.go.dev/golang.org/x/crypto), Go Authors,
  BSD-3-Clause, including the SSH implementation.
- [Tailscale](https://github.com/tailscale/tailscale), Tailscale Inc and contributors,
  BSD-3-Clause, and the networking and cryptography dependencies listed in `worker/go.mod`.
- [gVisor](https://gvisor.dev/), Google LLC and contributors, Apache-2.0,
  license reproduced in `GVISOR-LICENSE`. During the build a private copy of the
  pinned dependency receives the additional method in `scripts/gonet-drain.go.txt`
  to wait for TCP shutdown acknowledgement; the shared module cache is unchanged.
- Cloudflare's Wrangler, Miniflare, and workerd are used as build/test tools.

The dependency graph and exact versions are recorded in `worker/go.mod`, `worker/go.sum`, and
`package-lock.json`. This prototype is independent and is not an official Tailscale
or Cloudflare product.
