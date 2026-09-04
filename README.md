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
both `bun run` and `bun test`. Called without the plugin active, every helper
throws `PluginInactiveError` rather than returning something plausible.

Manual setup, build-time registration, `@wiz-ignore` and the logger options are
in [getting-started.md](./docs/getting-started.md).

## What it generates

| Call | Signature / Produces | Docs |
|---|---|---|
| `keysOf<T>()` | `(keyof T)[]` | [type-introspection](./docs/type-introspection.md) |
| `requiredKeysOf<T>()` / `optionalKeysOf<T>()` | `(keyof T)[]`, by presence | [type-introspection](./docs/type-introspection.md) |
| `deepKeysOf<T>(options?)` | `string[]` (dot-separated deep keys) | [type-introspection](./docs/type-introspection.md) |
| `is<T>(value)` | `value is T` (narrowing predicate, zero allocation) | [type-introspection](./docs/type-introspection.md) |
| `validate<T>(value, options?)` | `ValidationError[]` | [type-introspection](./docs/type-introspection.md) |
| `assert<T>(value, options?)` | `asserts value is T`, throws `AssertError` | [type-introspection](./docs/type-introspection.md) |
| `parseQuery<T>(input, options?)` | `T`, coerced from a query string | [type-introspection](./docs/type-introspection.md) |
| `schema<T>(version?)` | JSON Schema (`draft-2020-12` or `draft-07`) | [json-schema](./docs/json-schema.md) |
| `zodSchema<T>()` | `Promise<ZodSchema>`, from the same IR | [zod](./docs/zod.md) |
| `openapiSchema<[A, B]>(base?)` / `openapiDocument<[S]>(base?)` | OpenAPI 3.0 or 3.1 document | [openapi](./docs/openapi.md) |
| `asyncapiSchema<[A, B]>(base?)` | AsyncAPI 2.6 or 3.0 document | [asyncapi](./docs/asyncapi.md) |
| `openRPCSchema<[S]>(base?)` | OpenRPC 1.3 document | [openrpc](./docs/openrpc.md) |
| `mcpSchema<[T]>(base?)` | MCP tool specifications | [mcp](./docs/mcp.md) |
| `protobufSchema<[A, B]>()` / `encodeProto` / `decodeProto` | `.proto` text and binary codec | [protobuf](./docs/protobuf.md) |
| `grpcSchema<[S]>()` | `.proto` text with `service` blocks, from a service interface | [grpc](./docs/grpc.md) |
| `avroSchema<[A, B]>()` / `encodeAvro` / `decodeAvro` | `.avsc` text and binary codec | [avro-and-arrow](./docs/avro-and-arrow.md) |
| `arrowSchema<[A, B]>()` / `encodeArrow` / `decodeArrow` | Arrow IPC stream binary codec | [avro-and-arrow](./docs/avro-and-arrow.md) |
| `encodeJson<T>` / `decodeJson<T>` | JSON codec with `bigint`, `Date`, `bytes` handling | [json-codec](./docs/json-codec.md) |
| `encodeErlangText<T>` / `decodeErlangText<T>` | Erlang Text codec | [erlang](./docs/erlang.md) |
| `encodeErlangBinary<T>` / `decodeErlangBinary<T>` | Erlang External Term Format (ETF 131) | [erlang](./docs/erlang.md) |

Identical types share one generated module, so `is<User>(a)` in two files
imports the same function.

## Describing types

wiz reads JSDoc. Constraints (`@min`, `@minLength`, `@pattern`, `@format`, …)
are enforced by the generated validator; annotations (`@example`, `@default`,
`@deprecated`, the doc comment itself) only describe; everything else is
preserved verbatim in `meta` and emitted into no document.

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
}
```

`@format` is the one tag that reaches every back end at once: it picks the JSON
Schema format, the OpenAPI format, the protobuf field type, the Avro type and
the Arrow column. Widths are ranges and the ranges are enforced — `@format
int32` with `3000000000` is rejected rather than wrapped to `-1294967296`. Full
tag reference, the format tiers and the integer-width table are in
[annotations.md](./docs/annotations.md).

## Specs and clients

Operations are declared as a service interface; JSDoc says where each method
lives and the parameter and return types say what it carries.

```ts
import { openapiSchema } from "wiz";

export interface UserService {
  /**
   * @get /users/{id}
   * @response 200 User
   * @response 404 No such user NotFound
   */
  getUser(params: { path: { id: number } }): Promise<User>;
}

export const doc = openapiSchema<[UserService]>({
  openapi: "3.1.0",
  info: { title: "Users", version: "1.0.0" },
});
```

The same shape drives [OpenAPI](./docs/openapi.md),
[AsyncAPI](./docs/asyncapi.md), [OpenRPC](./docs/openrpc.md) and
[MCP](./docs/mcp.md).

Going the other way, `wiz generate` turns an OpenAPI document or a `.proto`
file into a typed client: [typescript-client](./docs/typescript-client.md),
[react-query](./docs/react-query.md), [grpc](./docs/grpc.md), and
[cli](./docs/cli.md) for `init`, `eject` and `generate`.

## Documentation

Every feature, extractor and generator has a guide in
**[docs/](./docs/README.md)**.

## Design

Two steps meeting at the IR. An *extractor* is a front end that produces IR;
*generators* are back ends that turn IR into `GeneratedFiles` — a map of
filenames to contents. The plugin mounts those virtually (under
`wiz-virtual/<key>/index.js`) and rewrites callsites to import them, while
`wiz generate` and `wiz eject` write them to disk.

Because every back end meets at one IR and shares the `@format` reader, a type
cannot be described one way and encoded another — a class of bug this codebase
has had repeatedly. See [architecture.md](./docs/architecture.md), and
[writing-a-generator.md](./docs/writing-a-generator.md) to add a back end.

## Verification

Round-tripping wiz against itself proves nothing about a wire format: a codec
wrong in both directions round-trips perfectly. So the output is checked
against independent implementations — protobuf.js and avsc read what wiz writes
and write what wiz reads, Ajv must reach the same verdict as the generated
validator on a shared corpus, generated documents are validated against the
official OpenAPI/AsyncAPI/OpenRPC schemas, the gRPC client is driven against
`@grpc/grpc-js`, and the validator is pinned to the official JSON Schema Test
Suite. What that has caught is listed in
[verification.md](./docs/verification.md).

## Tests

```bash
bun test
bunx tsc --noEmit
```
