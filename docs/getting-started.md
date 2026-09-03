# Getting started

wiz reads your TypeScript types during transpilation and replaces the call with
generated code, so `keysOf<User>()` becomes an array literal and `is<User>(x)`
becomes an inlined structural check. That happens in a Bun plugin, which is the
one thing worth understanding before anything else: wiz is a build-time
transform, and an installation that skips the plugin gets no working helper at
all.

## Nothing runs without the plugin

The functions exported from `wiz` are stubs. Every one of them throws:

```ts
// src/index.ts
export function keysOf<T>(): (keyof T)[] {
  throw new PluginInactiveError("keysOf");
}
```

Call one with no plugin registered and you get the name of the function you
called, not a plausible empty array:

```
PluginInactiveError
[wiz] Function 'keysOf' called without active Bun plugin. Please enable
'wizPlugin()' in your Bun runtime or build configuration.
```

That is deliberate. A reflection library that returns `[]` when it is
misconfigured produces a program that runs and is wrong; one that throws
produces a stack trace pointing at the callsite. The exceptions are the
route helpers, which are identity functions by design so that an app without
the plugin still serves — `openapiSchema.bunRoutes`/`honoRoutes` hand back the
router. See [openapi](./openapi.md). `NumberedUnion` is type-level and has no
runtime existence to begin with.

## Install

```bash
bun add wiz
bunx wiz init
```

`wiz init` is the whole setup. On a fresh project it prints:

```
  wrote wizPlugin.ts
  created bunfig.toml (preload, [test] preload)

Done. Bun will load the plugin on the next run.
```

Two files. `wizPlugin.ts` is written verbatim as:

```ts
import { plugin } from "bun";
import { wizPlugin } from "wiz/plugin";

// Registered before your code loads, so wiz can rewrite the type helpers as
// each module is transpiled. Pass a logger to change where diagnostics go.
plugin(wizPlugin());
```

and `bunfig.toml` gets the preload entry twice:

```toml
preload = ["./wizPlugin.ts"]

[test]
preload = ["./wizPlugin.ts"]
```

Both entries matter. `bun run` reads the root table and `bun test` reads
`[test]`, and neither implies the other — a project with only the root entry
has a working app and a test suite where every helper throws.

### Re-running is safe

`init` merges; it never replaces. Given an existing config:

```toml
# keep this comment
preload = ["./other.ts"]

[test]
root = "./spec"
```

it produces:

```toml
# keep this comment
preload = ["./other.ts", "./wizPlugin.ts"]

[test]
preload = ["./wizPlugin.ts"]
root = "./spec"
```

The comment, the unrelated `root` key and the existing preload all survive,
because the file is read with `Bun.TOML.parse` but *written* as a text edit
against the original bytes. Bun ships a TOML parser and no serializer, so
round-tripping through a parsed object would silently reformat someone's
config. `./x.ts` and `x.ts` count as the same entry, so nothing is added twice.

A second run reports what it found and changes nothing:

```
  wizPlugin.ts already exists, left alone (use --force to replace it)
  bunfig.toml already preloads ./wizPlugin.ts

Already set up; nothing to do.
```

`--force` (or `-f`) is only about `wizPlugin.ts`: it overwrites an existing one
with the stock source instead of leaving your edited copy alone. It has no
effect on `bunfig.toml`, which is merged either way.

If a `preload` key exists but the text editor cannot place it safely, `init`
fails with a message telling you to add the entry by hand, rather than
writing a second `preload` and corrupting the file.

### The resolution warning

`init` finishes by checking that `wiz/plugin` resolves from the project. When
it does not, it says so:

```
  warning: 'wiz' does not resolve from here yet - run 'bun add wiz', or bun
  will fail to load wizPlugin.ts
```

This is not cosmetic. The preload now runs on *every* bun command in the
directory, so an unresolvable import turns into a hard failure on all of them,
including the next `wiz init`:

```
error: Cannot find module 'wiz/plugin' from '/tmp/wizinit/wizPlugin.ts'
```

Run `bun add wiz` and the warning goes away. If you ran `init` first out of
order, that error is what you are looking at.

## Doing it by hand

Nothing about the generated files is magic, and a project that does not want a
generated preload can write the same two things itself. The plugin lives behind
the `wiz/plugin` export, separate from the runtime entry point, because it
pulls in the TypeScript compiler and importing `wiz` must never drag that into
an app bundle.

```ts
// wizPlugin.ts
import { plugin } from "bun";
import { wizPlugin } from "wiz/plugin";

plugin(wizPlugin());
```

```toml
# bunfig.toml
preload = ["./wizPlugin.ts"]

[test]
preload = ["./wizPlugin.ts"]
```

For a build, pass the plugin directly and skip the preload entirely:

```ts
import { wizPlugin } from "wiz/plugin";

await Bun.build({
  entrypoints: ["./src/app.ts"],
  plugins: [wizPlugin()],
});
```

The bundle that comes out has no import of `wiz` left in it. A `keysOf<User>()`
over `{ id: string; name: string }` shows up in the output as:

```js
var keys = ["id", "name"];
```

`wizPlugin({ logger })` takes a `WizLogger` to redirect diagnostics. The
default forwards `info`/`warn`/`error` to the console and drops `trace`;
`silentLogger` and `consoleLogger` are exported from `wiz` for tests and for
verbose builds.

### Ordering

The plugin rewrites modules as they are *loaded*. A call has to live in a
module that is imported after the plugin is registered — which is exactly what
a preload buys you, and why registering the plugin at the top of the same file
that calls `keysOf` does not work. When you must do both in one file, as the
tests do, reach the callsites through a dynamic import:

```ts
// @wiz-ignore
import { plugin } from "bun";
import { wizPlugin } from "wiz/plugin";

plugin(wizPlugin());

const fixture = await import("./fixture.ts"); // transformed
```

## Your first program

Two files. The first uses wiz and knows nothing about plugins:

```ts
// user.ts
import { is, keysOf, schema, validate } from "wiz";

export type User = { id: string; name: string };

export const userKeys = keysOf<User>();
export const userSchema = schema<User>();
export const good = is<User>({ id: "1", name: "Ada" });
export const bad = is<User>({ id: 1 });
export const errors = validate<User>({ id: 1 });
```

The second prints it. With `wiz init` done, the preload has already registered
the plugin, so a plain `import` is enough here:

```ts
// main.ts
import { userKeys, userSchema, good, bad, errors } from "./user.ts";

console.log(userKeys);
console.log(userSchema);
console.log(good, bad);
console.log(errors);
```

```bash
bun main.ts
```

`keysOf<User>()` is the declared keys, in declaration order:

```json
["id", "name"]
```

`schema<User>()` is a draft-2020-12 document — pass `"draft-07"` for the older
dialect:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": { "type": "string" },
    "name": { "type": "string" }
  },
  "required": ["id", "name"]
}
```

`is<User>` is a real structural check, so `good` is `true` and `bad` is
`false`. `validate<User>` runs the same check but builds the error list, one
entry per failure with a path:

```json
[
  {
    "path": "id",
    "message": "Expected primitive matching specification",
    "expected": "primitive",
    "actual": 1
  },
  {
    "path": "name",
    "message": "Required property is missing",
    "constraint": "required",
    "expected": "defined"
  }
]
```

`is` is declared as `value is T`, so it narrows:

```ts
function nameOf(value: unknown): string {
  if (is<User>(value)) return value.name; // value is User here
  return "anonymous";
}
```

That branch is the assertion: reading `value.name` does not compile without the
predicate, so `tsc --noEmit` guards it.

Identical types share one generated module, keyed by a hash of the extracted
IR, so `is<User>(a)` in two files imports the same function rather than
emitting two copies.

## `@wiz-ignore`

A file containing the string `@wiz-ignore` anywhere is skipped by the transform
entirely — returned to Bun unchanged, before any TypeScript program is built
for it. It is a plain substring test on the file's contents, so a line comment
at the top is the conventional place:

```ts
// @wiz-ignore
```

You need it in two situations.

**A file that registers the plugin.** The module calling `plugin(wizPlugin())`
should not itself be rewritten, and every test in this repo that registers the
plugin opens with `// @wiz-ignore` for that reason.

**A file that is expensive and has nothing to gain.** Before transforming,
the plugin checks whether the source mentions any helper name at all:

```ts
if (
  contents.includes("@wiz-ignore") ||
  !Array.from(HELPER_FUNCTIONS).some((fn) => contents.includes(fn))
) {
  return unchanged(contents);
}
```

That second test is weaker than it looks. `is` is one of the helper names, and
`is` is a substring of `this`, `list`, `exists` and most English words, so
almost every real file passes it and pays for a full `ts.createProgram`.
Measured on a module with no wiz calls whatsoever, the first file costs several
seconds (it parses `lib.d.ts`, which is then cached) and later ones a few
hundred milliseconds each; the same file with `// @wiz-ignore` costs nothing
measurable. On a large tree that is the difference worth knowing about.

`wiz eject` writes the marker into its own output for the same reason — the
ejected code has its helpers already resolved, so re-transforming it would be
pure cost:

```ts
// @wiz-ignore
// Generated by `wiz eject`; the wiz helpers here are already resolved.
```

## Where to go next

- [type-introspection](./type-introspection.md) — `keysOf`,
  `requiredKeysOf`, `optionalKeysOf`, `is`, `validate`, and what the
  extractor can and cannot see.
- [json-schema](./json-schema.md) — `schema<T>()`, the two dialects, and how
  the validator and the schema stay in agreement.
- [annotations](./annotations.md) — the JSDoc tags: constraints the validator
  enforces, annotations that only describe, and `@format`, which picks the
  wire type in every back end at once.
- [openapi](./openapi.md) — service-interface operations, `openapiSchema`,
  `openapiDocument`, and mounting a Bun or Hono router.
- [protobuf](./protobuf.md) — `.proto` text and a binary codec,
  `@fieldNumber`, and `NumberedUnion` for `oneof`.
- [avro-and-arrow](./avro-and-arrow.md) — `.avsc` and Arrow IPC from the same
  IR. [zod](./zod.md) — `zodSchema<T>()`, and why zod stays optional.
- [typescript-client](./typescript-client.md) — generating a typed client from
  an OpenAPI document, with interceptors, deadlines and cancellation.
- [grpc](./grpc.md) — a `.proto` as a front end, all four streaming
  directions, and the two transports.
- [cli](./cli.md) — `wiz init`, `wiz eject`, `wiz generate`.
- [writing-a-generator](./writing-a-generator.md) — the `GeneratedFiles`
  contract, for a back end of your own. [extractors](./extractors.md) and
  [architecture](./architecture.md) — the IR the two halves meet at.
- [verification](./verification.md) — what is checked against protobuf.js,
  avsc, Ajv and the JSON Schema Test Suite, and which bugs that caught.

## Limitations

**It is a Bun plugin, so it is Bun-only.** There is no Node loader, no Vite
plugin and no `tsc` transform. `wiz eject` is the escape hatch: it writes what
the plugin would have handed to Bun, and the result runs anywhere with nothing
importing wiz.

**Dependencies are not transformed.** The plugin's load filter is
`/^(?!.*node_modules).*\.[jt]sx?$/`, so a package in `node_modules` that calls
a wiz helper throws `PluginInactiveError` at runtime. A library that wants to
ship wiz-generated code has to eject before publishing.

**Both `preload` entries are on you if you skip `init`.** A hand-written config
with only the root entry gives a suite where every helper throws, and the
failure names `PluginInactiveError` rather than the missing config.

**Registration order is a real constraint.** The transform runs at load time,
so a callsite in the same module that registers the plugin is never rewritten,
and the resulting error looks like a missing installation rather than an
ordering mistake.

**The cheap skip barely skips anything.** As above, `is` in the helper-name set
makes the substring pre-check nearly always true, so files with no wiz calls
still build a TypeScript program unless you mark them `@wiz-ignore`.

**TypeScript is a peer dependency, and the plugin loads all of it.** That is
why `wizPlugin` is exported from `wiz/plugin` and deliberately not re-exported
from `wiz`: importing the runtime must never pull the compiler into an app
bundle. Import it from the wrong place and you will notice.
