# wiz TODO

Defects found by reading the source, each with the evidence that found it. Ordered
by severity: a broken invariant first, then type-system escapes that will break on
a dependency bump, then the silent-degradation paths.

Nothing here is a feature request. Every item is either a stated invariant that
does not hold, a contract the code bypasses, or a documented limitation that
deserves a decision rather than a paragraph.

## Defects

- [x] [Spec pre-validation does not validate OpenAPI or JSON Schema](#spec-pre-validation-does-not-validate-openapi-or-json-schema)
- [x] [The MCP generator builds a document it never validates](#the-mcp-generator-builds-a-document-it-never-validates)
- [x] [`harvest.ts` reads TypeScript compiler internals](#harvestts-reads-typescript-compiler-internals)
- [x] [MCP smuggles fields the IR does not declare](#mcp-smuggles-fields-the-ir-does-not-declare)
- [x] [`as any` where a narrowing guard already exists](#as-any-where-a-narrowing-guard-already-exists)
- [x] [Generated react-query hooks launder their options through `any`](#generated-react-query-hooks-launder-their-options-through-any)
- [ ] [`tsClient` degrades silently when a Bun global is absent](#tsclient-degrades-silently-when-a-bun-global-is-absent)
- [ ] [The OpenRPC server and transports are untyped glue](#the-openrpc-server-and-transports-are-untyped-glue)
- [ ] [`document.ts` merges responses through a hardcoded `204`](#documentts-merges-responses-through-a-hardcoded-204)
- [ ] [`package.json` has no version](#packagejson-has-no-version)

## Shared gaps

- [ ] [Request bodies that are not JSON](#request-bodies-that-are-not-json)
- [ ] [Streaming and server-sent events](#streaming-and-server-sent-events)
- [ ] [`securitySchemes` reaches no generated client](#securityschemes-reaches-no-generated-client)
- [ ] [Parameter serialisation ignores `style` and `explode`](#parameter-serialisation-ignores-style-and-explode)
- [ ] [GraphQL](#graphql)
- [ ] [Nothing works without the plugin, and nothing says so at build time](#nothing-works-without-the-plugin-and-nothing-says-so-at-build-time)

---

### Spec pre-validation does not validate OpenAPI or JSON Schema

**Severity**: High — a stated repository invariant that is false for half its subjects.

`AGENTS.md:86-87` says every spec generator must run
`assertValidSpecDocumentSync(document, specName)` before emitting code. The four
generators it names do call it — `generators/openapi.ts:492`, `asyncapi.ts:161`,
`openrpc.ts:127`, `schema.ts:273-274,315-316` — and `mcp.ts:4` imports it without
ever calling it. The calls are real; the validation behind them mostly is not.

`validators/jsonSchema.ts:55-91` dispatches on a document key:

- `doc.openapi` (line 60) — three hand-written checks: the version string starts
  with `3.`, `info.title` and `info.version` are strings, and 3.0 documents have a
  `paths` key. No schema keyword is examined.
- `doc.openrpc` (line 74) and `doc.asyncapi` (line 81) — real Ajv validation
  against the bundled meta-schemas, compiled at lines 39-45.
- anything else (line 90) — `return { valid: true }`.

Two consequences. First, `schemas/openapi-3.0.json` and `schemas/openapi-3.1.json`
are bundled and imported but reachable only from the *async* path
(`validateSpecDocument`, lines 96-116, via `@seriousme/openapi-schema-validator`),
which no generator calls. Second, a JSON Schema document has none of the three
keys, so the `assertValidSpecDocumentSync(schema2020, "JSON Schema Draft 2020-12")`
calls at `generators/schema.ts:273-274` and `315-316` take the line-90 branch and
assert nothing at all. The MCP tool list is never submitted at all — see the next
item.

**Fix**: compile both OpenAPI meta-schemas with the same `Ajv07` pattern already
used at lines 39-45 and route the `doc.openapi` branch through them. Add a branch
keyed on `$schema` for JSON Schema documents. Invert the default at line 90: an
unrecognised document should fail, naming what it was not recognised as, rather
than pass. `@seriousme/openapi-schema-validator` can stay for the async path or go
away entirely once Ajv covers 3.0 and 3.1.

**Done when**: a test that hands each spec generator a deliberately corrupted
document (missing `paths` entry shape, a `type` that is not a JSON Schema type, a
malformed `$ref`) sees a throw from each, including JSON Schema and MCP.

---

### The MCP generator builds a document it never validates

**Severity**: Medium — dead code where validation was intended.

`generators/mcp.ts:97-100`:

```ts
// Pre-validate dummy doc for assertValidSpecDocumentSync if needed or validate document structure
const dummyDoc = {
  tools: toolsList,
};
```

`generators/mcp.ts:4` imports `assertValidSpecDocumentSync`; `grep` finds no call
in the file, and `dummyDoc` is the only occurrence of that identifier — assigned,
never read. An unused import and an unused variable, both named after a check that
does not happen. The comment is honest about being unsure ("if needed"), which is
the tell. MCP is not in the `AGENTS.md:87` list of generators that must
pre-validate, so this is dead intent rather than a broken invariant.

**Fix**: decide. Either validate the tool list — which needs a bundled MCP tool
schema in `schemas/`, since there is none today — or delete the variable and note
in `docs/mcp.md` that MCP output is unvalidated. Do not leave a third state where
the code suggests validation and performs none.

**Done when**: the unused import and `dummyDoc` are gone, and either a meta-schema
validates the tool list or `docs/mcp.md` states it does not.

---

### `harvest.ts` reads TypeScript compiler internals

**Severity**: Medium-High — silent breakage on a `typescript` bump, disguised as a cast.

Six sites reach past the public `typescript` surface:

| Line | Expression |
|---|---|
| 537-538 | `(sourceFile as any).locals?.get(typeName) ?? (sourceFile as any).symbol?.exports?.get(typeName as any)` |
| 593 | `(sig.declaration as any)?.symbol` |
| 941 | `(sig.declaration as any)?.symbol` |
| 1094 | `(sig.declaration as any)?.symbol` |
| 1298 | `(sig.declaration as any)?.symbol` |
| 1577 | `(sig.declaration as any)?.symbol` |

`SourceFile.locals`, `SourceFile.symbol` and `Declaration.symbol` are internal
node properties, not part of the declared API. They are stable in practice and
undeclared in principle: when one is renamed the `as any` guarantees no compile
error, and the failure surfaces as a harvester that silently finds no methods —
which now produces an empty document rather than a diagnostic, because the
`warnUndocumentable` path documented in `AGENTS.md:50` cannot distinguish "no tags"
from "no symbols resolved".

**Fix**: prefer the public checker paths — `checker.getSymbolAtLocation`,
`checker.getSymbolsInScope`, `checker.getExportsOfModule`, and for signatures the
declaration's own name node via `ts.getNameOfDeclaration` before falling back.
Where no public equivalent exists, quarantine the access: one `src/tsInternal.ts`
declaring `interface InternalSourceFile { locals?: ts.SymbolTable; symbol?: ts.Symbol }`
plus a test that asserts each internal property is present on a freshly created
program, so a TS upgrade fails the suite instead of the harvest.

**Done when**: `grep -c "as any" src/harvest.ts` is zero, and the internal access
that survives is behind a declared interface with a presence test.

---

### MCP smuggles fields the IR does not declare

**Severity**: Medium — contradicts the one-IR premise the README sells.

`generators/mcp.ts:53` reads `(method.address as any).hasOverride`;
`generators/mcp.ts:88` reads `(ir as any).meta?.mcpTool as McpToolSpec | undefined`.
Neither `hasOverride` nor `meta.mcpTool` appears in `ir/service.ts` or
`ir/types.ts`. They are written somewhere upstream and read back through a cast,
so the IR's declared shape is not the IR's actual shape, and a reader of
`ir/service.ts` cannot discover that MCP naming depends on a field that file does
not mention.

This is the failure mode `README.md:138-142` claims the architecture prevents — a
type described one way and consumed another — relocated from the codecs into the
IR itself.

**Fix**: add `hasOverride?: boolean` to the MCP address type in `ir/service.ts` and
declare where the MCP tool spec lives — either `mcpTool?: McpToolSpec` on the type
meta in `ir/types.ts`, or, better, pass it as a generator option so the IR stays
protocol-agnostic. Then delete both casts.

**Done when**: `mcp.ts` contains no `as any`, and `test/ir_contracts.test.ts`
covers the new field.

---

### `as any` where a narrowing guard already exists

**Severity**: Low-Medium — pure carelessness, fixable in minutes.

`ir/service.ts:267-292` exports `isHttpMethod`, `isGrpcMethod`, `isOpenRpcMethod`,
`isMcpMethod` and `isAsyncApiMethod`. Two generators ignore them and cast instead:

- `generators/openapi.ts:339` — `(method.address as any).methodName ?? (method.address as any).method`
- `generators/reactQuery.ts:78-79` — `(method.address as any).service ? \`${(method.address as any).service}/${(method.address as any).method}\` : "call"`

`isHttpMethod(method)` is already in hand at `reactQuery.ts:74` and used on line
76; the casts sit in that same ternary's else branch.

**Fix**: narrow with the existing guards; let the compiler prove which address
fields exist on each protocol.

**Done when**: neither line contains a cast and `bun run typecheck` is clean.

---

### Generated react-query hooks launder their options through `any`

**Severity**: Medium — the cast ships to the consumer, not just to us.

`generators/reactQuery.ts:158-160`:

```ts
const callArgs = op.hasSlots
  ? `options as any, { signal }`
  : `{ ...options, signal } as any`;
```

and `250-251`, `client.${op.name}(options as any)`. These are template strings:
the `as any` lands in the file a user imports, so the hook's own argument type is
checked at the hook boundary and then discarded before the client call. A mismatch
between `op.optionsTypeName` and the client method's parameter — exactly the kind
of drift a generator introduces — cannot be caught by the consumer's `tsc`.

The `hasSlots` branch suggests the real problem: two call shapes that the emitted
type does not express.

**Fix**: emit the shape the client method actually accepts. If the slot and
non-slot forms genuinely differ, generate an overload or a discriminated options
type rather than erasing the difference. Whatever survives must typecheck without
a cast in the generated file.

**Done when**: `test/react_query_generator.test.ts` asserts the emitted `api.ts`
and hooks contain no `as any`, and a generated fixture typechecks under
`--noEmit`.

---

### `tsClient` degrades silently when a Bun global is absent

**Severity**: Medium-High — produces wrong values instead of failing.

Request encoding, `generators/tsClient.ts:344-357`:

- line 351 — XML bodies: `((globalThis as any).Bun?.XML ?? { stringify: (v: any) => String(v) }).stringify(...)`. Without `Bun.XML` an object body is sent as `[object Object]` with `Content-Type: application/xml`.
- line 348 — YAML falls back to `JSON.stringify`, which is valid YAML, so this one is defensible; line 345's JSON5 fallback likewise.
- line 354 — HTML falls back to `String(body)`.

Response decoding, `generators/tsClient.ts:1234-1300` — nine `try { … } catch { return text }` blocks (1239, 1246, 1253, 1260, 1267, 1275, 1283, 1290, 1297). A malformed body, or a missing `Bun.XML` / `globalThis.decodeCbor` / `globalThis.decodeErlangBinary`, resolves the operation with the raw string. The declared return type says `Pet`; the caller receives a `string`; nothing throws.

`generators/zod.ts:21-24` states the opposite policy: "What zod cannot express
throws when the schema is built, rather than validating loosely… A schema that
quietly accepts what the type forbids is the bug this repository keeps paying
for." The client generator does not follow it.

**Fix**: throw a named error naming the media type and the missing capability
(`[wiz] application/xml responses need Bun.XML; this runtime has none`). Keep the
fallbacks that are semantically exact (YAML and JSON5 parse a JSON superset;
`JSON.stringify` output is valid YAML) and delete the ones that are not (XML
stringify, HTML stringify, every `catch { return text }`). A parse failure on a
declared media type is a server contract violation and should surface as one.

**Done when**: `test/ts_client.test.ts` covers a malformed body for each supported
media type and expects a throw, and the XML/HTML stringify fallbacks are gone.

---

### The OpenRPC server and transports are untyped glue

**Severity**: Low-Medium — hand-written support code held to a lower standard than the generated kind.

`server/openrpc.ts` — `services?: any[] | Record<string, any>` (line 2),
`methods?: Record<string, (...args: any[]) => any>` (3), `params?: any` (12),
`result?: any` (18), `data?: any` (22), `open/message/close(ws: any)` (29-36),
the method table and registration (46, 48), `servicesList` (63), `let result: any`
(156), `catch (err: any)` (173), the websocket and socket handlers (270-271, 300,
304).

`transports/openrpc.ts` — `FetchLike = (input: any, init?: any) => Promise<any>`
(25), `catch (e: any)` (65), `ws?: any` (74), `let socket: any` (78), the pending
map's `reject` (81), `handleMessage(event: any)` (84), `bindSocket(s: any)` (101),
`getSocket(): Promise<any>` (111), 116, 135, `socket?: any` (166), `let conn: any`
(170), 173, `setupSocket(s: any)` (177), `getConn(): Promise<any>` (201), 209.

This layer is the only part of the codebase a user calls directly at runtime
rather than receiving as generated output, and it is the least typed.

**Fix**: declare the three structural surfaces this code actually needs —
`WebSocketLike`, `SocketLike`, `FetchLike` with real `Request`/`Response` types —
plus `JsonRpcId = string | number | null` and `JsonRpcParams = unknown[] | Record<string, unknown>`.
Take `unknown` at the boundaries and narrow; `catch (err: unknown)` with an
instanceof check. Service registration is the one place a cast may be
unavoidable — confine it there and name why.

**Done when**: `grep -c ": any" src/server/openrpc.ts src/transports/openrpc.ts`
is zero outside a single documented registration cast.

---

### `document.ts` merges responses through a hardcoded `204`

**Severity**: Low.

`document.ts:41-43`:

```ts
if (exOp.responses && newOp.responses && (newOp.responses as any)["204"] && !(exOp.responses as any)["204"]) {
  mergedOp.responses = exOp.responses;
}
```

Two `as any` casts on the same line to index a response map, guarding a rule that
is never stated: a new operation declaring `204` loses to an existing operation
that does not. Presumably "a void-returning overload must not erase a
body-returning one", which is a reasonable rule and is not what the code says.

**Fix**: type the response map (`Record<string, ResponseObject>`), and either
generalise the rule to "prefer the operation that declares a response body" or
keep the `204` special case with a comment stating the case it fixes. A test
naming that case would be better than either.

**Done when**: the line has no casts and `test/document_merge.test.ts` covers the
scenario the rule exists for.

---

### `package.json` has no version

**Severity**: Low.

`README.md:23` tells users to `bun add wiz`. `package.json` declares `name`,
`module`, `bin`, `exports`, `workspaces`, `scripts`, `type` and dependencies — no
`version`. npm will refuse to publish it, and a git or workspace dependency
resolves to something unversionable.

**Fix**: add `"version"`. If publishing is not intended, say so in
`CONTRIBUTING.md` and change the README's install instructions to the git or path
form that actually works.

---

## Other gaps

### Request bodies that are not JSON

`docs/typescript-client.md:775-782` is honest about it: `jsonBody` picks
`application/json`, warns for everything else, and multipart, form-encoded,
octet-stream and XML operations still emit — with the JSON schema if there is one,
otherwise the first body listed — while nothing encodes those media types. "A file
upload needs a hand-written call."

The declared limitation understates the consequence. The operation is still
generated with a typed signature, so a spec with a file-upload endpoint produces a
client method that typechecks, reads as supported, and cannot work. A warning at
generation time does not reach whoever calls it six months later.

**Fix, in order of increasing ambition**: (1) do not emit an operation whose only
body media type cannot be encoded — a missing method is a better signal than a
broken one, and the warning already exists to explain it; (2) emit it with a
`never`-typed body so the callsite fails to compile; (3) encode `multipart/form-data`
and `application/x-www-form-urlencoded` for real, both of which are expressible in
the IR today (an object of scalars, `bytes` and `Blob`-like fields) and need no
new dependency.

**Done when**: a spec with a multipart endpoint either fails to produce a callable
method or produces one that sends a correct body, verified against an echo server
like `test/fixtures/echoServer.ts`.

### Streaming and server-sent events

`docs/typescript-client.md:810-812`: the body is read to completion by
`parseBody`; SSE and chunked JSON need the raw `Response`; streaming exists only
on the gRPC side. Neither codebase matches `text/event-stream` anywhere.

An SSE endpoint in a document therefore generates a method that buffers an
infinite stream. That is worse than absent.

**Fix**: recognise `text/event-stream` and chunked-JSON responses during
extraction and emit a method returning `AsyncIterable<T>` rather than `Promise<T>`.
The gRPC generator already models streaming in the IR (`AsyncIterable` /
`AsyncGenerator` / `ReadableStream` on either side, per `AGENTS.md:47`), so this is
a matter of letting the HTTP generator use what the IR can already say. Until
then, refuse to emit the operation as if it were unary.

**Done when**: an SSE operation yields an async iterable, or is skipped with a
diagnostic naming the media type.

### `securitySchemes` reaches no generated client

Neither implementation reads `components.securitySchemes`.
`docs/typescript-client.md:803-805` states the position here: there is no generated
`setBearerToken`, auth is an interceptor you write.

**Fix**: read `securitySchemes` and the operation-level `security` requirements
into the IR — there is no security concept in `ir/api.ts` today, which is the
actual blocker — then let the client generator emit the scheme-appropriate hook
(`setBearerToken`, an API-key header, an OAuth token URL constant). The
interceptor stays as the escape hatch for what the document does not say.

**Done when**: `ApiIR` carries security requirements, and a document with an HTTP
bearer scheme generates a client with a typed way to supply the token.

### Parameter serialisation ignores `style` and `explode`

`docs/typescript-client.md:807-808`: arrays are always repeated keys and deep
object serialisation is absent. Neither codebase mentions `explode` at all.

A document using `style: form, explode: false` or `style: deepObject` generates a
client that sends the wrong query string, with no warning — unlike the media-type
case, which at least warns.

**Fix**: carry `style` and `explode` on the parameter IR and honour the four
combinations that occur in practice (`form`/`explode:true` — today's behaviour,
`form`/`explode:false` comma-joined, `deepObject`, `pipeDelimited`). Warn on the
rest. Cookie parameters have the same problem and the same fix.

**Done when**: each style round-trips through an echo server test.

### GraphQL

Neither implementation reads or writes GraphQL. This one is aspiration rather than
defect — `ir/service.ts:301` mentions what "a gRPC or GraphQL emitter would need",
and `docs/writing-a-generator.md:7` offers "a GraphQL SDL" as the example of a back
end wiz does not ship.

Worth keeping on the list only to answer the question when it is asked: the IR has
services, operations, payload types and a discriminator model, so an SDL emitter is
a generator, not an architecture change. An extractor is the harder half, because
GraphQL's field-level selection has no counterpart in `TypeIR`.

**Fix if pursued**: emitter first, as a plugin module under
`wiz generate -g ./graphql.ts`, to find out what the IR is missing before touching
`ir/`.



**Done when**: a project missing the `[test]` preload learns it from a command
rather than from a failing test, and the error message names `wiz init`.
