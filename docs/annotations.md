# Annotations

Every JSDoc tag wiz reads, what it becomes in each output, and where it is
allowed to live. Reach for this page when a tag is not showing up in a schema,
when you need the exact range an integer width promises, or when you want to
know whether a tag is *enforced* or merely *written down*. The authoritative
lists live in `src/extractors/typescript.ts` (`CONSTRAINT_TAGS`,
`HANDLED_TAGS`) and `src/ir/types.ts` (`ConstraintKind`, `INTEGER_FORMATS`);
everything below is read from there.

## Three channels

A doc comment is split into three channels the moment it is extracted, and the
split is the whole design. From `src/ir/types.ts`:

> Constraints *validate*. Every kind here is enforced by the generated
> validator and maps onto a JSON Schema assertion keyword. Purely descriptive
> tags (`@example`, `@default`) are annotations instead.

and, on the third channel:

> `meta` is the catch-all for tags wiz does not model — `@since`, `@author`,
> `@internal` and so on — so nothing in a doc comment is silently lost. A bare
> tag records `true`; a tag with text records that text. Values are always
> arrays: `@see` and friends legitimately repeat, and collapsing them would
> discard everything but the last.

So: **constraints** narrow the set of valid values, **annotations** describe a
value without restricting it, and **meta** is verbatim storage for everything
else. The reason to keep them apart rather than pour every tag into one bag is
that only the first channel may generate a rejection. A tag that describes must
never fail a value — `@default 7` on a required property does not make `7` the
only acceptable number, and `test/annotations.test.ts` pins exactly that:

```ts
// `retries` has a default but is still required, and a value that differs
// from the default is still valid.
expect(mod.is({ email: "ada@example.com", retries: 99, /* … */ })).toBe(true);
// @format is enforced, unlike the annotations.
expect(mod.is({ email: "not-an-email", retries: 1, /* … */ })).toBe(false);
```

All three channels are part of the structural hash (`normalizeAnnotations` in
`src/ir/types.ts`). Two types that differ only in their doc comments get
different generated modules, because otherwise deduplication would pick one and
throw the other type's examples away.

## Constraints

Tag names are matched case-insensitively, so `@minLength`, `@minlength` and
`@MINLENGTH` are the same tag. Every kind in `ConstraintKind` appears below.

| Tag | Accepts | Applies to | JSON Schema | Validator |
|---|---|---|---|---|
| `@minimum` / `@min` | number (text if unparseable) | `number`, `bigint` | `minimum` | `v < x` |
| `@maximum` / `@max` | number | `number`, `bigint` | `maximum` | `v > x` |
| `@exclusiveMinimum` | number | `number`, `bigint` | `exclusiveMinimum` | `v <= x` |
| `@exclusiveMaximum` | number | `number`, `bigint` | `exclusiveMaximum` | `v >= x` |
| `@minLength` | number | `string` | `minLength` | code points `< x` |
| `@maxLength` | number | `string` | `maxLength` | code points `> x` |
| `@pattern` | regex source, verbatim | `string` | `pattern` | `new RegExp(src).test(v)` |
| `@format` | format name, verbatim | any — see [`@format`](#format) | `format`, plus bounds for a width | email / uuid regex, or width range |
| `@multipleOf` | number | `number` | `multipleOf` | `!Number.isInteger(v / x)` |
| `@minItems` | number | arrays | `minItems` | `v.length < x` |
| `@maxItems` | number | arrays | `maxItems` | `v.length > x` |
| `@uniqueItems` | bare, or `false` | arrays | `uniqueItems` | deep-equality scan |
| *(kind `min`)* | IR only — no tag emits it | `number`, `bigint` | emitted verbatim as `min` | same as `minimum` |
| *(kind `max`)* | IR only — no tag emits it | `number`, `bigint` | emitted verbatim as `max` | same as `maximum` |

`@min` and `@max` are spellings, not distinct kinds: `CONSTRAINT_TAGS` maps both
to `minimum`/`maximum`, so a TypeScript source can never produce the bare `min`
and `max` kinds. They remain in `ConstraintKind` for IR built by hand or by
another [extractor](./extractors.md), and the validator and the
[zod](./zod.md) generator handle them identically to `minimum`/`maximum`. The
JSON Schema generator does not: it writes `schema[c.kind] = c.value`
unconditionally, so a hand-built `{ kind: "min", value: 3 }` emits
`{"min": 3}`, which no JSON Schema validator reads. Use `minimum`.

Three of the checks need a helper, and each helper exists because the obvious JS
spelling means something different from what JSON Schema means
(`RUNTIME_HELPERS` in `src/generators/validator.ts`):

- `@minLength`/`@maxLength` count **code points**, not UTF-16 units, so an
  emoji is one character rather than two. `"😀😀"` fails `@minLength 3`;
  `"😀😀😀"` passes.
- `@uniqueItems` compares deeply, since `Set` compares objects by reference and
  key order carries no meaning in JSON. The scan is quadratic — it is a pairwise
  `__wizEqual`, so it is a poor fit for a large array.
- `@pattern` compiles through a memoising `Map`, keyed by source. A `Map`
  rather than an object so a pattern of `"__proto__"` cannot reach one.

Patterns are compiled with no flags and no implicit anchoring: `@pattern
^[a-z]+$` anchors because you wrote the anchors.

`@multipleOf` divides rather than taking a remainder, matching JSON Schema and
Ajv: `0.3 % 0.1` is not `0` in binary floating point, and a tolerance here would
accept values the schema rejects.

`@uniqueItems false` is the one constraint value that states *no* requirement.
Both the validator and the zod generator skip it outright rather than emitting a
check that always passes, while JSON Schema still carries `uniqueItems: false`
because the keyword has that meaning.

A constraint whose type family does not match is inert rather than an error.
Each generated check is guarded — `typeof v === "string" && …` for `@pattern`,
`Array.isArray(v) && …` for `@minItems` — so `@minLength 3` on a number never
fires. Nothing warns about it.

In `.proto` output there are no assertion keywords at all, so the description
and every constraint are emitted as `//` comments beside the field:

```proto
message Host {
  // @format int8
  int32 narrow = 2;
}
```

## Descriptive tags

| Source | Lands in | JSON Schema | Notes |
|---|---|---|---|
| free text of the doc comment | `description` | `description` | there is no `@description` tag — see below |
| `@example` | `examples[]` | `examples` | repeatable, order preserved, JSON-parsed |
| `@default` | `default` | `default` | last one wins, JSON-parsed |
| `@deprecated` | `deprecated.isDeprecated` | `deprecated: true` (2020-12) | draft-07 has no keyword — see below |
| `@deprecated <note>` | `deprecated.note` | note folded into `description` (draft-07) | 2020-12 drops the note |

`description` comes from the comment's free text only. **`@description` is not a
modelled tag** — it is not in `CONSTRAINT_TAGS` and not in `HANDLED_TAGS`, so it
falls through to `meta` and is never emitted anywhere:

```ts
/**
 * This becomes the description.
 * @description This lands in meta.description and is emitted nowhere.
 */
name: string;
```

`@example` is the only descriptive tag that accumulates. Every occurrence is
appended, so a property with two `@example` lines gets a two-element
`examples`, and both reach `examples` in JSON Schema and OpenAPI 3.1. OpenAPI
3.0 has a singular `example` instead and takes the first — see
[openapi.md](./openapi.md).

`@deprecated` is a real fork between drafts, because draft-07 has no
`deprecated` keyword and inventing one would be a lie. Draft-2020-12 gets the
boolean; draft-07 gets a description prefix instead:

```ts
/** @deprecated moved */
export interface User { id: number }
```

```json
{ "description": "[DEPRECATED: moved] A user", "type": "object" }
```

Without a note it is `[DEPRECATED]`. Note the asymmetry: draft-2020-12 emits
`deprecated: true` and **discards the note**, because the keyword is a boolean
and the note has nowhere to go that is not the description.

## `@format`

One annotation drives the JSON Schema `format`, the OpenAPI `format`, the
protobuf field type, the Avro type and the Arrow column. The values are the
OpenAPI Format Registry's rather than a per-backend tag, so — quoting
`declaredFormat` in `src/ir/types.ts` — "one annotation decides the JSON Schema
output, the OpenAPI output and the binary width chosen by the protobuf and avro
codecs".

The `format` value is passed through to JSON Schema verbatim, whatever it is.
What differs is how much anything downstream *does* with it. Three tiers:

**Enforced** — the generated validator rejects values that do not conform:

| Format | Check |
|---|---|
| `email` | `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` on strings |
| `uuid` | RFC 4122 8-4-4-4-12 hex pattern on strings |
| `uri` | RFC 3986 scheme-prefixed URI pattern on strings |
| `uri-reference` | RFC 3986 URI reference pattern on strings |
| `uri-template` | RFC 6570 URI template pattern on strings |
| `hostname` | RFC 1123 hostname pattern on strings |
| `ipv4` | IPv4 dotted-quad pattern on strings |
| `ipv6` | RFC 4291 IPv6 pattern on strings |
| `regex` | regular expression compilation check on strings |
| `json-pointer` | RFC 6901 JSON pointer pattern on strings |
| `relative-json-pointer` | RFC 6901 relative JSON pointer pattern on strings |
| every key of `INTEGER_FORMATS` | integrality and range, on `number` and `bigint` |
**Mapped** — no check, but the format selects a different wire type in at least
one codec: `float`, `double`, `date`, `time`, `date-time`, `byte`, `binary`,
`sf-decimal`. See [protobuf.md](./protobuf.md) and
[avro-and-arrow.md](./avro-and-arrow.md) for the per-codec tables.

**Described only** — everything else. `@format hostname`, `@format ipv4`,
`@format weird-thing`: emitted as `format` and nothing more. wiz does not
validate the format name, so a typo is silently a described-only format.

`@format date-time` on a string is in the second tier, which is worth stating
plainly: the generated validator accepts `"not-a-date"` for a `date-time`
field. The format changes the Avro logical type and the JSON Schema `format`
keyword; a downstream JSON Schema validator with format assertions enabled will
check it, and wiz will not.

To enforce date-time validation in wiz:
- **Use native `Date`**: Declare the property as TypeScript `Date` (`createdAt: Date`). Wiz treats `Date` as a native date primitive, enforcing valid `Date` instances in the validator and emitting `format: "date-time"` in schemas.
- **Use `@pattern`**: If the property must remain a string, combine `@format date-time` with `@pattern ^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$` to reject invalid date strings at runtime.

### Integer widths

`INTEGER_FORMATS` in `src/ir/types.ts` is the single table that decides what a
width means, so the validator, the JSON Schema bounds and every codec agree.
Bounds are `bigint` because `int64` and `uint64` exceed what a JS number can
represent exactly, "which is the whole reason a value outside them cannot be
trusted".

| `@format` | min | max |
|---|---|---|
| `int8` | -128 | 127 |
| `int16` | -32768 | 32767 |
| `int32` | -2147483648 | 2147483647 |
| `int64` | -9223372036854775808 | 9223372036854775807 |
| `uint8` | 0 | 255 |
| `uint16` | 0 | 65535 |
| `uint32` | 0 | 4294967295 |
| `uint64` | 0 | 18446744073709551615 |
| `sint32` | -2147483648 | 2147483647 |
| `sint64` | -9223372036854775808 | 9223372036854775807 |
| `sfixed32` | -2147483648 | 2147483647 |
| `sfixed64` | -9223372036854775808 | 9223372036854775807 |
| `fixed32` | 0 | 4294967295 |
| `fixed64` | 0 | 18446744073709551615 |
| `double-int` | -9007199254740991 | 9007199254740991 |
| `sf-integer` | -999999999999999 | 999999999999999 |
| `unixtime` | -9223372036854775808 | 9223372036854775807 |

The protobuf-specific spellings appear because they have to: `sint`/`sfixed`
differ from `int` only in how they are *written* on the wire, not in what they
can hold, so they share a row's worth of range with `int32`/`int64`.

`double-int` is `±(2^53 - 1)` — "exactly the integers a double holds without
loss, which is what the format means, and also the practical limit for any
64-bit width carried by a `number` rather than a `bigint`". `SAFE_INTEGER`
(`9007199254740991n`) is the same boundary, used wherever a `number` has to be
checked against a range that a `number` cannot state.

`float`, `double`, `sf-decimal` are absent from the table on purpose: they are
not integers, so they have no range to promise. `validatorFor("double").is({ v:
1e300 })` is `true`.

### Why declaring a width and not checking it is worse than no width

The comment in `src/generators/validator.ts` is the whole argument:

> A width that is declared and not checked is the worst of both: the codecs
> narrow the value to fit and the wrong number travels.

Concretely, from `test/widths.test.ts`:

```ts
// 3e9 exceeds int32 and is a perfectly ordinary JS number; before this it
// reached the wire as -1294967296.
const validator = validatorFor("int32");
expect(validator.is({ v: 3_000_000_000 })).toBe(false);
```

`3000000000` is a legal `number`. Without the range check it passes validation,
reaches the protobuf codec, gets written as a 32-bit varint, and comes back as
`-1294967296` — a *different value*, with no error anywhere. No width at all
would have made it a `double` and round-tripped it correctly. The declaration is
what caused the corruption, so the declaration is what has to be checked.

So a width produces four things:

- A validator check on `number`: `Number.isInteger(v)` plus the range. A
  fractional value fails an integer width whatever its magnitude.
- A validator check on `bigint`: the full `bigint` range, no integrality check
  needed.
- JSON Schema and OpenAPI `minimum`/`maximum` beside the `format`, so any other
  validator reaches the same verdict.
- The narrowest wire type in each codec that holds the range.

The `number` check clamps its own bounds to `±SAFE_INTEGER`, because "a number
is checked against the range a number can state exactly; past that the value is
already imprecise, whatever the width allows". `@format int64` on a `number`
therefore rejects `9007199254740993`, while the same magnitude as a `bigint`
passes.

The JSON Schema side omits a bound it cannot state exactly rather than rounding
it, since "an approximate bound would reject or admit the wrong values". So
`int8` gets both bounds:

```json
{ "type": "number", "format": "int8", "minimum": -128, "maximum": 127 }
```

while `int64` gets neither, and `uint64` gets `minimum: 0` and no maximum —
`0` is expressible, `2^64 - 1` is not.

## `@fieldNumber`

Protobuf field numbers are the wire contract and cannot be inferred, so they
are declared:

```ts
interface Book {
  /** @fieldNumber 1 */
  title: string;
  /**
   * @fieldNumber 2
   * @format int32
   */
  year: number;
}
```

`@id` and `@tag` are accepted as synonyms. The value goes through
`parseInt(text, 10)` and is kept only if it is not `NaN`, so trailing text is
tolerated and a non-numeric value is ignored rather than reported.

This one tag is read twice — once from the type checker's tags and once from the
raw AST tags of each declaration — because "the checker drops `@fieldNumber` on
some declarations". Only that tag is recovered from the AST, to keep the two
sources from blurring together.

Field numbers are not part of `Annotated`; they live on `PropertyIR.fieldNumber`
and matter only to protobuf, which is where missing numbers, collisions, and
`NumberedUnion` variant numbering are enforced and explained —
[protobuf.md](./protobuf.md).

## How tag values are parsed

There are two parsers, and which one runs depends on the channel.

Constraint values go through `parseJSDocValue`, which switches on the
constraint *kind*:

- Numeric kinds (`min`, `max`, `minimum`, `maximum`, `exclusiveMinimum`,
  `exclusiveMaximum`, `minLength`, `maxLength`, `minItems`, `maxItems`,
  `multipleOf`) run through `Number(trimmed)`, and **fall back to the raw text
  when that is `NaN`**. `@minimum abc` yields `{ kind: "minimum", value:
  "abc" }` and emits `{"minimum": "abc"}` — invalid JSON Schema, no diagnostic.
- `uniqueItems` is boolean: the literal text `false` gives `false`, everything
  else — including an empty tag body — gives `true`.
- `pattern` and `format` keep the trimmed text exactly. A regex source is not
  JSON and must not be parsed as JSON.

Descriptive values go through `parseAnnotationValue`, which tries
`JSON.parse` and falls back to the trimmed text. This is why `@example {
"id": 1 }` becomes an object rather than a string:

```ts
/** @example { "street": "Main St", "zip": "12345" } */
address: { street: string; zip: string };
// examples → [{ street: "Main St", zip: "12345" }]
```

and why the quotes matter in `@example "ada@example.com"` — quoted, it parses to
the string `ada@example.com`; unquoted, `JSON.parse` fails and you get the raw
text, which happens to be the same thing. `@example not json` stays `"not
json"`. `@default [1, 2` stays the string `"[1, 2"`. There is no error for
half-written JSON, only text.

`meta` values are never parsed. They are the trimmed text, or `true`.

## `meta`

`meta` is `Record<string, (string | true)[]>` and receives every tag that is
neither a constraint nor in `HANDLED_TAGS`. `HANDLED_TAGS` is exactly
`deprecated`, `fieldnumber`, `id`, `tag`, `example`, `default` — the tags
consumed by a named field, listed so they cannot leak into `meta` and be
reported twice.

```ts
/**
 * @since 1.4.0
 * @author Ada
 * @author Grace
 * @internal
 */
secret: string;
```

```ts
{ since: ["1.4.0"], author: ["Ada", "Grace"], internal: [true] }
```

Values are arrays because repetition is legitimate. `@see`, `@author` and
`@example` all repeat in ordinary JSDoc, and collapsing them would discard
everything but the last. A bare tag with no body records `true` rather than the
empty string, so `@internal` is distinguishable from `@internal ""`.

`meta` is never emitted into any document. From `src/generators/schema.ts`:
"`meta` is intentionally not emitted: arbitrary JSDoc tags are not JSON Schema
keywords." It exists so that a tool reading the IR — a custom
[generator](./writing-a-generator.md) — can see your tags, and so that nothing
in a doc comment vanishes without a trace.

Two wrinkles. Tag *recognition* lowercases the name, but the `meta` key is the
tag's original spelling, so `@Since` and `@SINCE` on the same property become
two separate keys. And `meta` is `undefined` rather than `{}` when nothing
landed there, as are `constraints` and `examples` when empty — the IR omits
empty containers so they do not perturb the structural hash.

## Where an annotation can live

Both a type and a property carry the full `Annotated` shape, so a doc comment
works in either position:

```ts
/**
 * A user record
 * @example { "id": 1 }
 * @since 2.0.0
 */
export interface User { id: number }
```

For `@format` specifically, `declaredFormat` checks carriers in order — the
property first, then the type it refers to — "which lets a property override the
type it refers to".

The carrier that does *not* work is a type alias to a primitive. TypeScript
erases it: `type Port = number` is `number`, with `number`'s symbol, and the
alias's doc comment is not reachable from the extracted type.

```ts
/**
 * A port number
 * @format uint16
 */
export type Port = number;

interface Host {
  /** @fieldNumber 1 */
  port: Port;      // → plain `number`; no format, no bounds, `double` on the wire
  /**
   * @fieldNumber 2
   * @format int8
   */
  narrow: Port;    // → int8, bounds -128..127
}
```

An alias to a *structural* type keeps its annotations, because there the alias
symbol survives — `type Tags = string[]` with `@minItems 1` and `@uniqueItems`
extracts with its name, description and both constraints intact. So the rule is
narrower than "aliases don't work": aliases to bare primitives don't.

## Limitations

- **Tag values are not validated.** `@minimum abc` becomes
  `{"minimum": "abc"}` in the JSON Schema output, and `@format wierd` becomes a
  described-only format. Nothing warns. A typo produces a document that is
  wrong rather than a build that fails.
- **`@description` is silently inert.** It is not modelled, so it lands in
  `meta` and is emitted nowhere. Use the comment's free text.
- **A type alias to a primitive loses everything** — name, description,
  constraints. Annotate the property instead.
- **A constraint on the wrong type family is a no-op**, not a diagnostic:
  `@minLength` on a number, `@minItems` on a string.
- **Most formats are not enforced.** Only `email`, `uuid` and the integer
  widths are checked. `date-time`, `uri`, `ipv4` and friends are described.
- **`@deprecated` loses its note in draft-2020-12** and loses its boolean
  nature in draft-07, where it becomes a `description` prefix. Neither draft
  represents both halves.
- **`@uniqueItems` is quadratic** with a deep comparison per pair.
- **`@default` does not make a property optional.** It describes; optionality
  is `?` in the type. Nor is a default ever substituted at runtime — wiz
  generates validators, not coercers.
- **`meta` reaches no output.** If you need a custom tag in a document, read
  the IR yourself; see [writing-a-generator.md](./writing-a-generator.md).

See also: [json-schema.md](./json-schema.md) for how constraints land in each
draft, [verification.md](./verification.md) for the corpus that keeps the
validator and the emitted schemas agreeing, and
[type-introspection.md](./type-introspection.md) for what the IR carries beside
annotations.
