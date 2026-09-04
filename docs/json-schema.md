# JSON Schema Generation

`wiz` generates standard JSON Schema documents at compile time directly from your TypeScript type definitions using `jsonSchema<T>()` and `jsonSchemas<[...T]>()`.

```ts
import { jsonSchema, jsonSchemas } from "wiz";

type User = {
  id: string;
  name: string;
  age?: number;
};

type Product = {
  sku: string;
  price: number;
};

// Single schema for one type
const userSchema = jsonSchema<User>();

// Metaschema document containing multiple types under $defs
const allSchemas = jsonSchemas<[User, Product]>();
```

## Call Forms

### `jsonSchema<T>()`

`jsonSchema<T>()` generates a single JSON Schema object for a type and supports draft selection via type arguments or optional function arguments:

```ts
// Draft 2020-12 (default)
const s1 = jsonSchema<User>();
const s2 = jsonSchema<User, "draft-2020-12">();
const s3 = jsonSchema<User>("draft-2020-12");

// Draft 07
const s4 = jsonSchema<User, "draft-07">();
const s5 = jsonSchema<User>("draft-07");
```

### `jsonSchemas<[...T]>()`

`jsonSchemas<[...T]>()` generates a meta-schema document containing all named types under `$defs` (for Draft 2020-12) or `definitions` (for Draft 07):

```ts
// Draft 2020-12 (default: returns {$schema: "https://json-schema.org/draft/2020-12/schema", $defs: { User: {...}, Product: {...} }})
const doc1 = jsonSchemas<[User, Product]>();

// Draft 07 (returns {$schema: "http://json-schema.org/draft-07/schema#", definitions: { User: {...}, Product: {...} }})
const doc2 = jsonSchemas<[User, Product]>("draft-07");
```

The plugin inspects call arguments and emits static JSON Schema objects inline in the transpiled output.

## TypeIR to JSON Schema Mapping

Every TypeScript type construct maps onto standard JSON Schema keywords as defined in `src/generators/schema.ts`:

| TypeScript / TypeIR | JSON Schema Keyword(s) | Notes |
|---|---|---|
| `string` | `{ "type": "string" }` | |
| `number` | `{ "type": "number" }` | |
| `boolean` | `{ "type": "boolean" }` | |
| `bigint` | `{ "type": "string", "format": "int64", "pattern": "^-?\\d+$" }` | Follows proto3 JSON mapping convention (BigInt cannot travel as a standard JSON number without loss of precision). |
| `bytes` (`Uint8Array`) | `{ "type": "string", "contentEncoding": "base64" }` (2020-12)<br>`{ "type": "string", "format": "byte" }` (07) | Binary data encoded as base64 string. |
| `Date` | `{ "type": "string", "format": "date-time" }` | ISO 8601 string representation. |
| `null` | `{ "type": "null" }` | |
| `undefined` / `void` / `never` | `{ "not": {} }` | Represents an unmatchable schema branch. |
| `any` / `unknown` | `{}` | Matches any valid JSON value. |
| Literal (`"hello"`, `42`) | `{ "const": "hello" }` / `{ "const": 42 }` | BigInt consts are stringified with `int64` format. |
| `enum E` | `{ "enum": ["VAL1", "VAL2"] }` | Values are extracted from enum member declarations. |
| `Array<T>` | `{ "type": "array", "items": { ... } }` | |
| `Tuple [A, B]` | `{ "type": "array", "prefixItems": [...], "items": false }` (2020-12)<br>`{ "type": "array", "items": [...], "additionalItems": false }` (07) | Tuple rest elements set `items` / `additionalItems` to the rest element schema. |
| `Union A \| B` | `{ "anyOf": [...] }` or `{ "oneOf": [...] }` | Discriminated unions emit `oneOf` with `discriminator`. Unions of literals collapse to `{ "enum": [...] }`. |
| `Intersection A & B` | `{ "allOf": [...] }` | |
| `Record<string, T>` | `{ "type": "object", "additionalProperties": { ... } }` | |
| Object `{ a: T }` | `{ "type": "object", "properties": { ... }, "required": [...] }` | `required` lists non-optional properties. |
| Named Type Reference | `{ "$ref": "#/$defs/TypeName" }` | Used in multi-type schema generation. |

## Draft Differences

`wiz` handles keyword variations between JSON Schema drafts automatically:

1. **Tuples**: Draft 2020-12 uses `prefixItems` for positional elements and `items` for additional/rest items. Draft 07 uses array-valued `items` and `additionalItems`.
2. **Binary Data**: Draft 2020-12 uses `contentEncoding: "base64"`. Draft 07 uses `format: "byte"`.
3. **Deprecation**: Draft 2020-12 emits standard `deprecated: true`. Draft 07 prepends `[DEPRECATED]` to the `description` keyword.

## Constraints and JSDoc Annotations

JSDoc tags attached to type properties automatically translate into JSON Schema assertion keywords:

```ts
type Product = {
  /**
   * @minLength 3
   * @maxLength 50
   * @pattern ^[A-Z0-9]+$
   */
  sku: string;

  /**
   * @min 0
   * @max 1000
   */
  price: number;
};
```

Emitted schema:

```json
{
  "type": "object",
  "properties": {
    "sku": {
      "type": "string",
      "minLength": 3,
      "maxLength": 50,
      "pattern": "^[A-Z0-9]+$"
    },
    "price": {
      "type": "number",
      "minimum": 0,
      "maximum": 1000
    }
  },
  "required": ["sku", "price"]
}
```

See [annotations](./annotations.md) for the complete list of supported JSDoc tags.

## Verification

`wiz` verifies its JSON Schema generator against independent tools:
- Generated schemas are validated against the official JSON Schema meta-schemas.
- [Ajv](https://ajv.js.org) compiles emitted schemas and runs against a shared test corpus alongside the generated `validate` function.
- The validator generator is verified against the official [JSON Schema Test Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite).

See [verification](./verification.md) for details.
