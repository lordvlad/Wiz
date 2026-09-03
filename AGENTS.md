# AI Agent Guide (`AGENTS.md`)

Welcome to `wiz`. This document provides technical context, architecture principles, repository invariants, and operational guidance for AI subagents and engineers working on this codebase.

---

## 1. Project Overview & Architecture

`wiz` is a compile-time type introspection engine and code generator for Bun and TypeScript. It transforms TypeScript types into zero-overhead runtime checks, JSON Schemas, OpenAPI / AsyncAPI / OpenRPC documents, Protobuf / Avro / Arrow / Erlang codecs, and fully typed client SDKs.

### The Transformation Pipeline

```
[ TypeScript / Spec File ]
          │
          ▼
   ┌──────────────┐
   │ Extractor    │  (extractApiIR, extractProtoIR, extractTypeIR)
   └──────┬───────┘
          │
          ▼
   ┌──────────────┐
   │ IR Graph     │  (TypeIR, ServiceIR, ApiIR)
   └──────┬───────┘
          │
          ▼
   ┌──────────────┐
   │ Generator    │  (generateOpenApiSchemaCode, generateTsClient, etc.)
   └──────┬───────┘
          │
          ▼
[ Virtual Module / Output Files ]  (wiz-virtual/<digest>/index.js or outdir)
```

1. **Extractors** (`src/extractors/`): Parse input documents (OpenAPI, AsyncAPI, OpenRPC, Protobuf, TypeScript source) into intermediate representation (IR) nodes.
2. **Intermediate Representation** (`src/ir/`):
   - `TypeIR`: Structural type graphs (`primitive`, `literal`, `object`, `array`, `tuple`, `union`, `intersection`, `enum`, `record`, `ref`).
   - `ServiceIR`: Operation definitions (`HttpServiceMethodIR`, `GrpcServiceMethodIR`, `OpenRpcServiceMethodIR`, `McpServiceMethodIR`, AsyncAPI methods).
   - `ApiIR`: Document root combining `types`, `components`, and `service`.
3. **Generators** (`src/generators/`): Code generators that turn IR into executable JavaScript / TypeScript code, virtual module definitions, or schema JSON.
4. **Plugin Transformer** (`src/plugin.ts`, `src/harvest.ts`): Bun build/runtime plugin (`wizPlugin()`) that harvests AST callsites (`keysOf`, `is`, `validate`, `schema`, `openapiSchema`, `openRPCSchema`, `asyncapiSchema`, `mcpSchema`, `encodeJson`, `encodeErlangText`, `encodeErlangBinary`, etc.) and rewrites them into imports from virtual modules mounted on `wiz-virtual/<hash>/index.js`.
   - **Signature & Service Harvesters**: Every spec macro (`openapiSchema`, `asyncapiSchema`, `openRPCSchema`, `mcpSchema`) harvests its operations from its generic type arguments — either a function signature type or an interface/class whose members are callable. There are no builder functions; JSDoc tags carry what the types cannot:
     - OpenAPI: `@get`/`@post`/`@put`/`@patch`/`@delete`/`@head`/`@options`/`@trace` (verb + path template), `@http VERB /path`, `@response STATUS [MEDIATYPE] [TYPE] [DESCRIPTION]`.
     - AsyncAPI: `@producer`/`@consumer`/`@action`, `@channel`.
     - Global: `@name` (operation id / method name override), `@package`, `@service`, `@summary`, `@title`, `@audience`, `@priority`.
   - **Assembly rules**: OpenAPI sets `operationId` and attaches `x-package`/`x-service` plus a `service` tag; AsyncAPI attaches `x-package`/`x-service` and prefixes the channel key; OpenRPC names methods `package.service.method`; MCP names tools `package.service.snake_case_method`. gRPC binds directly to `GrpcAddressIR.package`/`service`.
   - A type argument with no callable members is a payload type: it contributes a component schema and no operation. `openRPCSchema` and `mcpSchema` emit a `warnUndocumentable` diagnostic for an object type with zero methods, since those macros describe nothing else.
---

## 2. Directory Layout & Key Modules

```
wiz/
├── schemas/                # Official JSON Schema meta-schemas (OpenAPI 3.0/3.1, OpenRPC 1.3, AsyncAPI 2.6/3.0)
├── src/
│   ├── index.ts            # Public API exported functions & stubs
│   ├── plugin.ts           # Bun macro/plugin transformer and callsite rewrites
│   ├── harvest.ts          # TypeScript AST/type harvesting (openapiSchema, asyncapiSchema, openRPCSchema, mcpSchema, grpc, Bun/Hono routes)
│   ├── registry.ts         # Structural type key hash computation & module registry
│   ├── types.ts            # TypeIR definitions and utility re-exports
│   ├── openapiDialect.ts   # OpenAPI JSDoc annotation and constraint mappings
│   ├── cli.ts              # CLI entry point (wiz init, wiz eject, wiz generate)
│   ├── cli/                # CLI command handlers (generate.ts, eject.ts, init.ts, bunfig.ts)
│   ├── extractors/         # Spec & code extractors (openapi, asyncapi, openrpc, proto, typescript)
│   ├── generators/         # Code generators (openapi, asyncapi, openrpc, protobuf, avro, arrow, erlang, json, tsClient, reactQuery, validator, zod, keys, query)
│   ├── validators/         # JSON Schema validation utility (jsonSchema.ts) using direct Bun JSON imports
│   ├── ir/                 # Intermediate representation node types (types.ts, service.ts, api.ts)
│   └── transports/         # Client & server transports
├── test/                   # Test suite (620+ tests covering extractors, generators, CLI, Ajv/Zod interop)
└── docs/                   # Comprehensive feature & generator guides
```

---

## 3. Core Invariants & Engineering Conventions

- **Zero Runtime Dependencies for Generated Clients**:
  Generated clients (`tsClient`, `reactQuery`) emit standalone TypeScript files (`model.ts`, `api.ts`, `codec.ts`) that import nothing from `wiz`.
- **Direct Bun JSON Imports**:
  Always use native Bun JSON imports for meta-schemas:
  `import openApi30Schema from "../schemas/openapi-3.0.json";`
  Do not use manual `fs.readFile` or `fetch` for bundled schema files.
- **Spec Pre-Validation**:
  All spec generators (`openapi.ts`, `asyncapi.ts`, `openrpc.ts`, `schema.ts`) must run `assertValidSpecDocumentSync(document, specName)` before emitting code.
- **Clean Cutover**:
  When updating an API or codec, migrate every callsite, test, and documentation file. Do not introduce shims or deprecated fallback paths.
- **Dynamic Best-Effort Fallbacks**:
  Erlang, JSON, and validator codecs support `T = unknown` or `any` by emitting dynamic runtime best-effort encoders/decoders (`__wizEncodeErlangTextUnknown`, etc.).

---

## 4. Verification & Testing Instructions

- **Run all tests**:
  ```bash
  bun test
  ```
- **Run a single test file**:
  ```bash
  bun test test/asyncapi.test.ts
  ```
- **Run typecheck**:
  ```bash
  bun run typecheck
  ```

All tests must pass with 0 failures before yielding or committing changes.
