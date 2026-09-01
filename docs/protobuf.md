# Protobuf Schema & Codec Generation

`wiz` provides end-to-end Protocol Buffers (protobuf) support, generating `.proto` definitions and zero-dependency binary codecs directly from TypeScript types.

```ts
import { protobufSchema, encodeProto, decodeProto, type NumberedUnion } from "wiz";

export interface User {
  /** @fieldNumber 1 */
  id: string;
  /** @fieldNumber 2 */
  name: string;
}

// Generate .proto schema definition
const protoText = protobufSchema<[User]>();

// Binary encode & decode
const buf = new Uint8Array(1024);
const bytesWritten = encodeProto<User>({ id: "u1", name: "Alice" }, buf);
const user = decodeProto<User>(buf);
```

## Schema Generation with `protobufSchema`

`protobufSchema<[T1, T2, ...]>()` generates proto3 schema text:

```proto
syntax = "proto3";

message User {
  string id = 1;
  string name = 2;
}
```

Every property in a TypeScript interface mapped to protobuf **must** declare a `@fieldNumber <N>` JSDoc tag.

### Field Numbers (`@fieldNumber`)

Protobuf wire encoding relies on numeric field tags, not property names. `wiz` deliberately refuses to invent or auto-increment field numbers:

If a property lacks `@fieldNumber`, the generator throws an error at compile time naming the exact field:

```
[wiz] Property 'name' on type 'User' is missing required '@fieldNumber <N>' JSDoc tag for protobuf encoding/decoding.
```

This enforces explicit field numbering so schema changes never silently renumber wire fields.

## Binary Codec: `encodeProto` & `decodeProto`

`wiz` emits high-performance, zero-dependency binary codecs at the callsite.

### `encodeProto<T>(val: T, buf: Uint8Array, offset?: number): number`

Encodes `val` into `buf` starting at `offset` (default `0`). Returns the number of bytes written.

```ts
const buf = new Uint8Array(512);
const len = encodeProto<User>({ id: "usr_10", name: "Bob" }, buf, 0);
const slice = buf.subarray(0, len);
```

### `decodeProto<T>(buf: Uint8Array, offset?: number): T`

Decodes binary protobuf data from `buf` starting at `offset` into a typed object.

```ts
const user = decodeProto<User>(wireBytes);
```

## Scalar Width Selection & `@format`

`wiz` maps TypeScript primitives onto protobuf wire types according to `@format` annotations:

| TypeScript Type | `@format` Tag | Protobuf Wire Type | Encoding |
|---|---|---|---|
| `string` | — | `string` | UTF-8 varint-length-delimited |
| `number` | — | `double` | 64-bit IEEE 754 float |
| `number` | `@format float` | `float` | 32-bit float |
| `number` | `@format int32` | `int32` | Varint (sign-extended to 10 bytes if negative) |
| `number` | `@format uint32` | `uint32` | Varint |
| `number` | `@format sint32` | `sint32` | ZigZag varint |
| `number` | `@format fixed32` | `fixed32` | Fixed 32-bit little-endian |
| `bigint` | `@format int64` | `int64` | 64-bit varint |
| `bigint` | `@format uint64` | `uint64` | 64-bit unsigned varint |
| `bigint` | `@format sint64` | `sint64` | 64-bit ZigZag varint |
| `bigint` | `@format fixed64` | `fixed64` | Fixed 64-bit little-endian |
| `boolean` | — | `bool` | Varint (0 or 1) |
| `Uint8Array` | — | `bytes` | Varint-length-delimited bytes |

`bigint` is used for 64-bit integer fields to prevent loss of precision past JS `SAFE_INTEGER` (`2^53 - 1`).

## Unions & `oneof`

Protobuf `oneof` fields represent discriminated unions. `wiz` supports `oneof` via `NumberedUnion`:

```ts
import { type NumberedUnion } from "wiz";

type Payload = NumberedUnion<{
  1: TextMessage;
  2: ImageMessage;
}>;

interface Event {
  /** @fieldNumber 1 */
  id: string;
  /** @fieldNumber 2 */
  payload: Payload;
}
```

Generated `.proto`:

```proto
message Event {
  string id = 1;
  oneof payload {
    TextMessage textMessage = 2;
    ImageMessage imageMessage = 3;
  }
}
```

## Verification

The protobuf back end is verified byte-for-byte in both directions against reference implementations:
- Generated `.proto` files are loaded by `protobufjs`.
- `encodeProto` outputs are read and verified by `protobufjs.Reader`.
- `protobufjs.Writer` outputs are decoded and verified by `decodeProto`.

Special wire edge cases, such as proto3 negative `int32` sign-extension across 10 bytes, are explicitly covered. See [verification](./verification.md).
