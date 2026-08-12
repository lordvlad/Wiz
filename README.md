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
field type and the Avro type. The values are the OpenAPI Format Registry's, so
there is nothing wiz-specific to learn.

| `@format` | on | proto | Avro | JSON Schema |
|---|---|---|---|---|
| *(none)* | `number` | `double` | `double` | `number` |
| `int32` | `number` | `int32` | `int` | `number` + `int32` |
| `int64` | `number` | `int64` | `long` | `number` + `int64` |
| `int64` | `bigint` | `int64` | `long` | `string` + pattern |
| `uint32` / `uint64` | `number` | same | `long` | `number` + format |
| `sint32` / `sint64` | `number` | zig-zag varint | `int` / `long` | `number` + format |
| `fixed32` / `sfixed32` | `number` | 4 bytes | `int` | `number` + format |
| `fixed64` / `sfixed64` | `bigint` | 8 bytes | `long` | `string` + pattern |
| `float` | `number` | `float` | `float` | `number` + `float` |
| `uuid` | `string` | `string` | `{string, uuid}` | `string` + `uuid` |
| `date` / `time` | `string` | `string` | `{int, date}` / `{int, time-millis}` | `string` + format |
| `date-time` | `string` | `string` | `{long, timestamp-millis}` | `string` + format |
| `byte` / `binary` | `string` | `string` | `bytes` | `string` + format |

A plain `number` is a `double`, because in JavaScript it is one. Opt into a
compact integer with `@format int32`.

A `bigint` is described as a *string* in JSON Schema, with a digits pattern:
JSON numbers are doubles, so precision above 2^53 dies on the way out, and
`JSON.stringify` refuses a BigInt outright. The binary codecs carry the full
64 bits.

`Uint8Array` and `Date` need no annotation — they are scalars everywhere:

| type | proto | Avro | JSON Schema |
|---|---|---|---|
| `Uint8Array` | `bytes` | `bytes` | `string`, base64 |
| `Date` | `int64` | `{long, timestamp-millis}` | `string`, `date-time` |

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
wiz init [--force]   Register the plugin in the current project
wiz --help           Show usage
```

`init` writes `wizPlugin.ts` and adds it to the root and `[test]` `preload`
lists in `bunfig.toml`, creating the file or the section if needed.

Your config is read with Bun's TOML parser but written as a text edit, so
comments, key order and formatting are preserved — Bun ships `Bun.TOML.parse`
and no serializer, and rewriting the file from a parsed object would throw all
of that away. Entries already present are left alone, `./x.ts` and `x.ts` count
as the same entry, and if the parser sees a `preload` the editor cannot safely
place, `init` says so instead of writing a second one.

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
read what wiz writes and write what wiz reads; generated OpenAPI documents are
validated against the official OpenAPI schemas.

That is not a formality. It caught negative `int32` truncated to two bytes
instead of proto3's sign-extended ten, maps declared as `string`, `repeated
double` where the codec wrote `int32`, Avro enum symbols naming the members
while the codec indexed their values, and the second use of a named type
silently degrading to JSON in both back ends — none of which wiz's own
round-trip tests could see.

## Tests

```bash
bun test
bunx tsc --noEmit
```
