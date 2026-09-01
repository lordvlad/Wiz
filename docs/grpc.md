# gRPC

A `.proto` file is a front end like any other: `wiz generate` reads it, builds
the same IR a TypeScript type or an OpenAPI document builds, and hands it to the
TypeScript client generator. What comes out is four files — types, operations, a
protobuf codec and an HTTP/2 transport — with no runtime dependency on
`@grpc/grpc-js`, protobufjs or a plugin. Reach for this when you have a `.proto`
and want a typed client you can read, not a code-generated wall of descriptors.

## Generating a client

```bash
wiz generate -g wiz/generators/tsClient.ts pets.proto --outdir src/api
```

The extension picks the front end: `.proto` is a gRPC service definition,
anything else is an API document. Reading from stdin there is no extension, so
the `syntax = "proto3"` line is the signal — a proto file must open with it.
Without `--outdir` the whole `{ filename: contents }` record is printed as JSON
instead of written. See [cli](./cli.md) for the rest of the flags.

Four files land in `src/api`:

| file | holds |
|---|---|
| `model.ts` | one `interface` per message, one numeric union per enum |
| `api.ts` | the `Client` interface, `createClient`, `configure`, the module-level functions, and the gRPC runtime |
| `codec.ts` | `encodeX`/`decodeX` per message, from the same protobuf codec `encodeProto` uses |
| `transport.ts` | `createHttp2Transport()`, and the only file that imports `node:http2` |

`codec.ts` and `transport.ts` are only emitted when the document actually
declares rpcs; an OpenAPI document produces `model.ts` and `api.ts` alone. The
split is deliberate. The codec is the one generated file with no types in it, it
is large, and a caller may well want to frame a message without going through a
method. The transport is separate so a browser bundle never sees `node:http2` —
`api.ts` is asserted not to mention it.

Names are fully qualified from the proto, with dots flattened, because two
packages may declare the same message:

```ts
// model.ts, from `package echo.v1; message Ping { string text = 1; int32 count = 2; }`
export interface echo_v1_Ping {
  text: string;
  count: number;
}
```

```ts
// codec.ts
export function encodeEcho_v1_Ping(value: echo_v1_Ping): Uint8Array;
export function decodeEcho_v1_Ping(bytes: Uint8Array): echo_v1_Ping;
```

## What the proto front end reads

The tokenizer and parser are hand-written rather than delegated to protobufjs.
This runs inside a build-time plugin, so a reflection library would become a
runtime dependency of every consumer, and the IR only cares about a fraction of
the grammar. protobufjs stays what it is best at here: an independent oracle in
the tests.

Messages, enums, `oneof`, `map`, `repeated`, `optional`, nested types and every
scalar width become IR. Doc comments become descriptions and reach `model.ts`.

```proto
syntax = "proto3";
package shapes.v1;

import "google/protobuf/timestamp.proto";

enum Kind {
  KIND_UNSPECIFIED = 0;
  CIRCLE = 1;
}

message Shape {
  message Style { string color = 1; }
  string id = 1;
  Kind kind = 2;
  Style style = 3;
  repeated string tags = 4;
  optional int32 sides = 5;
  map<string, string> labels = 6;
  google.protobuf.Timestamp at = 7;
  oneof body {
    string text = 8;
    bytes blob = 9;
  }
}
```

```ts
export type shapes_v1_Kind = 0 | 1;

export interface shapes_v1_Shape_Style {
  color: string;
}

export interface google_protobuf_Timestamp {
  seconds: bigint;
  nanos: number;
}

export interface shapes_v1_Shape {
  id: string;
  kind: shapes_v1_Kind;
  style: shapes_v1_Shape_Style;
  tags: string[];
  sides?: number;
  labels: Record<string, string>;
  at: google_protobuf_Timestamp;
  body?: string | Uint8Array;
}
```

A `oneof` is one optional property holding a union, with the variants' field
numbers carried beside it — exactly what `NumberedUnion` produces on the
TypeScript side, so the protobuf back end reads both the same way (see
[protobuf](./protobuf.md)). The member names have nowhere to live in a union and
are dropped, as they are for a `NumberedUnion`.

### Scalars

Each proto numeric name is narrower than the JS type that carries it, and that
narrowing is what a `format` constraint says — the same registry value the
validator and the protobuf codec already read, documented in
[annotations](./annotations.md).

| proto | TypeScript | `@format` |
|---|---|---|
| `double` | `number` | *(none — a JS number already is one)* |
| `float` | `number` | `float` |
| `int32` / `uint32` / `sint32` | `number` | `int32` / `uint32` / `sint32` |
| `fixed32` / `sfixed32` | `number` | `fixed32` / `sfixed32` |
| `int64` / `uint64` / `sint64` | `bigint` | `int64` / `uint64` / `sint64` |
| `fixed64` / `sfixed64` | `bigint` | `fixed64` / `sfixed64` |
| `bool` | `boolean` | — |
| `string` | `string` | — |
| `bytes` | `Uint8Array` | — |

The 64-bit widths land on `bigint` because a `number` cannot hold them exactly.

### proto2

`syntax = "proto2"` is a diagnostic — the file is parsed best-effort as proto3 —
but the two proto2 constructs that carry meaning are not dropped. `required` is
presence stated the other way round, so it lands as a non-optional field, and
`[default = X]` lands in the slot the IR already had for a default:

```proto
syntax = "proto2";
message M {
  required string a = 1;
  optional int32 b = 2 [default = 7];
}
```

`a` is non-optional, `b` is optional with `default: 7`, and `syntax` is the only
diagnostic.

### Imports

`extractProtoIRFromFile` follows imports depth-first, resolving each against the
file that wrote it, and every message in the closure becomes referable. A cycle
is legal in proto, so the walk is guarded rather than reported. A file that is
not there is a diagnostic, not a failure: the rest of the document still
generates and references into the missing file are carried as `unknown`.

`extractProtoIR`, which takes text, cannot follow anything — there is no base
path to resolve against — so every non-well-known import is a diagnostic there.

### Well-known types

`google.protobuf.Timestamp`, `Duration`, `Empty`, `FieldMask` and the nine
wrappers are synthesised as the messages the spec defines, declared lazily the
first time something references them. No import is needed for the synthesis to
happen; a file that imports `timestamp.proto` and never mentions a `Timestamp`
declares nothing. A package that declares its own `Timestamp` keeps it: a user
declaration always wins over a well-known name.

They are real messages rather than primitives because of a wire bug. A
`Timestamp` used to collapse to the `date` primitive, which reads nicely and is
wrong: on the wire a `Timestamp` is a message of `int64 seconds = 1` and
`int32 nanos = 2`, so a `date` was written as a bare varint — and every other
implementation skipped the field as unknown. Silently, since skipping an unknown
field is legal. The bug was invisible to a round-trip test, because wiz read
back what wiz wrote. It is visible the moment protobufjs holds the real
descriptor: the generated codec's bytes for `{ id: "e1", at: { seconds:
1700000000n, nanos: 123000000 } }` are now compared byte for byte against
protobufjs's, and protobufjs decodes them to the same value.

`Any` and `Struct` are not synthesised. They carry meaning in the runtime rather
than in their fields, so they stay diagnosed rather than pretending to be a
`type_url` and a `bytes`.

### What becomes a diagnostic

A diagnostic is a fact about the output, not a failure: `wiz generate` prints
each one to stderr — so stdout stays one JSON value — and still writes the
files. `extractProtoIR(text, { strict: true })` throws on the first one instead.

| keyword | why |
|---|---|
| `extend` | the IR has no slot for a field added from outside its message |
| `group` | dropped proto2 group; declare it as a nested message instead |
| `reserved`, `extensions` | the IR records the fields a message has, not the numbers it may not use |
| `syntax` | anything but `proto3`; parsed best-effort as proto3 |
| `type` | an unresolved name, or an unmapped well-known type; the field is carried as `unknown` |
| `rpc` | a request or response that is an enum, a scalar or unresolved — none of which is addressable on the wire |
| `import` | a file that is not there, or any import at all under `extractProtoIR` |
| `duplicate` | the same fully qualified name declared twice |

Options, enum-value options, `public`/`weak` import modifiers and enum member
comments are consumed and dropped without a diagnostic: they either belong to a
descriptor compiler or have no slot in the IR by design.

```bash
$ wiz generate -g wiz/generators/tsClient.ts odd.proto --outdir out
wiz generate: dropped 'reserved' at M: dropped 'reserved'; the IR records the fields a message has, not the numbers it may not use
wiz generate: dropped 'extend' at odd.proto: dropped 'extend'; the IR has no slot for a field added from outside its message
  out/model.ts
  out/api.ts
  out/codec.ts
  out/transport.ts
```

## The four directions

Each `rpc` becomes a method addressed by package, service and name; the
transport puts `/echo.v1.Echo/Unary` on the wire and nothing else varies, which
is why the three parts are held apart in the IR rather than pre-joined. The
`stream` keyword on each side decides the method's shape:

| rpc | signature |
|---|---|
| `rpc Unary (Ping) returns (Pong)` | `(request, options?) => Promise<Pong>` |
| `rpc Down (Ping) returns (stream Pong)` | `(request, options?) => AsyncIterable<Pong>` |
| `rpc Up (stream Ping) returns (Pong)` | `(requests, options?) => Promise<Pong>` |
| `rpc Both (stream Ping) returns (stream Pong)` | `(requests, options?) => AsyncIterable<Pong>` |

Given `test/fixtures/echo.proto`, which declares all four against an
`@grpc/grpc-js` server that answers `pong:<text>` unary, `<text>#<n>` downstream,
the joined texts upstream and `re:<text>` bidirectionally:

```ts
import { configure, unary, down, up, both } from "./api.ts";
import { createHttp2Transport } from "./transport.ts";

configure({
  baseUrl: `http://127.0.0.1:${port}`,
  transport: createHttp2Transport(),
});

// unary — one to one
await unary({ text: "hi", count: 0 });
// → { text: "pong:hi" }

// server streaming — one to many
const ticks: string[] = [];
for await (const pong of down({ text: "tick", count: 3 })) ticks.push(pong.text);
// → ["tick#0", "tick#1", "tick#2"]

async function* pings() {
  yield { text: "a", count: 0 };
  yield { text: "b", count: 0 };
  yield { text: "c", count: 0 };
}

// client streaming — many to one
await up(pings());
// → { text: "a,b,c" }

// bidirectional — many to many, interleaved
const echoes: string[] = [];
for await (const pong of both(pings())) echoes.push(pong.text);
// → ["re:a", "re:b", "re:c"]
```

Every operation is reachable two ways: as a module-level function driven by
`configure()`, as above, or through `createClient(overrides)` when one process
talks to several deployments. Both run the same interceptor chain and share the
same `Call` type as the HTTP half — see
[typescript-client](./typescript-client.md).

Underneath, all four directions are one transport call: a path, headers and a
stream of encoded messages in; response headers, a stream of encoded messages
and trailers out. A unary request is passed as a plain array rather than a
generator, so an interceptor that calls `next` twice sends the same message
again instead of an empty stream.

## Two transports, because two environments

`transport` on the config decides how a call travels. The default is gRPC-Web
over `fetch`, because that is what runs everywhere including a browser.

```ts
createClient({ baseUrl: "https://grpc.example" });                      // gRPC-Web
createClient({ baseUrl: "https://grpc.example", transport: createHttp2Transport() });
```

**gRPC-Web over `fetch`** sends one complete framed body and reads the status
out of a trailer frame at the end of the response body, or out of the headers
when the server failed before producing anything. It needs a proxy — Envoy,
`grpcwebproxy`, Connect — in front of a gRPC server, because a gRPC server
speaks HTTP/2 trailers and `fetch` cannot read them. It carries unary and
server streaming only. A call that streams requests over it fails with
`UNIMPLEMENTED` naming the fix rather than hanging:

```ts
const failure = await client.up(pings()).catch((error) => error);
// GrpcError, code 12
// "the configured transport cannot stream requests; use createHttp2Transport()"
```

That refusal lives in the call, not in the generated method, because a client
can be reconfigured onto the HTTP/2 transport and the same method then works.

**`createHttp2Transport()`** speaks gRPC proper over `node:http2`: real HTTP/2,
real trailers, `te: trailers` on the way out, and a request body that stays
open — which is what makes client and bidirectional streaming possible at all.
Writing runs alongside reading, so a duplex call is one call rather than a send
followed by a receive.

It takes no URL. The origin comes off each call, so the client's `baseUrl` stays
the only place a URL is written, and one transport serves several of them with
one pooled HTTP/2 session each:

```ts
const transport = createHttp2Transport();

const here = createClient({ baseUrl: `http://127.0.0.1:${a}`, transport });
const there = createClient({ baseUrl: `http://127.0.0.1:${b}`, transport });

await here.unary({ text: "first", count: 0 });   // → { text: "pong:first" }
await there.unary({ text: "second", count: 0 }); // → { text: "pong:second" }

transport.close(); // closes every pooled session; a process that exits need not
```

A session is reopened when it goes away, and an idle session's error is caught
rather than left to take the process down. Because HTTP/2 multiplexes, five
concurrent unary calls to one origin share one connection — which is the whole
reason gRPC uses HTTP/2: a stream is cheap, a connection is not.
`Http2TransportOptions.session` is passed straight to `http2.connect`, so TLS is
whatever the runtime offers: a CA bundle or a client certificate, and no
per-call credentials.

`transport.duplex` reports which kind you have: `false` for gRPC-Web, `true` for
HTTP/2.

## Deadlines and cancellation

Every call takes a second argument, the same shape an HTTP call takes plus the
metadata a gRPC call carries:

```ts
interface GrpcCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
}
```

`timeoutMs` is sent as `grpc-timeout: <ms>m` so the server can stop early, and
enforced locally as well — a server that ignores it cannot hang the caller.
`timeoutMs` on `configure()` or `createClient()` is the default for every call.
Against an rpc that never answers:

```ts
const failure = await never({ text: "wait", count: 0 }, { timeoutMs: 150 })
  .catch((error) => error);
// GrpcError, code 4, details "deadline exceeded"
```

`signal` cancels. Over HTTP/2 that resets the stream with `NGHTTP2_CANCEL`:

```ts
const controller = new AbortController();
const pending = never({ text: "wait", count: 0 }, { signal: controller.signal });
controller.abort();
await pending; // throws GrpcError, code 1, details "cancelled"
```

An abort that happens before the listener is attached still lands: the signal is
read as well as listened to.

## Compression

`gzip` and `deflate` are the registered gRPC encodings a browser can also
perform, through `CompressionStream`, so one emitted client compresses the same
way in Bun, Node, Deno and a browser. zstd is not a registered gRPC encoding and
`snappy` is not something the web streams do, so both are refused rather than
guessed at.

```ts
const client = createClient({ baseUrl, transport, compression: "gzip" });
```

That sets `grpc-encoding: gzip` on outgoing calls. Compression is per message by
design — bit 0 of each frame's flag byte says whether that frame's payload used
the encoding the headers named — so a stream may mix compressed and plain
frames. Both directions are covered independently: every call advertises
`grpc-accept-encoding: gzip, deflate, identity` whatever `compression` is set
to, so a server may compress its replies even when the client sends plain, and
the reply is decompressed with whatever `grpc-encoding` the server named. A
frame flagged compressed when nothing was announced is refused, rather than
handed to the codec as garbage:

```ts
// server sent a compressed frame with no grpc-encoding header
// GrpcError, code 12: "the server compressed with 'identity', which this client cannot read"
```

Against a grpc-js server configured with gzip replies, a 480-byte request and
its replies both survive the trip in either direction, and `deflate` likewise.

## Metadata

Outgoing metadata is `options.headers` per call, or an interceptor for the
ambient case — a token belongs in one function, not in every callsite:

```ts
const bearer = <R>(call: Call, next: (call: Call) => R): R =>
  next({ ...call, headers: { ...call.headers, authorization: `Bearer ${token}` } });

configure({ interceptors: { grpc: [bearer] } });
```

Trailing metadata comes back off the *result*, not off the call. A gRPC
interceptor is handed a result whose messages have not arrived yet, because a
stream has no single moment of arrival, so `headers` and `trailers` are promises
on it:

```ts
const seen: Array<Record<string, string>> = [];

const client = createClient({
  baseUrl,
  transport,
  interceptors: {
    grpc: [
      (call, next) => {
        const result = next(call);
        void result.trailers.then((trailers) => seen.push(trailers)).catch(() => {});
        return result;
      },
    ],
  },
});

await client.unary({ text: "watched", count: 0 });
await Promise.resolve(); // the callback is a microtask behind the call
seen[0];
// → { "grpc-status": "0", "grpc-message": "OK", "x-request-id": "req-42" }
```

The trailer block is kept whole, status included: what a server puts beside
`grpc-status` — error details, a retry hint, a request id — is the caller's
business. A transport with nowhere to put trailers resolves the promise empty
rather than never. Attach a `catch` to either promise: a failed call rejects
both, and the error itself travels through `messages`.

## `GrpcError`

```ts
class GrpcError extends Error {
  readonly code: number;      // the canonical numeric status
  readonly details: string;   // grpc-message, percent-decoded
  readonly metadata: Record<string, string>; // the trailing metadata, whole
}
```

A server's status passes through numerically with the metadata it arrived with:

```ts
const failure = await unary({ text: "boom", count: 0 }).catch((error) => error);
failure.code;                       // 3 — INVALID_ARGUMENT, what the server said
failure.details;                    // "no booms here"
failure.metadata["x-retry-after"];  // "5"
failure.metadata["x-request-id"];   // "req-42"
```

Note that `metadata["grpc-message"]` is the raw percent-encoded header —
`no%20booms%20here` — while `details` is decoded. The metadata is what arrived,
not a tidied version of it.

The codes the client raises on its own behalf, as opposed to relaying:

| code | raised when |
|---|---|
| 1 `CANCELLED` | the caller's `AbortSignal` fired |
| 2 `UNKNOWN` | the server answered a non-200 HTTP status, sent no gRPC status at all, or the request stream threw while being written |
| 4 `DEADLINE_EXCEEDED` | `timeoutMs` passed locally |
| 12 `UNIMPLEMENTED` | the transport cannot stream requests, or the server compressed with an encoding this client cannot read |
| 13 `INTERNAL` | a unary or client-streaming call ended with no response message |

Over gRPC-Web an HTTP failure that carries no `grpc-status` at all surfaces as
`ApiError` instead, with the response body kept — that is where a proxy
explains itself, and it is not speaking gRPC when it does.

## Verification

The wire format is checked against implementations nobody here wrote, because
round-tripping wiz against itself proves nothing: a codec wrong in both
directions round-trips perfectly. Two independent oracles do the work.

protobufjs parses the same `.proto` and is compared against the extractor's
output — the same set of messages under the same fully qualified names, the same
field numbers, the same repeated and map flags, the same streaming flags and
payload types per rpc. Then it reads what the generated codec writes and writes
what it reads, including the `Timestamp` case above.

`@grpc/grpc-js` runs a real server on a real HTTP/2 port, and the generated
client is generated, written to a temp directory, imported and driven against
it: all four streaming directions, a server-side `INVALID_ARGUMENT` with its
details, a deadline expiring as code 4, an `AbortSignal` cancelling as code 1,
five concurrent calls over one pooled connection, one transport serving two
origins, trailing metadata read through an interceptor and off a failure, and
`gzip` and `deflate` in both directions. Framing, trailers, stream lifetimes and
status codes are only proven by talking to an implementation that was written by
someone else. The emitted `api.ts` and `transport.ts` are also compiled under
`strict` TypeScript and must produce no diagnostics.

More on the approach, and the bugs it caught, in
[verification](./verification.md).

## Limitations

What a client built on `@grpc/grpc-js` gives you that this does not.

| | wiz | notes |
|---|---|---|
| Unary and all three streaming directions | yes, over HTTP/2 | gRPC-Web carries unary and server streaming only |
| Deadlines, cancellation | yes | `timeoutMs` and `AbortSignal` per call, or a default on the client |
| Wire format | verified | checked byte for byte against protobufjs, both directions |
| Metadata | headers plus trailing metadata | not a typed `Metadata` object, and binary (`-bin`) values are not base64-decoded |
| Retries, hedging | writable, not built in | no policy, no backoff, no hedging |
| Load balancing, name resolution, channel state | no | one session per origin, pooled; no resolver and no channel state to read |
| TLS and credentials | the runtime's | `http2.connect` options are passed through; no per-call credentials |
| Compression | `gzip`, `deflate` | per message, both directions, via `CompressionStream`; verified against grpc-js. `snappy` and zstd are not offered |
| Interceptors | a chain, both protocols | `(call, next) => result`, nested outermost first. No per-method interception |
| Reflection, health checking | no | generate a client from their own `.proto` like any other service |
| Well-known types | `Timestamp`, `Duration`, `Empty`, `FieldMask`, the nine wrappers | `Any` and `Struct` stay diagnosed |

The reasoning behind the four that most often matter:

**Retries are writable but not built in.** An interceptor may call `next` again,
and the pieces needed for that to work are in place: a unary request is a
re-iterable array, so the second attempt sends the same message rather than an
exhausted generator, and a failure arrives as a throw from `messages`, which an
interceptor can catch by wrapping the stream. What is missing is the policy —
which codes to retry, how long to back off, whether to hedge. That is a
retry-policy engine, and writing one nobody configured would be a framework the
consumer did not ask for. A client-streaming retry is the caller's problem
either way: an `AsyncIterable` the caller supplied may not be re-iterable.

**No load balancing, name resolution or channel state.** The transport keeps one
HTTP/2 session per origin and reopens it when it goes away. There is no
resolver, no subchannel list, no `connectivityState` to watch and no way to ask
it to reconnect. A single origin behind a load balancer is the deployment this
suits; a client-side round-robin over a resolved set of backends is not
something it can do.

**No per-method interception.** The chain is per client and runs for every call.
An interceptor that only wants one method has to check `call.url`, which ends
`/package.Service/Method`. This is the shape that lets one interceptor serve
both protocols, which was worth more than a routing table nobody would have
configured either.

**Binary metadata is not decoded.** gRPC's convention is that a `-bin` key
carries base64. The trailers are handed over as the string map that arrived, so
`grpc-status-details-bin` — where a server puts a `google.rpc.Status` with real
error details — is a base64 string you decode yourself. Decoding it properly
would mean carrying a `google.protobuf.Any` implementation, which is the same
type that stays diagnosed in the front end, for the same reason.

Two smaller ones. An unresolved message on either side of an `rpc` still emits
the method, as a stub that throws naming the reason, rather than letting it
vanish from the client silently. And a `.proto` file's package is the only
identity on offer — there is no `info` block — so the generated banner names the
package where an OpenAPI document would name its title.
