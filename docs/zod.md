# zod

`zodSchema<T>()` builds a real zod schema from the same IR that produces the
JSON Schema and the generated validator. Reach for it when something downstream
already speaks zod — a form library, `zod-to-openapi`, a tRPC router — and you
would rather not hand-write a second description of a type you already have.

## The call

```ts
import { zodSchema } from "wiz";

interface User {
  /** @minLength 2 */
  id: string;
  age?: number;
  tags: string[];
  kind: "a" | "b";
}

const userSchema = await zodSchema<User>();

userSchema.parse({ id: "ab", tags: ["x"], kind: "a" });
// → { id: "ab", tags: ["x"], kind: "a" }

const result = userSchema.safeParse({ id: "a", tags: ["x"], kind: "a" });
result.success; // → false
```

The object that comes back is a `ZodObject` from your own copy of zod, so the
error shape is zod's, not wiz's:

```json
[
  {
    "code": "too_small",
    "minimum": 2,
    "type": "string",
    "inclusive": true,
    "exact": false,
    "message": "String must contain at least 2 character(s)",
    "path": ["id"]
  }
]
```

The declared return type is `Promise<ZodSchemaLike<T>>`, and `ZodSchemaLike` is
deliberately thin:

```ts
export interface ZodSchemaLike<T> {
  parse(data: unknown): T;
  safeParse(
    data: unknown
  ): { success: true; data: T } | { success: false; error: unknown };
}
```

It is declared structurally because wiz must never import zod, not even as a
type: a `import type { ZodType } from "zod"` in `src/index.ts` would make zod a
required dependency for everybody who typechecks against wiz, including the
majority who never call `zodSchema`. The value at runtime is a complete zod
schema, so anything else zod offers — `.pick()`, `.partial()`, `.shape`,
`.parseAsync()` — is reachable by widening the type at the callsite:

```ts
import type { ZodObject, ZodRawShape } from "zod";

const schema = (await zodSchema<User>()) as unknown as ZodObject<ZodRawShape>;
schema.pick({ id: true });
```

## Why a promise, and why the module never names zod

zod is an **optional** peer dependency:

```json
"peerDependencies": { "zod": "^3.24.0" },
"peerDependenciesMeta": { "zod": { "optional": true } }
```

Every other back end emits a self-contained module. This one cannot, because a
generated module is *virtual*: the plugin mounts it under
`./wiz-virtual/<key>/index.js`, and that path has no place on disk to resolve a
package from. An `import { z } from "zod"` written inside it would resolve
against nothing.

So the generated module takes the loader as an argument, and the plugin writes
`() => import("zod")` at the callsite, inside the consumer's own file, where
`zod` does resolve. Given the source above in `app.ts`, the transform emits:

```ts
import { zodSchema as __wiz_zodSchema_43b12ec8_app_ts_User_df71fc12 } from "./wiz-virtual/43b12ec8_app_ts_User_df71fc12/index.js";
import { zodSchema } from "wiz";
export interface User {
    /** @minLength 2 */
    id: string;
    age?: number;
    tags: string[];
    kind: "a" | "b";
}
export const userSchema = __wiz_zodSchema_43b12ec8_app_ts_User_df71fc12(() => import("zod"));
```

and the zod section of that virtual module is, verbatim:

```js
let __wizZodSchema;
// zod is loaded by the caller: the plugin writes the loader at the
// callsite, so the package resolves where that file lives, not in here.
export const zodSchema = (load) =>
  (__wizZodSchema ??= (async () => {
    const { z } = await load();
    return z.object({ id: z.string().min(2), age: z.union([z.undefined(), z.number()]).optional(), tags: z.array(z.string()), kind: z.union([z.literal("a"), z.literal("b")]) });
  })());
```

Three consequences fall out of that shape.

**Nothing is loaded until it is asked for.** The loader stays a dynamic
`import()`, so zod is fetched on the first call and never at all if the schema
goes unused. A program that asks for no zod schema neither loads zod nor needs
it installed — which is the whole point of an optional peer dependency.

**The promise is memoised per module.** `__wizZodSchema ??=` caches the
async IIFE, and identical types share one generated module, so `zodSchema<User>()`
in two files returns the *same* promise and the same schema object. The
`test/zod.test.ts` case is `expect(await mod.zodSchema(load)).toBe(await mod.zodSchema(load))`.
Memoisation is unconditional, so a schema that throws while being built (see
[what zod cannot express](#what-zod-cannot-express)) yields the same rejected
promise on every subsequent call rather than retrying.

**Wanting zod is part of the module's identity.** `registerType` keys a module
by its type hash plus a `payloadKey` over everything that changes the emitted
code, and `z: options.zod ?? false` is one of those fields. Without it,
`keysOf<User>()` and `zodSchema<User>()` in one file would hash to a single
module — the same type — and whichever transformed last would silently redefine
the other, one of them missing the zod section. The plugin test asserts
`modules.size === 2` for exactly that source. See
[architecture](./architecture.md) for the registry.

`zodSchema` is the only call in wiz that reaches for a package. Called without
the plugin active it throws `PluginInactiveError`, like every other helper —
see [getting started](./getting-started.md).

## The IR-to-zod mapping

Every branch of `src/generators/zod.ts`. `zodFor` is `baseFor` followed by
`described`, so any node carrying a `description` gets a trailing
`.describe(...)`.

| IR kind | zod |
|---|---|
| `primitive string` | `z.string()` |
| `primitive number` | `z.number()` |
| `primitive bigint` | `z.bigint()` |
| `primitive boolean` | `z.boolean()` |
| `primitive null` | `z.null()` |
| `primitive undefined` | `z.undefined()` |
| `primitive void` | `z.void()` |
| `primitive never` | `z.never()` |
| `primitive unknown` | `z.unknown()` |
| `primitive any` | `z.any()` |
| `primitive bytes` (`Uint8Array`) | `z.instanceof(Uint8Array)` |
| `primitive date` (`Date`) | `z.date()` |
| `primitive symbol` | throws — see below |
| `literal` | `z.literal(v)`, bigint as `1n` |
| `enum`, 0 members | `z.never()` |
| `enum`, 1 member | `z.literal(v)` |
| `enum`, all string members | `z.enum([...])` |
| `enum`, any non-string member | `z.union([z.literal(…), …])` |
| `object` | `z.object({ … })`, see below |
| `array` | `z.array(element)` |
| `tuple`, fixed | `z.tuple([...])` |
| `union`, 0 members | `z.never()` |
| `union`, 1 member | that member, unwrapped |
| `union`, n members | `z.union([...])` |
| `intersection`, 0 members | `z.unknown()` |
| `intersection`, n members | left-folded `z.intersection(a, b)` |
| `record` | `z.record(keyType, valueType)` |
| `ref` | `z.any()` |

`Uint8Array` becomes an `instanceof` check rather than a structural one because
that is what the type means; the JSON Schema back end has to call it a base64
string instead, which is the sort of divergence [json-schema](./json-schema.md)
documents.

A **numeric enum** cannot use `z.enum`, which takes string members only, so it
becomes a union of literals. Both directions are real:

```ts
enum Colour { Red = "red", Blue = "blue" }
enum Level { Low = 1, High = 2 }

// colour: z.enum(["red", "blue"])
// level:  z.union([z.literal(1), z.literal(2)])
```

An **`undefined` member of a union survives**, unlike in the JSON Schema back
end, which drops it because JSON has no such value. zod can name the type, so
dropping it would widen what the schema accepts. This is why `age?: number`
above emitted `z.union([z.undefined(), z.number()]).optional()` — the union is
the property's type, the `.optional()` is its optionality, and they are two
separate facts.

An **intersection folds left**, so `A & B & C` is
`z.intersection(z.intersection(A, B), C)`. zod has no n-ary intersection.

A **`ref` becomes `z.any()`**, and accepts. A ref is either a second sighting of
a type already described in full at its own site, or a cycle — and no finite
inline schema can restate a cycle. The generated validator answers `true` in the
same position for the same reason, so the two agree; see
[type introspection](./type-introspection.md). In practice this means recursion
is not checked past the first level:

```ts
interface Tree { name: string; children: Tree[] }
// → z.object({ name: z.string(), children: z.array(z.any()) })
```

If you need a recursive zod schema, `z.lazy()` is the tool, and you have to
write it yourself.

### Objects

Properties are keyed bare when the name is a valid identifier and quoted
otherwise (`"odd-key": z.string()`). Optional properties get `.optional()`.

A property's own constraints are applied on top of its type's, exactly as the
JSON Schema back end does it, and descriptions layer the same way: the type's
`.describe()` first, then the property's, so the property's doc comment wins.

```ts
/** An inner thing. */
interface Inner { flag: boolean }

interface A {
  /** The inner one. */
  inner: Inner;
}
// → z.object({
//     inner: z.object({ flag: z.boolean() })
//       .describe("An inner thing.").describe("The inner one.")
//   })
```

Unknown keys follow `additionalProperties` in the IR:

| `additionalProperties` | zod | reached by |
|---|---|---|
| absent | `z.object({ … })` | an ordinary interface |
| a type | `.catchall(T)` | a string index signature |
| `true` | `.passthrough()` | an untyped index signature or JSON Schema `true` |
| `false` | `.strict()` | JSON Schema / OpenAPI `additionalProperties: false` |

The `true` and `false` forms arrive mainly from the [extractors](./extractors.md),
where a JSON Schema states them outright. A plain TypeScript index signature
gives `.catchall`:

```ts
interface A { known: string; [k: string]: unknown }
// → z.object({ known: z.string() }).catchall(z.unknown())
```

Note that a bare `z.object` in zod 3 **strips** unknown keys on `parse` rather
than rejecting them, so the returned value is not the input:

```ts
userSchema.parse({ id: "ab", tags: [], kind: "a", extra: 1 });
// → { id: "ab", tags: [], kind: "a" }
```

wiz's own `validate`/`is` ignore extra keys too, so the *verdict* matches; only
zod also rewrites the value.

## Constraints

The [annotations](./annotations.md) that narrow a type reach the schema as
method calls. Which method depends on the family of the node being constrained —
`string`, `number`, `bigint` or `array` — and a constraint that does not belong
to the family it landed on is dropped rather than guessed at.

| tag | `string` | `number` | `bigint` | `array` |
|---|---|---|---|---|
| `@min` / `@minimum` | — | `.min(n)` | `.min(n n)` | — |
| `@max` / `@maximum` | — | `.max(n)` | `.max(n n)` | — |
| `@exclusiveMinimum` | — | `.gt(n)` | `.gt(n n)` | — |
| `@exclusiveMaximum` | — | `.lt(n)` | `.lt(n n)` | — |
| `@multipleOf` | — | `.multipleOf(n)` | — | — |
| `@minLength` | `.min(n)` | — | — | — |
| `@maxLength` | `.max(n)` | — | — | — |
| `@pattern` | `.regex(new RegExp(…))` | — | — | — |
| `@minItems` | — | — | — | `.min(n)` |
| `@maxItems` | — | — | — | `.max(n)` |
| `@uniqueItems` | — | — | — | `.refine(…)` |
| `@format` | `.email()` / `.uuid()` | `.int()` + bounds | bounds | — |

```ts
interface A {
  /**
   * @exclusiveMinimum 0
   * @exclusiveMaximum 1
   * @multipleOf 0.25
   */
  x: number;
}
// → z.object({ x: z.number().gt(0).lt(1).multipleOf(0.25) })
```

`@uniqueItems` is the one constraint zod has no method for, so it becomes a
`.refine()` against a helper emitted into the module only when something needs
it:

```js
    const __wizUnique = (items) => {
      const seen = new Set(items.map((item) => JSON.stringify(item)));
      return seen.size === items.length;
    };
    return z.object({ tags: z.array(z.string()).min(1).max(4).refine(__wizUnique, { message: "Array items must be unique" }) });
```

Equality is by `JSON.stringify`, which is weaker than the validator's
`__wizEqual` — key order matters, and `undefined` members vanish — but it needs
no helper of its own inside a schema chain. `.refine()` also turns a schema into
a `ZodEffects`, which no longer carries the per-family methods, so it is always
appended last regardless of tag order.

**`@uniqueItems false` imposes nothing.** It states no requirement, so honouring
it as a requirement would reject data the type allows. `test/zod.test.ts` pins
this: `{ tags: ["a", "a"] }` is accepted.

### `@format` and integer widths

Only two string formats become checks — `email` and `uuid` — because those are
the only two the generated validator enforces. Every other `@format` value on a
string is documentation, and inventing a check nobody declared would reject data
the type allows. `@format date-time` on a `string` therefore adds nothing here,
even though it does appear in the JSON Schema output.

On a numeric node, `@format` names an integer width, and a width is a range:

```ts
interface A {
  /** @format int32 */  i32: number;
  /** @format uint8 */  u8: number;
  /** @format int64 */  i64: bigint;
  /** @format uint64 */ u64: bigint;
}
// i32: z.number().int().min(-2147483648).max(2147483647)
// u8:  z.number().int().min(0).max(255)
// i64: z.bigint().min(-9223372036854775808n).max(9223372036854775807n)
// u64: z.bigint().min(0n).max(18446744073709551615n)
```

A `bigint` gets both bounds always, since a BigInt holds any of them exactly.

A `number` gets `.int()` plus **only the bounds a double holds exactly**. The
generator compares each end against `SAFE_INTEGER` (2^53 − 1) and omits the ones
that do not fit, rather than rounding them: a rounded bound admits or rejects
the wrong values, which is worse than no bound at all.

```ts
interface A {
  /** @format int64 */    n: number;
  /** @format uint64 */   u: number;
  /** @format unixtime */ t: number;
  /** @format sint32 */   s: number;
}
// n: z.number().int()
// u: z.number().int().min(0)              // 0 is exact; 2^64-1 is not
// t: z.number().int()
// s: z.number().int().min(-2147483648).max(2147483647)
```

`uint64` on a `number` keeps its lower bound and loses its upper one, because
only one end of that range survives as a double. `double-int` and `sf-integer`
keep both, being defined inside the safe range already. The
[format table](./annotations.md) lists every width.

## What zod cannot express

Three constructs have no zod spelling, and the generator emits an expression
that throws instead of an approximation:

```js
(() => { throw new Error("[wiz] zod cannot express a tuple with a rest element"); })()
```

- **a tuple with a rest element** — a `z.tuple` is fixed length, with no way to
  say "and then more of these"
- **a tuple with optional members** — likewise no way to leave one out
- **a symbol** — it has no value shape to check

The throw sits inside the async IIFE, so the failure surfaces as a rejected
promise when the schema is built, before any data is seen:

```ts
await expect(mod.zodSchema(load)).rejects.toThrow(
  "[wiz] zod cannot express a tuple with a rest element"
);
```

That is the same choice the [protobuf](./protobuf.md) codec makes for a missing
`@fieldNumber`: refuse loudly at build time rather than produce a codec that
writes the wrong bytes. A schema that quietly accepts what the type forbids is
the bug worth paying a hard failure to avoid, because it fails much later and
somewhere else.

Note that the TypeScript extractor flattens a rest tuple into a fixed one in
most positions, so the rest branch is easier to reach from an extracted IR than
from a `.ts` source. Optional tuple members reach it directly:

```ts
type T = [string, number?];
// → throws: [wiz] zod cannot express a tuple with optional elements
```

## Pinned to the generated validator

The schema and the validator come from one IR and are two independent
translations of it, so nothing else was checking that they agree — the same gap
Ajv fills for the validator, described in [verification](./verification.md).
`test/zod.test.ts` closes it by running a corpus through both and asserting the
same verdict for each case:

```ts
const schema = await evalModule<ZodModule>(generateZodSchemaCode(ir)).zodSchema(load);
const { validate } = evalModule<{ validate: (v: unknown) => unknown[] }>(
  generateValidatorCode(ir)
);

for (const value of CASES) {
  expect({ value, zod: accepts(schema, value) })
    .toEqual({ value, zod: validate(value).length === 0 });
}
```

The corpus covers a valid object, each constraint violated in turn, a wrong
literal, a missing required property, a wrong primitive type and a bad nested
value. It is asserted as an object containing `value` so a failure names which
case diverged rather than just printing `true !== false`.

## Installing zod

zod is not installed with wiz. Add it when you want a zod schema:

```bash
bun add zod
```

The pin is `^3.24.0`. `zod` is listed under `peerDependenciesMeta` as optional,
so package managers will not warn about its absence.

## Limitations

- **zod 3 only.** The emitted chain uses `.email()`, `.uuid()`,
  `.passthrough()`, `.strict()` and `.catchall()`, which zod 4 deprecated or
  moved. There is no version detection: the generator writes one dialect.
- **Recursion is unchecked past the first level.** A `ref` is `z.any()`, so a
  self-referential type validates its outer layer and accepts anything inside.
  Cycles need `z.lazy()`, written by hand.
- **`@uniqueItems` compares by `JSON.stringify`.** Key order and `undefined`
  members change the answer, so it is weaker than the validator's structural
  equality on objects. On arrays of primitives — the usual case — they agree.
- **String formats other than `email` and `uuid` add no check**, matching the
  generated validator rather than the JSON Schema output.
- **Upper bounds beyond 2^53 are dropped on a `number`.** `@format uint64` on a
  `number` checks only `.int().min(0)`. Use a `bigint` if the bound matters.
- **`parse` rewrites the value.** A bare `z.object` strips unknown keys, so the
  result is not reference-equal to the input and may have fewer keys. Use
  `.passthrough()` semantics — an index signature — if you need them kept.
- **The memoised promise caches failures.** A schema that throws while being
  built rejects identically forever; there is no retry and no way to clear it.
- **`ZodSchemaLike` exposes only `parse` and `safeParse`.** Everything else
  needs a cast, which is the price of not making zod a required typecheck
  dependency for every wiz user.
