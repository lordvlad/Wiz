# Verification & Independent Oracles

`wiz` verifies its code generators, codecs, and validators against independent reference implementations rather than self-referential tests.

> **Why round-tripping against itself proves nothing**: A binary codec that is wrong in both directions will round-trip perfectly in self-tests. Avro is schema-driven with no tags on the wire — a field written with the wrong width silently corrupts all subsequent fields without throwing an error.

To guarantee wire-format compliance, `wiz` verifies generator outputs against established reference implementations ("oracles").

## Verification Oracles

| Back End / Output | Verification Oracle | Verification Method |
|---|---|---|
| **JSON Schema (`schema<T>`)** | [Ajv](https://ajv.js.org) & [JSON Schema Test Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite) | Ajv compiles generated draft-2020-12 and draft-07 schemas. Generated validators are driven against the official test suite. |
| **OpenAPI (`openapiSchema`)** | `@seriousme/openapi-schema-validator` | Generated OpenAPI 3.0 and 3.1 documents are validated against official meta-schemas. |
| **Protobuf Codec (`encodeProto`)** | [protobuf.js](https://github.com/protobufjs/protobuf.js) | `protobuf.js` parses generated `.proto` schemas. Bytes written by `encodeProto` are read by `protobufjs.Reader`; bytes written by `protobufjs.Writer` are decoded by `decodeProto`. |
| **Avro Codec (`encodeAvro`)** | [avsc](https://github.com/mtth/avsc) | `avsc` compiles generated `.avsc` schemas and cross-verifies binary payloads in both directions. |
| **gRPC HTTP/2 Client** | `@grpc/grpc-js` | Generated clients are executed over HTTP/2 against a live `@grpc/grpc-js` server for all 4 streaming directions, deadlines, cancellation, status codes, and compression. |
| **Zod Schema (`zodSchema`)** | Real `zod` instance & `validate<T>` | Generated zod schemas are executed against `zod` and pinned to return identical verdicts as the generated `validate` function on a shared corpus. |

## Bugs Caught by Independent Oracles

Verifying against independent reference implementations caught critical edge-case bugs during development that self-tests missed:

1. **Proto3 Sign Extension**: Negative `int32` varints must sign-extend across 10 bytes on the wire. Truncating to 32 bits caused `protobuf.js` to reject the message.
2. **Proto3 Maps**: Maps declared as `string` instead of length-delimited key-value entry messages were rejected by reference parsers.
3. **Avro Enum Encoding**: Avro enum symbols were encoded as strings instead of 0-based integer indices.
4. **JSON Schema `@multipleOf`**: `@multipleOf` keywords were emitted into JSON Schemas but omitted from generated validators.
5. **UTF-16 String Lengths**: `minLength` / `maxLength` originally counted UTF-16 code units instead of Unicode code points.
6. **`Timestamp` Wire Field Loss**: `google.protobuf.Timestamp` mapped to `Date` lost nanosecond fields on the wire. It was fixed by declaring `Timestamp` as the exact `{ seconds, nanos }` message structure defined in the protobuf spec.

## Running Verification Tests

```bash
# Run full test suite (500+ tests including all interop & verification suites)
bun test

# Run specific interop test suites
bun test test/interop.test.ts          # Protobuf interop
bun test test/interop_avro.test.ts     # Avro interop
bun test test/interop_jsonschema.test.ts # JSON Schema & Ajv
bun test test/grpc_interop.test.ts     # @grpc/grpc-js HTTP/2
```
