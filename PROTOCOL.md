# Local TCP transport contract

`openTcp(options)` in `transport/transport-client.mjs` starts a private Node
thread running Tailcat WebAssembly and opens a TCP port exposed by the remote
Tailcat server. This is an in-process SDK, not a hosted HTTP/WebSocket API.

## Application interface

- `await openTcp({ address, port, timeout, signal, ... })` waits until TCP opens.
- `await tcp.write(Uint8Array)` writes bytes with bounded backpressure. Await
  each write before starting another or calling `end()`.
- `for await (const bytes of tcp)` reads ordered byte chunks. One reader is
  permitted; chunk boundaries have no application meaning.
- `tcp.end()` half-closes the write direction while reads continue.
- `await tcp.closed` waits for both directions to finish or rejects on failure.
- `tcp.close()` cancels the transport and terminates its local thread.

SSH credentials stay with the application adapter. Only the Tailcat address,
optional client identity, target port, timeout and relay settings enter WASM.
Short PSK-bearing Tailcat addresses are required. Ports are 1–65535. The total
session timeout is 1–3600 seconds, default 1800; it includes startup. Startup
allows 30 seconds for relay connection/ping, 40 for dialing, and 45 overall,
subject to any shorter caller timeout. Abort signals stop the local thread.

## Internal flow control

Parent and runtime exchange structured-clone messages through a local
`MessagePort`. Each direction has a 65,536-byte window and a maximum data
chunk of 16,384 bytes. Upload credit returns after Go consumes input; download
credit returns when the application advances its iterator past a chunk.

The runtime announces `opened`, sends `data` byte arrays, replenishes upload
credit with `window_update`, and emits `fin`, `closed`, or a sanitized `error`.
The parent sends `data`, `ack`, and `fin`. Runtime output batches into 16 KiB
chunks with a 1 ms flush; replies up to 256 bytes can send immediately. Input
acknowledgements batch at half a window or on a 1 ms timer. Pending output is
flushed before FIN. Thirty seconds without output credit aborts a stalled peer.

Each stream has independent state and memory bounds. The two TCP directions
can half-close independently. SSH is an application adapter on top of this
transport; the same byte API supports other TCP protocols.
