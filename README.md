# wiz

Compile-time type introspection for Bun. Your TypeScript types stay types — wiz
reads them during transpilation and replaces the call with generated code.

```ts
import { keysOf, schema, is } from "wiz";

type User = { id: string; name: string };

keysOf<User>();        // → ["id", "name"]
is<User>(input);       // → a real structural check, inlined at the callsite
schema<User>();        // → a JSON Schema document
```

There is no runtime reflection, no decorator, and no separate schema to keep in
sync. The type is the source of truth, and it costs nothing at runtime because
nothing of it survives to runtime.

## Install

```bash
bun add wiz
bunx wiz init
```

`wiz init` writes a `wizPlugin.ts` preload and points `bunfig.toml` at it, for
both `bun run` and `bun test`. It is safe to re-run: existing config is merged,
not replaced, and comments survive. `--force` replaces an existing
`wizPlugin.ts` instead of leaving it alone.

To do it by hand instead:

```ts
// wizPlugin.ts
import { plugin } from "bun";
import { wizPlugin } from "wiz/plugin";

plugin(wizPlugin());
```

```toml
# bunfig.toml
preload = ["./wizPlugin.ts"]

[test]
preload = ["./wizPlugin.ts"]
```

Both entries matter: `bun run` reads the root table and `bun test` reads
`[test]`, and neither implies the other.

For a build, pass the plugin directly:

```ts
await Bun.build({
  entrypoints: ["./src/app.ts"],
  plugins: [wizPlugin()],
});
```

The plugin rewrites modules as they are loaded, so the calls must live in a
module imported *after* it is registered — which is what the preload is for.

Called without the plugin active, every helper throws `PluginInactiveError`
rather than returning something plausible.

`wizPlugin({ logger })` takes a `WizLogger`; the default forwards `info`/`warn`
/`error` to the console and drops `trace`. `silentLogger` and `consoleLogger`
are exported for tests.

## What it generates

| Call | Produces |
|---|---|
| `keysOf<T>()` | `(keyof T)[]` |
| `requiredKeysOf<T>()` / `optionalKeysOf<T>()` | the split |
| `schema<T>(version?)` | JSON Schema, `draft-2020-12` or `draft-07` |
| `validate<T>(value)` | `ValidationError[]` with paths |
| `is<T>(value)` | `value is T` — narrows, without building the error list |
| `openapiSchema<[A, B]>(base?, ops?)` | an OpenAPI 3.0 or 3.1 document |
| `protobufSchema<[A, B]>()` / `encodeProto` / `decodeProto` | `.proto` text and a binary codec |
| `avroSchema<[A, B]>()` / `encodeAvro` / `decodeAvro` | `.avsc` text and a binary codec |

Identical types share one generated module, so `is<User>(a)` in two files
imports the same function.

`is` is a type predicate, so it narrows:

```ts
function nameOf(value: unknown): string {
  if (is<User>(value)) return value.name; // value is User here
  return "anonymous";
}
```

## Describing types

wiz reads JSDoc. Tags fall into three channels that do different jobs.

**Constraints** narrow the set of valid values and are enforced by the
generated validator: `@min`/`@minimum`, `@max`/`@maximum`,
`@exclusiveMinimum`, `@exclusiveMaximum`, `@minLength`, `@maxLength`,
`@pattern`, `@format`, `@multipleOf`, `@minItems`, `@maxItems`,
`@uniqueItems`.

**Annotations** describe without validating: the doc comment becomes
`description`, plus `@example` (repeatable), `@default` and `@deprecated`.

**Everything else** is preserved verbatim in `meta` — `@since`, `@author`, your
own tags — and is deliberately not emitted into any document.

```ts
interface User {
  /**
   * The account holder's e-mail.
   * @format email
   * @example "ada@example.com"
   */
  email: string;

  /**
   * @minimum 0
   * @maximum 150
   */
  age?: number;

  /** @deprecated Use `email` instead. */
  oldEmail?: string;
}
```

### `@format` picks the wire type

One annotation drives the JSON Schema format, the OpenAPI format, the protobuf
field type, the Avro type and the Arrow column. The values are the OpenAPI
Format Registry's, so there is nothing wiz-specific to learn.

| `@format` | on | proto | Avro | Arrow | JSON Schema |
|---|---|---|---|---|---|
| *(none)* | `number` | `double` | `double` | `Float64` | `number` |
| `int8` / `int16` | `number` | `int32` | `int` | `Int8` / `Int16` | `number` + bounds |
| `uint8` / `uint16` | `number` | `uint32` | `int` | `Uint8` / `Uint16` | `number` + bounds |
| `int32` | `number` | `int32` | `int` | `Int32` | `number` + bounds |
| `uint32` | `number` | `uint32` | `long` | `Uint32` | `number` + bounds |
| `int64` | `bigint` | `int64` | `long` | `Int64` | `string` + pattern |
| `uint64` | `bigint` | `uint64` | `long` | `Uint64` | `string` + pattern |
| `sint32` / `sint64` | `number` / `bigint` | zig-zag varint | `int` / `long` | `Int32` / `Int64` | + bounds |
| `fixed32` / `sfixed32` | `number` | 4 bytes | `int` | `Uint32` / `Int32` | + bounds |
| `fixed64` / `sfixed64` | `bigint` | 8 bytes | `long` | `Uint64` / `Int64` | `string` + pattern |
| `double-int` | `number` | `int64` | `long` | `Int64` | `number` + bounds |
| `unixtime` | `number` | `int64` | `long` | `Int64` | `number` + bounds |
| `sf-integer` / `sf-decimal` | `number` | `int64` / `double` | `long` / `double` | `Int64` / `Float64` | `number` |
| `float` | `number` | `float` | `float` | `Float32` | `number` + `float` |
| `uuid` | `string` | `string` | `{string, uuid}` | `Utf8` | `string` + `uuid` |
| `date` / `time` | `string` | `string` | `{int, date}` / `{int, time-millis}` | `Utf8` | `string` + format |
| `date-time` | `string` | `string` | `{long, timestamp-millis}` | `Utf8` | `string` + format |
| `byte` / `binary` | `string` | `string` | `bytes` | `Binary` | `string` + format |

A plain `number` is a `double`, because in JavaScript it is one. Opt into a
compact integer with `@format int32`.

**A width is a range, and the range is enforced.** `@format int32` with
`3000000000` is rejected by `validate`/`is` rather than wrapped to
`-1294967296` by the codec, and the JSON Schema and OpenAPI output carry the
matching `minimum`/`maximum` so any other validator agrees. A fractional value
fails an integer width for the same reason, as does a `number` beyond 2^53 —
past that the value is already wrong, whatever the width permits.

Widths narrower than 32 bits are native columns in Arrow, and travel in the
smallest type protobuf and Avro have, since neither has an 8- or 16-bit
integer. Nothing widens silently, because the declared range is checked first.

A `bigint` is described as a *string* in JSON Schema, with a digits pattern:
JSON numbers are doubles, so precision above 2^53 dies on the way out, and
`JSON.stringify` refuses a BigInt outright. The binary codecs carry the full
64 bits. Bounds that a JSON number cannot state exactly are omitted rather
than rounded, since an approximate bound admits or rejects the wrong values.

`Uint8Array` and `Date` need no annotation — they are scalars everywhere:

| type | proto | Avro | Arrow | JSON Schema |
|---|---|---|---|---|
| `Uint8Array` | `bytes` | `bytes` | `Binary` | `string`, base64 |
| `Date` | `int64` | `{long, timestamp-millis}` | `Timestamp<ms>` | `string`, `date-time` |

## OpenAPI

Annotate a route handler with `op<{ … }>` and wiz assembles the document from
the types. Slots: `path`, `query`, `header`, `cookie`, `body`, `response`,
`responses`, `status`.

```ts
import { op, openapiSchema, openapiDocument } from "wiz";

export const routes = openapiSchema.bunRoutes(
  { openapi: "3.1.0", info: { title: "Users", version: "1.0.0" } },
  {
    "/users/:id": {
      GET: op<{
        path: { id: number };
        response: User;
        responses: {
          /** No such user */
          404: NotFound;
          /** Anything else */
          default: never; // a `never` body means no content
        };
      }>(() => Response.json({ id: 1, name: "Ada" })),
    },
  }
);

Bun.serve({ routes });

openapiDocument(); // every route in the program, merged
```

The routes object is handed back untouched, so it stays a working Bun router.
A response's own doc comment becomes its description. `openapiSchema<[A, B]>()`
generates a document from types alone when there are no routes to harvest.

Types reachable only through an error response are still hoisted into
`components.schemas`. A route wiz cannot reach at compile time warns with a
file:line rather than silently missing from the document.

## Protobuf and Avro

Both emit schema text and a binary codec generated from the same IR.

Protobuf needs field numbers, since they are the wire contract and cannot be
inferred:

```ts
interface Book {
  /** @fieldNumber 1 */
  title: string;
  /**
   * @fieldNumber 2
   * @format int32
   */
  year: number;
}
```

Nested objects become embedded messages, `T[]` becomes packed repeated (the
decoder accepts both framings), and `Record<string, T>` becomes a proto3 map.
Avro needs no numbering — it is schema-driven, with no tags on the wire.

### Unions

A protobuf `oneof` needs a field number per variant, and TypeScript has nowhere
to put one. `NumberedUnion` supplies them:

```ts
import type { NumberedUnion } from "wiz";

type Shape = NumberedUnion<{ 2: Circle; 3: Square }>;
```

To TypeScript this is exactly `Circle | Square` — assignable, narrowable,
printable. To wiz it is a `oneof`:

```proto
oneof shape {
  Circle circle = 2;
  Square square = 3;
}
```

Those numbers live in the enclosing message's field-number space, because that
is what a `oneof` occupies on the wire. So the property itself takes no
`@fieldNumber`, and a collision with a sibling field is refused.

An undeclared union is refused rather than encoded as something unreadable.
Two things that look like unions are not, and still work: `T | undefined`
(absence is field omission) and same-typed literal unions like
`"read" | "write"` (a string).

`Shape[]` and `Record<string, Shape>` are refused too — proto3 has no repeated
or mapped `oneof`. Wrap the variants in their own type so the `oneof` sits
inside a message that can be repeated.

Only protobuf cares. JSON Schema, OpenAPI and Avro see an ordinary union.

## CLI

```
wiz init [--force]             Register the plugin in the current project
wiz eject <file.ts> [out.ts]   Eject one file; no output path prints to stdout
wiz eject <dir> [outdir]       Eject a tsconfig project; no outdir prints JSON
wiz generate -g <module> [in]  Run a generator over an API document
wiz --help                     Show usage
```

`init` writes `wizPlugin.ts` and adds it to the root and `[test]` `preload`
lists in `bunfig.toml`, creating the file or the section if needed.

Your config is read with Bun's TOML parser but written as a text edit, so
comments, key order and formatting are preserved — Bun ships `Bun.TOML.parse`
and no serializer, and rewriting the file from a parsed object would throw all
of that away. Entries already present are left alone, `./x.ts` and `x.ts` count
as the same entry, and if the parser sees a `preload` the editor cannot safely
place, `init` says so instead of writing a second one.

`eject` writes what the plugin would have handed to Bun, so the result runs
with no plugin and nothing importing wiz. It is the same transform the plugin
uses, not a second implementation.

A single file ejects to a single file, with the generated code inlined and
trimmed to the parts that file uses. It refuses anything that cannot be
answered from one file — `openapiDocument()` is built from every route
reachable from the module, which is what the project form is for.

A project ejects through its `tsconfig.json`, mirroring the tree. Generated
modules stay separate there, since files share types by key and inlining would
copy the same code into each one. Given no destination, the whole tree is
printed as JSON with paths for keys.

`generate` runs one generator over one document. The input is a file, or stdin
when it is missing or `-`; the front end follows from the extension — `.proto`
is a gRPC service definition, anything else an API document — and `--format`
overrides the dialect. With `--outdir` the emitted files are written there,
overwriting silently; without one, the whole `{ filename: contents }` record is
printed as JSON so it can be post-processed.

```bash
wiz generate -g wiz/generators/tsClient.ts openapi.json --outdir src/api
cat openapi.yaml | wiz generate -g ./myGenerator.ts | jq -r '."model.ts"'
```

The bundled TypeScript client generator emits `model.ts` with the document's
types and `api.ts` with its operations. Every operation takes exactly the
parameters it declares — `path`, `query`, `headers`, `cookie`, `body` — and is
reachable two ways: as a module-level function driven by `configure()`, or
through `createClient()` when one process talks to several deployments. Both
run the `beforeCall` and `afterCall` hooks, which is where an `Authorization`
header comes from. `--lenient` widens the parameter objects, letting headers
carry any string entry and query any string or boolean one, for the gateway the
document forgot to mention.

### gRPC

A `.proto` file is a front end like any other: messages, enums, `oneof`, `map`,
`repeated`, `optional`, nested types and every scalar width become IR, and each
`rpc` becomes a service method addressed by package, service and name. Anything
the IR cannot hold — `extend`, groups, `reserved`, proto2's `required` — is
reported as a diagnostic rather than dropped quietly.

```bash
wiz generate -g wiz/generators/tsClient.ts pets.proto --outdir src/api
```

That emits two more files. `codec.ts` holds a reader and a writer per message,
generated from the same protobuf codec `encodeProto` uses. `transport.ts` holds
the HTTP/2 transport. `api.ts` calls into both, so a method takes and returns
messages, not bytes — in all four directions:

```ts
import { configure, unary, down, up, both } from "./api.ts";
import { createHttp2Transport } from "./transport.ts";

configure({
  baseUrl: "http://127.0.0.1:50051",
  transport: createHttp2Transport({ baseUrl: "http://127.0.0.1:50051" }),
});

await unary({ text: "hi" });                                  // one to one
for await (const pong of down({ text: "tick" })) { /* … */ }   // one to many
await up(pings());                                             // many to one
for await (const pong of both(pings())) { /* … */ }            // many to many
```

Calls take a second argument for a deadline and cancellation:
`unary(request, { timeoutMs: 250, signal })`. A deadline is sent as
`grpc-timeout` and enforced locally too, so a server that ignores it cannot hang
the caller.

**Two transports, because two environments.** `transport.ts` speaks gRPC proper
over `node:http2` — real HTTP/2, real trailers, a request body that stays open —
and is the only one that can stream requests. It is a separate file so a browser
bundle never imports `node:http2`. Without it, calls fall back to gRPC-Web over
`fetch`, which runs anywhere and needs a proxy (Envoy, `grpcwebproxy`, Connect)
in front of a gRPC server; a call that streams requests over that transport
fails with `UNIMPLEMENTED` naming the fix rather than hanging.

The HTTP/2 path is tested against a real `@grpc/grpc-js` server: all four
directions, server status codes, deadlines, cancellation and connection reuse.
What a client built on `@grpc/grpc-js` still gives you that this does not:

| | wiz | notes |
|---|---|---|
| Unary and all three streaming directions | yes, over HTTP/2 | gRPC-Web carries unary and server streaming only |
| Deadlines, cancellation | yes | `timeoutMs` and `AbortSignal` per call, or a default on the client |
| Wire format | verified | checked byte for byte against protobufjs, both directions |
| Metadata | headers, via `beforeCall`/`afterCall` | not a typed `Metadata` object; trailing metadata beyond `grpc-status`/`grpc-message` is not surfaced |
| Retries, hedging | no | a failed call is a failed call |
| Load balancing, name resolution, channel state | no | one origin per transport, one pooled session |
| TLS and credentials | the runtime's | `http2.connect` options are passed through; no per-call credentials |
| Compression | no | frames are sent uncompressed, and a compressed reply is refused rather than mis-read |
| Interceptors | one hook each way | `beforeCall`/`afterCall`, not a chain |
| Reflection, health checking, `Any`, `Struct` | no | unmapped well-known types become diagnostics |

## Design

Two steps meeting at the IR. An *extractor* is a front end that produces IR —
`extractors/typescript.ts` reads TypeScript types today, and the split exists
so others can join it. *Generators* are back ends that turn IR into code.

Because they meet at one IR and share the `@format` reader, a type cannot be
described one way and encoded another — a class of bug this codebase has had
repeatedly.

```
src/extractors/         front ends producing IR; typescript.ts is the first
src/ir/types.ts         IR shape, structural hashing
src/generators/         keys, schema, validator, openapi, protobuf, avro
src/plugin.ts           call-site rewriting, route harvesting
src/registry.ts         virtual modules, keyed by structural hash
src/cli.ts              the wiz binary
```

### Verification

Round-tripping wiz against itself proves nothing about a wire format: a codec
wrong in both directions round-trips perfectly. Avro is worse still — it is
schema-driven with no tags on the wire, so a field written one width and read
another silently shifts everything after it.

So the output is checked against independent implementations.
[protobuf.js](https://github.com/protobufjs/protobuf.js) and
[avsc](https://github.com/mtth/avsc) parse the generated `.proto` and `.avsc`,
read what wiz writes and write what wiz reads. Generated OpenAPI documents are
validated against the official OpenAPI schemas, and
[Ajv](https://ajv.js.org) compiles the generated JSON Schema and must reach
the same verdict as the generated validator on every case in a shared corpus —
the schema and the validator come from one IR, so nothing else was checking
that they agree.

Agreeing with another implementation only shows the two reach the same answer,
so the validator is also driven by the official
[JSON Schema Test Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite),
which pins it to the standard instead.

That is not a formality. It caught negative `int32` truncated to two bytes
instead of proto3's sign-extended ten, maps declared as `string`, `repeated
double` where the codec wrote `int32`, Avro enum symbols naming the members
while the codec indexed their values, the second use of a named type silently
degrading to JSON in both back ends, `@multipleOf` emitted into every schema
but enforced by nothing, string lengths counted in UTF-16 units rather than
characters, and `uniqueItems` comparing objects by reference — none of which
wiz's own tests could see.

## Tests

```bash
bun test
bunx tsc --noEmit
```
