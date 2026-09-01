# Avro & Apache Arrow Back Ends

`wiz` provides built-in support for Avro row-based binary serialization and Apache Arrow columnar binary streams.

---

## Avro (`.avsc` & Binary Codec)

Avro is a compact, schema-based binary format. Because Avro data carries no field tags on the wire, schema alignment between encoder and decoder is critical.

```ts
import { avroSchema, encodeAvro, decodeAvro } from "wiz";

export interface Account {
  id: string;
  balance: bigint;
}

// Generate Avro schema (.avsc)
const schemaText = avroSchema<[Account]>();

// Binary encode & decode
const buf = new Uint8Array(512);
const len = encodeAvro<Account>({ id: "acc_1", balance: 500n }, buf);
const account = decodeAvro<Account>(buf.subarray(0, len));
```

### Generated Schema (`avroSchema`)

`avroSchema<[T1, T2, ...]>()` produces JSON Avro schema text (`.avsc`):

```json
{
  "type": "record",
  "name": "Account",
  "fields": [
    { "name": "id", "type": "string" },
    { "name": "balance", "type": "long" }
  ]
}
```

### Type Mapping

| TypeScript Type | `@format` Tag | Avro Type | Notes |
|---|---|---|---|
| `string` | — | `string` | Length-prefixed UTF-8 |
| `number` | — | `double` | 64-bit float |
| `number` | `@format float` | `float` | 32-bit float |
| `number` | `@format int` | `int` | ZigZag varint |
| `number` / `bigint` | `@format long` / `int64` | `long` | ZigZag 64-bit varint |
| `boolean` | — | `boolean` | 1 byte (0 or 1) |
| `Uint8Array` | — | `bytes` | Length-prefixed bytes |
| `Date` | — | `long` | Timestamp milliseconds since epoch |
| `T \| null` / `T?` | — | `["null", T]` | Avro union for optional fields |

### Why Avro Errors Are Dangerous

Unlike Protobuf or JSON, Avro wire data contains **no field tags or type markers**. If an encoder and decoder disagree on a field's width or order:
- The decoder does not throw a missing field error.
- It silently reads bytes intended for field N into field N+1.
- All subsequent fields in the record become corrupt without error.

`wiz` verifies Avro codecs byte-for-byte against the official JavaScript Avro library (`avsc`) in both directions. See [verification](./verification.md).

---

## Apache Arrow (Columnar IPC Streams)

Apache Arrow is a high-performance columnar memory format designed for batch analytical queries and data frame transport.

```ts
import { arrowSchema, encodeArrow, decodeArrow } from "wiz";

export interface RecordRow {
  id: string;
  value: number;
}

const rows: RecordRow[] = [
  { id: "r1", value: 10.5 },
  { id: "r2", value: 20.0 }
];

// Encode array of records to Arrow IPC stream bytes
const buf = new Uint8Array(4096);
const bytesWritten = encodeArrow<RecordRow>(rows, buf);

// Decode Arrow IPC stream bytes back to array of records
const decodedRows = decodeArrow<RecordRow>(buf.subarray(0, bytesWritten));
```

### Columnar Layout

While row-oriented formats (JSON, Avro, Protobuf) write `{ id, value }` record by record, Arrow groups data by column:
- `id` column array: `["r1", "r2"]`
- `value` column array: `[10.5, 20.0]`

This allows vectorized SIMD memory operations and efficient column filtering.

### Build-Time Dependency (`apache-arrow`)

To generate Arrow schemas, `wiz` uses `apache-arrow` **at build time**:
- `apache-arrow` is an optional devDependency (`bun add -d apache-arrow`).
- `wiz` uses `apache-arrow` during transpilation to construct the binary FlatBuffers IPC schema header.
- The generated runtime code (`encodeArrow` / `decodeArrow`) is **zero-dependency**: it writes raw binary IPC record batches directly into memory without importing Arrow at runtime.

If `apache-arrow` is missing during build time, `wiz` throws a clear error:

```
[wiz] Arrow support needs 'apache-arrow' at build time: run 'bun add -d apache-arrow'. It builds the schema during the transform and never reaches your bundle.
```
