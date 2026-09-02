# Type Introspection

Type introspection in `wiz` replaces reflection at compile time. TypeScript types remain pure type annotations in your source code, but `wiz` extracts their structural IR during transpilation and emits zero-dependency functions inline at the callsite.

```ts
import { keysOf, requiredKeysOf, optionalKeysOf, is, validate } from "wiz";

type User = {
  id: string;
  name: string;
  age?: number;
};

keysOf<User>();         // → ["id", "name", "age"]
requiredKeysOf<User>(); // → ["id", "name"]
optionalKeysOf<User>(); // → ["age"]
```

## Property Key Extraction

The `keysOf`, `requiredKeysOf`, `optionalKeysOf`, and `deepKeysOf` functions extract property names from object types.

- **`keysOf<T>()`**: Returns an array containing all string property keys declared on `T`.
- **`requiredKeysOf<T>()`**: Returns an array of keys for non-optional properties (`optional: false`).
- **`optionalKeysOf<T>()`**: Returns an array of keys for optional properties (`optional: true` or `undefined` union).
- **`deepKeysOf<T>(options?: { maxDepth?: number })`**: Returns an array of dot-separated deep property key paths (default `maxDepth: 5`, stopping recursion at nested limit or cycles).
When transformed by the `wiz` plugin, these calls are rewritten directly into static array literals:

```js
// Transpiled output
const keys = ["id", "name", "age"];
```

### Union and Intersection Types

For unions (`A | B`), key extraction operates on the flattened representation:
- Property order follows declaration order.
- Duplicate keys across union members are deduplicated.
- Optionality is determined per property: if a property is optional in any union member, it is treated as optional.

For intersections (`A & B`), later members win when property definitions conflict, matching TypeScript's structural resolution.

## Type Narrowing with `is<T>`

`is<T>(value: unknown)` is a type predicate returning `value is T`. It performs a full structural validation check inlined at the callsite without allocating an error list or throwing exceptions.

```ts
function processInput(input: unknown) {
  if (is<User>(input)) {
    // `input` is narrowed to `User` here
    console.log(input.name.toUpperCase());
  }
}
```

The emitted code tests type discriminators and property shapes directly:

```js
function is_User(arg) {
  if (arg === null || typeof arg !== "object" || Array.isArray(arg)) return false;
  if (typeof arg.id !== "string") return false;
  if (typeof arg.name !== "string") return false;
  if (arg.age !== undefined && typeof arg.age !== "number") return false;
  return true;
}
```

Because `is` is a type predicate, TypeScript narrows `value` within conditional blocks without requiring manual casts.

## Validation with `validate<T>`

`validate<T>(value: unknown, options?: ValidateOptions)` checks a value against `T` and returns a list of validation errors (`ValidationError[]`). If the value is valid, it returns an empty array `[]`.

### In-Place Pruning (`prune: true`)

Pass `options: { prune: true }` to strip undeclared properties from `value` in place during validation (similar to Ajv's `removeAdditional`):

```ts
import { validate } from "wiz";

const data = { id: "u1", name: "Alice", extraField: 123 };
const errors = validate<User>(data, { prune: true });

// `data.extraField` is deleted in place; `errors` is []
console.log(data); // → { id: "u1", name: "Alice" }
```

Levels whose schema explicitly allows additional properties (e.g., `Record<string, unknown>`) leave extra fields intact.

### ValidationError Structure

Each error in the array conforms to the `ValidationError` interface defined in `src/ir/types.ts`:

```ts
export interface ValidationError {
  /** JSON pointer or dot-notation path to the invalid property (e.g., "user.address.zip"). */
  path: string;
  /** Human-readable explanation of why validation failed. */
  message: string;
  /** The constraint keyword that was violated (e.g., "required", "minLength", "format"). */
  constraint?: string;
  /** Expected type or value. */
  expected?: unknown;
  /** Actual value encountered during validation. */
  actual?: unknown;
}
```

### Path Construction for Nested Data

When validating nested objects or array items, error paths are constructed hierarchically using dot notation and array indices:

```ts
type Order = {
  id: string;
  items: { sku: string; quantity: number }[];
};

const errors = validate<Order>({
  id: "ord_100",
  items: [{ sku: "A1", quantity: "two" }],
});

// errors[0].path === "items.0.quantity"
// errors[0].message === "Expected primitive matching specification"
// errors[0].actual === "two"
```

## Query String Parsing with `parseQuery<T>`

`parseQuery<T>(input: unknown, options?: ValidateOptions)` converts raw query string inputs into typed object `T`:

- **Input Types**: Accepts a `string` (e.g. `"?page=1&active=true"`), a `URLSearchParams` instance, or a raw record.
- **Type Coercion**: Automatically coerces string field values to declared numbers, bigints, booleans, dates, and arrays.
- **Validation & Errors**: Runs `validate<T>` over the coerced result. Throws `QueryValidationError` containing `errors: ValidationError[]` on failure.

```ts
import { parseQuery, QueryValidationError } from "wiz";

type SearchQuery = {
  page?: number;
  active?: boolean;
  tags?: string[];
};

try {
  const query = parseQuery<SearchQuery>("?page=2&active=true&tags=a&tags=b");
  console.log(query); // → { page: 2, active: true, tags: ["a", "b"] }
} catch (err) {
  if (err instanceof QueryValidationError) {
    console.error("Invalid query:", err.errors);
  }
}
```
## Type Assertion with `assert<T>`

`assert<T>(value: unknown, options?: ValidateOptions): asserts value is T` validates `value` against `T`. If valid, it narrows `value` to `T` at the callsite. If invalid, it throws an `AssertError` carrying `errors: ValidationError[]`.

```ts
import { assert } from "wiz";

function processUserData(input: unknown) {
  assert<User>(input);
  // `input` is now narrowed to `User`
  console.log(input.name);
}
```
## Relationship Between `is` and `validate`

`is` and `validate` share identical validation logic generated from the same TypeIR:
- `validate` accumulates detailed `ValidationError` objects for every failure path.
- `is` executes `validate(arg).length === 0` under the hood (or an optimized boolean check that short-circuits on the first failure).

Both functions enforce constraints declared via JSDoc annotations such as `@minLength`, `@min`, `@pattern`, and `@format`.

## Limitations

- **Function Types**: Function properties cannot be structurally validated at runtime beyond verifying `typeof fn === "function"`.
- **Generics**: Generic type parameters must be fully instantiated at the callsite (`is<User>(x)`). Uninstantiated generic parameters `is<T>(x)` cannot be extracted at compile time.
