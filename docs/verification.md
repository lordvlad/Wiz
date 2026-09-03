# Verification & Independent Oracles

`wiz` verifies its code generators, codecs, and validators against independent reference implementations rather than self-referential tests.

> **Why round-tripping against itself proves nothing**: A binary codec that is wrong in both directions will round-trip perfectly in self-tests. Avro is schema-driven with no tags on the wire — a field written with the wrong width silently corrupts all subsequent fields without throwing an error.

To guarantee wire-format compliance, `wiz` verifies generator outputs against established reference implementations ("oracles").

## Verification Oracles

| Back End / Output | Verification Oracle | Verification Method |
|---|---|---|
| **JSON Schema (`schema<T>`)** | [Ajv](https://ajv.js.org) & [JSON Schema Test Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite) | Ajv compiles generated draft-2020-12 and draft-07 schemas. Generated validators are driven against the official test suite. |
| **OpenAPI (`openapiSchema`)** | `@seriousme/openapi-schema-validator` | Generated OpenAPI 3.0 and 3.1 documents are validated against official meta-schemas. |
| **AsyncAPI (`asyncapiSchema`) / OpenRPC (`openRPCSchema`)** | Bundled official meta-schemas | Generated documents are validated against the AsyncAPI 2.6/3.0 and OpenRPC 1.3 meta-schemas shipped in `schemas/` before any code is emitted. |
| **Protobuf Codec (`encodeProto`)** | [protobuf.js](https://github.com/protobufjs/protobuf.js) | `protobuf.js` parses generated `.proto` schemas. Bytes written by `encodeProto` are read by `protobufjs.Reader`; bytes written by `protobufjs.Writer` are decoded by `decodeProto`. |
| **Avro Codec (`encodeAvro`)** | [avsc](https://github.com/mtth/avsc) | `avsc` compiles generated `.avsc` schemas and cross-verifies binary payloads in both directions. |
| **gRPC HTTP/2 Client** | `@grpc/grpc-js` | Generated clients are executed over HTTP/2 against a live `@grpc/grpc-js` server for all 4 streaming directions, deadlines, cancellation, status codes, and compression. |
| **Zod Schema (`zodSchema`)** | Real `zod` instance & `validate<T>` | Generated zod schemas are executed against `zod` and pinned to return identical verdicts as the generated `validate` function on a shared corpus. |
| **Validator runtime helpers** | `tsc` under `strict` | The helpers the checks call are emitted as source, so nothing in a normal build reads them. They are written to a file and compiled by `tsc` with `strict` on — declarations and callsites both — and pinned to differ between their plain and annotated renderings by signatures alone. |
| **Client validation (`--validate`)** | The emitted client itself | Generated clients are executed against a stub transport: a request or response breaking a constraint the document declared must throw `ClientValidationError` naming the part that failed, and a client generated without the flag must be byte-identical to one from before the option existed. |

## Bugs Caught by Independent Oracles

Verifying against independent reference implementations caught critical edge-case bugs during development that self-tests missed:

1. **Proto3 Sign Extension**: Negative `int32` varints must sign-extend across 10 bytes on the wire. Truncating to 32 bits caused `protobuf.js` to reject the message.
2. **Proto3 Maps**: Maps declared as `string` instead of length-delimited key-value entry messages were rejected by reference parsers.
3. **Avro Enum Encoding**: Avro enum symbols were encoded as strings instead of 0-based integer indices.
4. **JSON Schema `@multipleOf`**: `@multipleOf` keywords were emitted into JSON Schemas but omitted from generated validators.
5. **UTF-16 String Lengths**: `minLength` / `maxLength` originally counted UTF-16 code units instead of Unicode code points.
6. **`Timestamp` Wire Field Loss**: `google.protobuf.Timestamp` mapped to `Date` lost nanosecond fields on the wire. It was fixed by declaring `Timestamp` as the exact `{ seconds, nanos }` message structure defined in the protobuf spec.
7. **`$ref` schemas validated nothing**: the validator emitter stops at a `ref`, which is correct for cycles but meant the client's `--validate` checks were emitted and empty for every schema an OpenAPI document named — a client that appeared to validate and did not.
8. **Unannotated helper parameters**: emitted as plain JS, the runtime helpers were never typechecked, so an unannotated parameter was a `noImplicitAny` error in the consumer's build rather than ours. Compiling them here also caught that recursive `__wizEqual` needs an explicit return type under `strict`.

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
