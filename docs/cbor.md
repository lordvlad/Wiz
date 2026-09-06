# CBOR Codec

`wiz` includes a first-class, dynamic CBOR (RFC 8949) wire codec, mirroring the Erlang ETF implementation.

## Usage

CBOR encoding and decoding is triggered via macros or by configuring a generated client to use `application/cbor` media types.

### Codecs
The `encodeCbor` and `decodeCbor` macros are harvested by the plugin and emitted into the virtual module mounted at `wiz-virtual/<hash>/index.js`.

```typescript
import { encodeCbor, decodeCbor } from "wiz";

const data = {
  name: "Bob",
  count: 42,
  at: new Date(),
  big: 9007199254740993n,
  blob: new Uint8Array([9, 8, 7])
};

// Returns Uint8Array
const encoded = encodeCbor(data);

// Decodes back to original types
const decoded = decodeCbor(encoded);
```

### Client Support
Generated TypeScript clients support `application/cbor` bodies via the `mediaTypes` option.

```typescript
// Configure the generator
generate(ir, tsClientGenerator, { mediaTypes: ["cbor"] }, logger);

// In the generated API client:
// A POST operation with `application/cbor` content-type will automatically
// use `encodeCbor` for the request body and `decodeCbor` for the response.
const response = await client.sendItem({
  body: { data: "tool" },
  headers: { "content-type": "application/cbor" }
});
```

## Protocol Details

- **Dynamic Encoding**: Unlike gRPC or Protobuf, CBOR is self-describing. The codec is dynamic; it does not use the `TypeIR` at runtime.
- **Round-trip**:
  - `number`: JS integers within safe range use major type 0/1; otherwise 8-byte IEEE 754 float.
  - `bigint`: Round-trips exactly (tagged major type 2/3 for values outside safe-integer range).
  - `Date`: RFC 3339 string (Tag 0).
  - `Uint8Array`: Byte string (Major type 2).
  - `Map` / `Object`: Maps (Major type 5). `Map` preserves keys of any type; `Object` uses string keys.
- **Ordering**: Keys are emitted in insertion order. Canonical/length-sorted ordering is not enforced.
