# JSON Codec & Custom HTTP Encoders

`wiz` provides high-performance, spec-aligned JSON encoders and decoders (`encodeJson` and `decodeJson`) that wrap `JSON.stringify` and `JSON.parse` with automatic handling for `bigint`, `Date`, and `Uint8Array` fields.

```ts
import { encodeJson, decodeJson } from "wiz";

export interface Transaction {
  id: string;
  createdAt: Date;
  amount: bigint;
  signature: Uint8Array;
}

const tx: Transaction = {
  id: "tx_100",
  createdAt: new Date("2026-09-01T12:00:00.000Z"),
  amount: 9007199254740993n,
  signature: new Uint8Array([1, 2, 3, 4]),
};

// Encode to JSON string
const jsonString = encodeJson<Transaction>(tx);
// → '{"id":"tx_100","createdAt":"2026-09-01T12:00:00.000Z","amount":"9007199254740993","signature":"AQIDBA=="}'

// Decode back from JSON string
const restored = decodeJson<Transaction>(jsonString);
// restored.createdAt is an instance of Date
// restored.amount is a bigint (9007199254740993n)
// restored.signature is a Uint8Array
```

## Why Custom JSON Encoders/Decoders Are Needed

Standard `JSON.stringify` and `JSON.parse` have major limitations when working with modern TypeScript data types:

1. **`bigint` Error**: Standard `JSON.stringify` throws `TypeError: Do not know how to serialize a BigInt`.
2. **`Date` Deserialization**: `JSON.stringify(new Date())` produces an ISO string, but `JSON.parse` leaves it as a `string` — it does not restore `Date` instances.
3. **`Uint8Array` Serialization**: Standard `JSON.stringify(new Uint8Array([1, 2]))` serializes as an object `{"0":1, "1":2}`, distorting binary payloads.

`encodeJson` and `decodeJson` resolve these limitations at compile time:
- Types without `bigint`, `Date`, or `Uint8Array` generate **zero-overhead** calls directly to native `JSON.stringify` and `JSON.parse`.
- Types containing special fields generate lightweight pre-processing and post-processing steps.

## Function Signatures

### `encodeJson<T>(val: T): string`

Encodes `val` of type `T` to a JSON string.
- `bigint` values are converted to string representation (`"9007199254740993"`).
- `Date` objects are converted to ISO 8601 strings (`"2026-09-01T12:00:00.000Z"`).
- `Uint8Array` objects are converted to Base64 strings.
- Non-mutating: User input objects are shallow-copied during transformation.

### `decodeJson<T>(raw: string): T`

Decodes `raw` JSON string to an object of type `T`.
- String representations matching `bigint` fields are parsed to native `bigint` (`9007199254740993n`).
- ISO string fields matching `Date` types are parsed to native `Date` instances.
- Base64 string fields matching `Uint8Array` types are parsed to `Uint8Array` instances.
- Fast: Operates in-place on the fresh object returned by `JSON.parse`.

## HTTP Client Integration (`tsClient`)

HTTP client generators emitted by `wiz generate -g tsClient.ts` use these custom JSON encoders and decoders in `codec.ts`:

- Request bodies automatically use generated `encode<Model>(body)` encoders.
- Response bodies automatically use generated `decode<Model>(text)` decoders.

This ensures HTTP API client operations handle `bigint` and `Date` properties symmetrically to gRPC client operations without manual conversion logic.
