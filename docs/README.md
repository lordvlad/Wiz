# Wiz Documentation

`wiz` is a compile-time type introspection engine and code generator for Bun and TypeScript.

## Documentation Index

### Getting Started
- **[Getting Started](./getting-started.md)** — Installation, plugin setup (`wiz init`), manual setup, `@wiz-ignore`, and a first end-to-end example.
- **[CLI Reference](./cli.md)** — `wiz init`, `wiz eject`, and `wiz generate` commands, flags, and options.

### Introspection & Validation
- **[Type Introspection](./type-introspection.md)** — `keysOf<T>()`, `requiredKeysOf<T>()`, `optionalKeysOf<T>()`, `deepKeysOf<T>()`, `is<T>()`, `validate<T>()`, `assert<T>()`, and `parseQuery<T>()`.
- **[JSDoc Annotations](./annotations.md)** — Reference for validation constraints (`@minLength`, `@min`, `@pattern`, `@format`), descriptive tags, and integer width formats.
- **[JSON Codec](./json-codec.md)** — `encodeJson<T>` and `decodeJson<T>` with spec-aligned handling for `bigint`, `Date`, and `Uint8Array`.
- **[Zod Integration](./zod.md)** — `zodSchema<T>()`, lazy loading, peer dependencies, and type mapping.

### Schemas & Web APIs
- **[JSON Schema](./json-schema.md)** — `schema<T>()`, Draft 2020-12 and Draft 07 support, keyword mapping, and draft selection.
- **[OpenAPI](./openapi.md)** — `openapiSchema`, service-interface operation declarations, `openapiDocument()`, and why a router is never part of the document.
- **[AsyncAPI & Events](./asyncapi.md)** — `asyncapiSchema`, `@producer`/`@consumer` channel declarations, 2.6 and 3.0 support, and model/codec generation.
- **[OpenRPC](./openrpc.md)** — `openRPCSchema`, method harvesting from signatures and service interfaces, and namespacing.
- **[MCP](./mcp.md)** — `mcpSchema`, tool harvesting, input/output JSON schemas, and tool annotations.
- **[TypeScript Client](./typescript-client.md)** — `wiz generate -g tsClient`, HTTP client operations, custom JSON codecs, interceptor chains, deadlines, `createClient`, and runtime validation via `--validate`.
- **[React Query Client](./react-query.md)** — `wiz generate -g reactQuery`, generated queries and mutations, and query keys.

### Binary Codecs & Protocols
- **[Protocol Buffers](./protobuf.md)** — `protobufSchema`, `encodeProto`, `decodeProto`, `@fieldNumber`, scalar widths, `oneof`, and `NumberedUnion`.
- **[gRPC](./grpc.md)** — Proto front end, `grpcSchema` service harvesting, all 4 streaming directions, `createHttp2Transport()`, deadlines, metadata, and trailers.
- **[Avro & Apache Arrow](./avro-and-arrow.md)** — `.avsc` row schemas, Avro codecs, and Apache Arrow IPC columnar batch streaming.
- **[Erlang Codecs](./erlang.md)** — `encodeErlangText`, `decodeErlangText`, `encodeErlangBinary`, and `decodeErlangBinary` for Erlang Text and ETF 131 binary format.

### Extensibility & Architecture
- **[Architecture](./architecture.md)** — IR design (`TypeIR`, `ServiceIR`, `ApiIR`), transform pipeline, virtual module mounting (`wiz-virtual/<key>/index.js`), and registry identity.
- **[Writing a Generator](./writing-a-generator.md)** — Implementing custom `Generator` plugins, `GeneratorContext`, and `GeneratedFiles`.
- **[Front-End Extractors](./extractors.md)** — TypeScript, OpenAPI, and Protobuf front-end extractors, and `ApiDiagnostic` arrays.
- **[Verification & Oracles](./verification.md)** — How `wiz` verifies output against independent reference implementations (protobuf.js, avsc, Ajv, `@grpc/grpc-js`, JSON Schema Test Suite).
