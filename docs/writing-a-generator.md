# Writing a generator

A generator is the pluggable emitter boundary: it takes one IR root and returns
a map of file name to file contents. Everything wiz emits goes through it — the
virtual modules the plugin mounts, the TypeScript client, the `.proto` text —
and the same interface is what `wiz generate -g ./myGenerator.ts` loads from
disk. Reach for it when you want a back end wiz does not ship: a GraphQL SDL
emitter, a Go struct emitter, an endpoint index, a fixture factory.

## The contract

The whole interface is in `src/generators/generator.ts`, and it is four
declarations:

```ts
export type GeneratedFiles = Record<string, string>;

export type GeneratorInput = TypeIR | ServiceIR | ApiIR;

export interface GeneratorContext<TOptions> {
  options: TOptions;
  logger: WizLogger;
}

export interface Generator<TOptions = Record<string, never>> {
  name: string;
  type?(ir: TypeIR, context: GeneratorContext<TOptions>): GeneratedFiles;
  service?(ir: ServiceIR, context: GeneratorContext<TOptions>): GeneratedFiles;
  api?(ir: ApiIR, context: GeneratorContext<TOptions>): GeneratedFiles;
}
```

`name` is used in diagnostics, so it should name the output rather than the
file: `typescript-client`, `wiz virtual module`, `endpoint-index`.

Every root is optional, and that is the point. A client emitter reads
documents, a codec emitter reads types, and neither has to pretend to handle
the other. `virtualGenerator` implements `type` only; `tsClientGenerator`
implements `api` and `service` and not `type`.

## Three roots, disjoint on `kind`

`TypeIR`, `ServiceIR` and `ApiIR` all carry a `kind` discriminant —
`"object"`/`"primitive"`/… for a type, `"service"`, and `"api"` — so a single
dispatcher can take any of them and route without asking the caller which it
handed over:

```ts
export function generate<TOptions>(
  ir: GeneratorInput,
  generator: Generator<TOptions>,
  options: TOptions,
  logger: WizLogger = defaultLogger
): GeneratedFiles;
```

The value of the discriminant is not the routing — it is the failure. When a
generator does not implement the root it was given, `generate` throws instead
of returning `{}`:

```
[wiz] generator 'types-only' cannot generate from 'api'; it reads a type
```

The message enumerates the roots the generator *does* declare (`a type`,
`a service`, `an API document`, joined with `or`), and a generator with no
handlers at all gets `it declares no inputs at all`. An empty file map is
indistinguishable from a document with no operations in it, so the dispatcher
refuses to produce one. `test/generator_contract.test.ts` pins both messages.

`options` is passed through untouched — the dispatcher has no opinion about
what a generator is configurable with — and so is the logger.

## `GeneratedFiles`: one contract, two drivers

The return value is deliberately inert: a plain `Record<string, string>` with
no paths resolved, no directories created and no I/O performed. Two very
different consumers drive it.

**The CLI writes it to disk.** `wiz generate --outdir out` joins each key onto
the outdir, writes it with `Bun.write` and echoes the path. Without an outdir
the whole map is printed as one JSON value, which is the same shape
`wiz eject <dir>` prints — see [cli](./cli.md).

**The plugin mounts it as virtual modules.** `registerType` calls `generate(ir,
virtualGenerator, options)` and stores the resulting map in the registry under
a content-addressed key; `virtualPlugin` serves it from Bun's `wiz-virtual`
namespace, so `./wiz-virtual/<key>/index.js` in a rewritten callsite resolves
to a string in memory that never touches the filesystem.

That is why the contract is a map and not a directory writer: the same
generator has to work when there is no filesystem to write to.
[architecture](./architecture.md) covers how the two drivers fit together.

## `GeneratorContext`

`context.options` is the generator's own type parameter. The CLI supplies
exactly one field, `{ lenient: boolean }`, from `--lenient`, and passes it
through without interpreting it — a generator decides what it relaxes. Called
programmatically, `options` is whatever you hand `generate`.

`context.logger` is a `WizLogger`: `trace`/`info`/`warn`/`error`, mirroring the
`console` shape so `console` itself is a valid logger. `wiz generate` supplies
`consoleLogger`; `registerType` takes the `defaultLogger`, whose `trace` is a
no-op. `silentLogger` is exported for tests.

The logger is where a generator reports what it could not express, and silence
is the wrong failure mode for that. If a client generator drops an
`application/xml` payload because it only speaks JSON, the caller ends up with
a client that compiles, runs, and quietly cannot call one endpoint. Nothing in
the output says so. `tsClient.ts` warns once per distinct cause and keeps
going:

```ts
context.logger.warn(
  `[wiz] ${mimetype} payloads are not emitted; the client speaks ${JSON_MIME}`
);
```

Throwing is the other correct answer, and the choice is about whether the rest
of the output is still usable. A dropped media type leaves a working client
minus one call — warn. A `oneof` with no field numbers would produce bytes
nobody can decode — throw. What is never right is returning the file anyway
with the problem edited out.

## A worked example

Here is a complete generator, run end to end. It reads an API document and
emits a two-file endpoint index. Save it as `endpointIndex.ts`:

```ts
/**
 * Indexes the HTTP endpoints of an API document.
 *
 * The IR shapes are declared structurally here: `wiz` publishes no subpath for
 * them, and the CLI checks the generator by shape, not by nominal type.
 */

interface Method {
  protocol: "http" | "grpc";
  address: { protocol: string; method?: string; path?: string };
  responses: Array<{ status?: number | "default" }>;
  operationId?: string;
}

interface ApiIR {
  kind: "api";
  version: string;
  types: Map<string, unknown>;
  service: { name?: string; methods: Method[] };
}

interface Context {
  options: { lenient: boolean };
  logger: { warn(...args: unknown[]): void };
}

export default {
  name: "endpoint-index",

  api(ir: ApiIR, context: Context): Record<string, string> {
    const rows: string[] = [];
    const entries: Array<Record<string, unknown>> = [];

    for (const method of ir.service.methods) {
      if (method.protocol !== "http") {
        context.logger.warn(
          `[endpoint-index] skipped a ${method.protocol} method: this generator only indexes HTTP`
        );
        continue;
      }

      const id = method.operationId;
      if (id === undefined && !context.options.lenient) {
        throw new Error(
          `[endpoint-index] ${method.address.method} ${method.address.path} has no operationId`
        );
      }

      const statuses = method.responses.map((r) => String(r.status));
      rows.push(
        `| \`${method.address.method}\` | \`${method.address.path}\` | ${id ?? "-"} | ${statuses.join(", ")} |`
      );
      entries.push({
        method: method.address.method,
        path: method.address.path,
        operationId: id ?? null,
        statuses: method.responses.map((r) => r.status),
      });
    }

    return {
      "ENDPOINTS.md": [
        `# ${ir.service.name ?? "API"}`,
        "",
        `${entries.length} endpoint(s), ${ir.types.size} named type(s), OpenAPI ${ir.version}.`,
        "",
        "| Method | Path | Operation | Statuses |",
        "|---|---|---|---|",
        ...rows,
        "",
      ].join("\n"),
      "operations.json": `${JSON.stringify(entries, null, 2)}\n`,
    };
  },
};
```

Point it at an OpenAPI document with two operations and one component schema:

```bash
wiz generate -g ./endpointIndex.ts ./api.json -o out
```

```
  out/ENDPOINTS.md
  out/operations.json
```

`out/ENDPOINTS.md`:

```
# Users

2 endpoint(s), 1 named type(s), OpenAPI 3.1.

| Method | Path | Operation | Statuses |
|---|---|---|---|
| `GET` | `/users/{id}` | getUser | 200, 404 |
| `POST` | `/users` | createUser | 201 |
```

Drop the `--outdir` and the map itself is the output, so the command composes
in a pipe:

```bash
wiz generate -g ./endpointIndex.ts ./api.json
```

```json
{
  "ENDPOINTS.md": "# Users\n\n2 endpoint(s), 1 named type(s), OpenAPI 3.1.\n\n| Method | Path | Operation | Statuses |\n|---|---|---|---|\n| `GET` | `/users/{id}` | getUser | 200, 404 |\n| `POST` | `/users` | createUser | 201 |\n",
  "operations.json": "[\n  {\n    \"method\": \"GET\",\n    \"path\": \"/users/{id}\",\n    \"operationId\": \"getUser\",\n    \"statuses\": [\n      200,\n      404\n    ]\n  },\n  {\n    \"method\": \"POST\",\n    \"path\": \"/users\",\n    \"operationId\": \"createUser\",\n    \"statuses\": [\n      201\n    ]\n  }\n]\n"
}
```

The same generator over a `.proto` file exercises the warn path. `wiz generate`
picks the extractor from the file extension, so a proto service arrives as an
`ApiIR` with `version: "proto3"` and gRPC methods — which this generator does
not index:

```bash
wiz generate -g ./endpointIndex.ts ./svc.proto
```

```
[endpoint-index] skipped a grpc method: this generator only indexes HTTP
{
  "ENDPOINTS.md": "# users\n\n0 endpoint(s), 2 named type(s), OpenAPI proto3.\n\n| Method | Path | Operation | Statuses |\n|---|---|---|---|\n",
  "operations.json": "[]\n"
}
```

The warning goes to stderr, so stdout stays one JSON value. The two named types
are still counted: the messages are there, only the endpoints are not HTTP.

`--lenient` reaches the generator untouched. Against a document whose one
operation has no `operationId`:

```bash
wiz generate -g ./endpointIndex.ts ./anon.json
```

```
wiz generate: [endpoint-index] GET /ping has no operationId
```

```bash
wiz generate -g ./endpointIndex.ts ./anon.json --lenient
```

```json
{
  "ENDPOINTS.md": "# Anon\n\n1 endpoint(s), 0 named type(s), OpenAPI 3.1.\n\n| Method | Path | Operation | Statuses |\n|---|---|---|---|\n| `GET` | `/ping` | - | 200 |\n",
  "operations.json": "[\n  {\n    \"method\": \"GET\",\n    \"path\": \"/ping\",\n    \"operationId\": null,\n    \"statuses\": [\n      200\n    ]\n  }\n]\n"
}
```

## How the CLI finds your generator

`loadGenerator` resolves the `--generator` argument against the current working
directory, not against wiz, so `./endpointIndex.ts` means what you typed. It
takes `default` first, then a named `generator` export — the second exists so a
module that already has a default (a plugin, a config) is still addressable.

The check is structural: a string `name` plus at least one of `type`, `service`
or `api` being a function. A module that fails it says which:

```
wiz generate: './notAGenerator.ts' exports no usable generator; expected a default or 'generator' export with a string name and a type, service or api method
```

`wiz generate` always produces an `ApiIR`, whatever the input format, because
both front ends — the OpenAPI extractor and the proto extractor — return one.
A `type`-only generator therefore loads fine and then fails at dispatch:

```
wiz generate: [wiz] generator 'types-only' cannot generate from 'api'; it reads a type
```

That is the intended split. Load-time errors are about the module; dispatch
errors are about the IR. See [extractors](./extractors.md) for what each front
end produces, and [cli](./cli.md) for the full flag list.

## Calling `generate` directly

Nothing about the interface requires the CLI. In-tree, or from a test, hand
`generate` an IR root and a generator object. This is `keys.ts` — the smallest
back end wiz ships — wrapped in a generator:

```ts
import { generate } from "wiz/src/generators/generator.ts";
import { generateKeysCode } from "wiz/src/generators/keys.ts";
import { silentLogger } from "wiz";

const keysGenerator = {
  name: "keys",
  type: (ir) => ({ "keys.js": generateKeysCode(ir) }),
};

generate(ir, keysGenerator, {}, silentLogger);
```

For a `{ id: string; nickname?: string }` object IR that returns:

```json
{
  "keys.js": "export const keys = [\"id\",\"nickname\"];\nexport const requiredKeys = [\"id\"];\nexport const optionalKeys = [\"nickname\"];"
}
```

`generateKeysCode` is fifteen lines and worth reading in full: it calls
`flattenObjectProperties`, partitions on `optional`, and `JSON.stringify`s three
arrays. A generator does not have to be a compiler.

## Several files, and `VIRTUAL_ENTRY`

Emitting more than one file is just more keys. `tsClientGenerator` returns a
model file, a client file and the runtime pieces from one call; the example
above returns two. Keys are file names, and the CLI joins them onto the outdir
verbatim, so a key containing `/` nests — but nothing normalizes or validates
it, so keep them simple.

Mounting a map as virtual modules needs one more thing: the rewriter has to
name a single file of it in an import specifier. There is no manifest field for
that, so it is a convention:

```ts
export const VIRTUAL_ENTRY = "index.js";
```

Whatever else a virtual generator emits, `index.js` is the file whose exports
the rewritten callsites bind. `virtualPlugin` resolves a bare
`wiz-virtual/<key>` to it, and a relative import from inside a mounted module
stays inside the mount — `./x.js` from `wiz-virtual/<key>/index.js` names a
sibling key in the same map, not a file next to the importer's original source.
So a virtual generator may split its output across several files as long as
`index.js` re-exports what the callsites need, and the mount directory itself
(`wiz-virtual/<key>/`) is the plugin's to add: outside the plugin there is no
registry to key.

Asking for a file the map does not have is an error naming both, not a silent
empty module:

```
[wiz] Virtual module for hash '<key>' has no file '<file>'.
```

## Conventions worth following

**Report rather than drop.** Every built-in generator that cannot express
something says so, once, with enough detail to act on: a mimetype, a method
name, a file:line. Deduplicate the warning by cause rather than by occurrence —
`tsClient` keeps a `Record<string, true>` of what it has already mentioned — so
a document with forty XML endpoints produces one line, not forty.

**Never invent data the IR does not carry.** The IR holds what is knowable at
compile time and nothing else. `ServiceIR` has no `servers`, no `security` and
no `info` block, because those arrive at runtime through a base document and
can differ per environment. If your output needs a base URL, take it as an
option or leave a hole for the caller — do not default it to
`http://localhost:3000`. The same rule is why protobuf refuses an unnumbered
`oneof` instead of assigning numbers: an invented field number is a wire
contract nobody agreed to.

**Keep generated code dependency-free.** The virtual modules wiz mounts import
nothing; the codecs are hand-rolled against `Uint8Array` rather than pulling in
`protobufjs`. A generated module that imports a package makes that package a
hard dependency of every program the generator touches. The one exception in
the tree proves the rule: `zodSchema` writes `() => import("zod")` at the
*callsite*, not inside the generated module, and only when a callsite asked for
it — so a program with no zod schema neither loads zod nor needs it installed.
See [zod](./zod.md).

**Name the output, not the file.** `name` appears in the dispatch error and in
your own warnings. `typescript-client` reads better than `tsClient.ts` in
`generator 'X' cannot generate from 'api'`.

**Prefix your diagnostics.** The built-ins use `[wiz] `; the example above uses
`[endpoint-index] `. A build log carries lines from the plugin, the extractors
and every generator at once.

## Limitations

The `Generator` interface is not published. `package.json` exports only `.`,
`./plugin` and `./openapi`, so `import type { Generator } from "wiz/..."` does
not resolve from an installed copy — Bun reports `Cannot find package 'wiz'`.
A generator outside this repository has to declare the shapes it reads
structurally, as the worked example does. This costs nothing at runtime (the
CLI's check is structural too) but you get no compiler help keeping up with IR
changes.

There is no generator registry and no composition. `generate` runs exactly one
generator over exactly one root; `wiz generate` accepts one `--generator`. To
run several, run the command several times, or write a generator that calls
others and merges their maps — nothing detects a key collision if you do.

The plugin's generator is not pluggable. `registerType` names `virtualGenerator`
directly, so a custom generator cannot mount virtual modules for `keysOf<T>()`
and friends; the pluggable path is the CLI and direct `generate` calls.

A generator gets no source position. The IR carries names, kinds, constraints
and annotations, but not the file and line the type was declared at, so a
diagnostic can name a type or an operation and not much more. The OpenAPI
extractor's own `ApiDiagnostic` entries carry a JSON pointer into the source
document — see [openapi](./openapi.md) — but those are produced before the
generator runs and are reported by the CLI, not handed to you.

Output is a string map, so binary output has to be encoded. There is no
`Uint8Array` variant of `GeneratedFiles`; a generator that wants to emit a
compiled artifact must base64 it or emit source that produces it.
