# TCP transport v1

`GET /v1/transport` with a WebSocket Upgrade. One WebSocket carries one TCP
connection to a port exposed by a Tailcat server. There are no SSH fields,
application adapters, accounts, cookies, API tokens, or uploaded executable code.

Both peers set `binaryType = 'arraybuffer'`. Control messages are UTF-8 JSON text;
DATA messages are binary and contain only unmodified TCP bytes. WebSocket message
boundaries have no application meaning. No multiplexing or UDP in version 1.

## Handshake

The gateway sends `{"type":"hello","version":1}` immediately. Within 10 seconds,
the client sends:

```json
{
  "type": "open",
  "version": 1,
  "target": {"type": "tailcat", "address": "tc…", "port": 22},
  "timeout_seconds": 1800
}
```

`client_key` is an optional Tailcat node private identity for restricted servers.
The address is a credential, sent in the first encrypted WebSocket message. Never
put it in a URL. Target ports must be integers 1–65535; the target Tailcat server
must expose the port. Clients cannot provide relay URLs or full embedded-relay
addresses. All other open fields are rejected. Control messages are at most 8192
JavaScript string code units; addresses at most 4096 ASCII characters.

After connecting, the gateway sends:

```json
{"type":"opened","version":1,"window":65536,"max_frame":16384}
```

The client must wait for `opened` before sending data or FIN. `reset` is also
accepted while connecting. Setup has a 20-second deadline; the total lifetime
includes setup, defaults to 1800 seconds and can be set to 1–3600 seconds.

## Bidirectional flow control

Each direction starts with 65,536 bytes of credit. Each binary message contains
1–16,384 bytes and consumes that many bytes of the sender's credit. A receiver
returns credit only after consuming the bytes:

```json
{"type":"window_update","bytes":16384}
```

Credit must be a positive integer no larger than the amount outstanding. The
Worker returns input credit after writing to TCP. The SDK returns output credit
when the caller advances its async iterator past the previous chunk. Consumers
must finish processing a chunk before advancing. Await each SDK write; concurrent
writes are rejected. Only one reader is supported per SDK connection.

Credit updates may combine multiple consumed chunks. The Worker and SDK flush
at 32 KiB or on a 1 ms timer; the SDK still never acknowledges a chunk held by
its caller. The Worker coalesces output into frames up to 16 KiB. Partial frames
use a 1 ms flush timer, while replies of 256 bytes or less bypass that timer when
there is no buffered output. FIN always flushes pending bytes first. Timers may
run later if the event loop is busy. These are implementation choices, not new
protocol requirements; clients must not depend on message boundaries.

A nonreading client is disconnected if outstanding output receives no credit for
30 seconds. The protocol has no total byte cap, but all streams remain subject to
session lifetime, provider resource limits and relay limits. A single connection
retains at most one 64 KiB upload credit window plus bounded TCP/relay buffers;
output reserves a 64 KiB credit window across sent and buffered bytes, plus one
Go read chunk waiting for credit. Fixed 16 KiB buffers are reused by the bridge.

## Closing

`{"type":"fin"}` means this sender has no more data. It half-closes that TCP
direction. The other direction remains usable. A second FIN or data after FIN
is a protocol error. Both sides must send FIN for normal completion.

After both directions end and TCP acknowledges the gateway's final write/FIN,
the gateway sends `{"type":"closed"}` and closes the WebSocket normally. The
final TCP acknowledgement has a 10-second drain deadline within the total lifetime.
The build includes a small addition to pinned gVisor's `gonet.TCPConn` to observe
this acknowledgement before destroying the entire Wasm network stack.

`{"type":"reset"}` cancels the connection immediately. Disconnects, protocol
errors and deadlines also cancel it. An error is:

```json
{"type":"error","code":"busy","message":"This isolate is busy; retry shortly"}
```

Other codes include `protocol_error`, `open_timeout`, `timeout`,
`consumer_timeout`, `invalid_tailcat_address`, `embedded_relay_not_allowed`,
`invalid_client_key`, `tailcat_connection_failed`, `tcp_io_failed`,
`tcp_drain_failed`, and `runtime_failed`. A disconnect without `closed` is an
incomplete stream. Never replay application bytes automatically after a failure.

## Deployment policy

One active Go/Tailcat runtime per Worker isolate. Additional streams reaching
that isolate receive `busy`; there is no
queue or connection pooling. This prototype is therefore not suitable for an
application requiring a reliable pool of concurrent database connections.
The deployment also limits approximately 20 new requests/minute per client IP
per Cloudflare location. Origin-bearing requests must match the gateway origin;
CLI clients need not send an Origin header. These are admission limits, not
website login or application authentication. An admission reservation expires after
15 seconds without renewal if its owning request is terminated by the platform.

Live native SSH, HTTP and 256 KiB binary echo tests passed. A 17 MiB stress test
exceeded the current Free deployment CPU limit; high-throughput operation needs
more capacity. No paid-plan change has been made.

## Trust boundary

The Worker handles the Tailcat address and optional Tailcat identity in memory.
Application authentication and encryption belong to the client tool and target
service. Native SSH keeps its private key local and verifies the remote server;
TLS clients should use the intended server name and verify its certificate.
Plain TCP application data is visible to the Worker. No new application-specific
Worker code or deployment is needed for tools using this protocol.
