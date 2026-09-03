# Front-End Extractors

`wiz` uses front-end extractors to convert source code, schemas, and API specifications into a unified Intermediate Representation (IR).

```
TypeScript types   ──┐
OpenAPI documents  ──┼──> [ Extractor ] ──> TypeIR / ServiceIR / ApiIR
.proto files       ──┘
```

Because extractors and generators meet at the IR boundary, any generator can read the output of any extractor.

## Available Extractors

### 1. TypeScript Extractor (`extractTypeIR`)

The TypeScript extractor (`src/extractors/typescript.ts`) reads TypeScript AST nodes via the TypeScript Compiler API (`ts.TypeChecker`).

- **Resolved Types**: Aliases, generics, interfaces, unions, intersections, literals, enums, tuples, `Date`, `Uint8Array`, and index signatures.
- **Deduplication and `ref` Nodes**: Repeated sightings of a type in the same extraction graph emit a `kind: "ref"` node pointing to the original type's `id`.
- **Well-Known Types**: `Date` extracts as primitive `date`; `Uint8Array`, `Buffer`, and `ArrayBuffer` extract as primitive `bytes`.

```ts
import { extractTypeIR } from "wiz/extractors/typescript";

const typeIR = extractTypeIR(tsType, typeChecker);
```

### 2. OpenAPI Extractor (`extractApiIR`)

The OpenAPI extractor (`src/extractors/openapi.ts`) parses OpenAPI 3.0 and 3.1 JSON/YAML documents into `ApiIR`.

- **Component Registries**: `components.schemas`, `parameters`, `responses`, and `headers` are preserved as registries rather than dereferenced away, allowing generators to retain model identity.
- **Dialect Handling**: Handles 3.0 `nullable` and 3.1 type arrays (`["string", "null"]`), `format: byte` and `contentEncoding: base64`.

```ts
import { extractApiIR } from "wiz/extractors/openapi";

const apiIR = extractApiIR(jsonOrYamlString);
```

### 3. Protobuf Extractor (`extractProtoIR`)

The Protobuf extractor (`src/extractors/proto.ts`) is a hand-written, dependency-free `.proto` file tokenizer and parser.

- **Supported Constructs**: `syntax = "proto3"` and `proto2`, messages, enums, `oneof`, `map`, `repeated`, `optional`, scalar widths, and proto2 `required` / `default`.
- **Recursive Imports**: Resolves imported `.proto` files recursively.
- **Well-Known Types**: Synthesizes Google well-known types (`Timestamp`, `Duration`, `Empty`, `FieldMask`, wrapper types) as standard message structures.

```ts
import { extractProtoIRFromFile } from "wiz/extractors/proto";

const apiIR = await extractProtoIRFromFile("service.proto");
```
### 4. Signature & Service Harvesters (`openapiSchema`, `asyncapiSchema`, `openRPCSchema`, `mcpSchema`)

The type harvester (`src/harvest.ts`) extracts service methods, parameter shapes and response schemas directly from the generic type arguments of each spec macro. There are no builder functions: a type argument is either a function signature type or an interface/class whose members are callable.

- **Function Signature Types**: Extract a single operation. Names derive from JSDoc `@name` if present, otherwise from the function/type name (`toSnakeCase` applied for MCP tools).
- **Service Object Types**: Extract every callable member of an interface or class type.
  - `openapiSchema`: verb and path come from `@get`/`@post`/… or `@http`; responses from `@response STATUS [MEDIATYPE] [TYPE] [DESCRIPTION]`; `x-service`/`x-package` and the operation tag from `@service`/`@package`.
  - `asyncapiSchema`: channel from `@channel`, direction from `@producer`/`@consumer`/`@action`; the channel key is prefixed with `@package`/`@service`.
  - `openRPCSchema`: namespaces methods as `${package}.${service}.${methodName}`, falling back to `${ServiceName}.${methodName}` (unless overridden by `@name` on member JSDoc).
  - `mcpSchema`: namespaces tool names as `${package}.${service}.${toSnakeCase(methodName)}` (unless overridden by `@name` on member JSDoc).
- **Payload Types**: A type argument with no callable members contributes a component schema and no operation. `openapiSchema` and `asyncapiSchema` accept these silently, since a components-only document is a normal use.
- **0-Method Warning**: `openRPCSchema` and `mcpSchema` log a diagnostic (`no methods found on object type '<typeName>' for openRPCSchema` / `mcpSchema`) for an object type with no callable members, since those macros describe nothing else.

## Diagnostics (`ApiDiagnostic`)

Extractors report dropped keywords or unsupported constructs via `ApiDiagnostic` arrays rather than silently discarding them or failing silently.

```ts
export interface ApiDiagnostic {
  /** JSON pointer into the source document (e.g., "#/components/schemas/User/not"). */
  pointer: string;
  /** The offending keyword or construct (e.g., "not", "minProperties"). */
  keyword: string;
  /** Human-readable description of what was dropped. */
  message: string;
}
```

Diagnostics are exposed in `ApiIR.diagnostics` and logged to `stderr` during code generation.
