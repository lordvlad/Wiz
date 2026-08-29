# Pragmatic Architecture Review — wiz

Deliverable for `ARCHITECTURE_REVIEW_PLAN.md`. Review only: no source, test,
dependency, or configuration changes were made.

Repo state at review time: `git status` clean apart from the plan file; HEAD
`dfe7a48` (`refactor: isolate virtual module lifecycle`). One discrepancy vs
the plan's anchors: `normalizeTypeIR`, `normalizeAnnotations`, and `walkTypeIR`
live in `src/ir/types.ts`; `src/types.ts` is a re-export shim that adds only
`getTypeKey` (`src/types.ts:4,14`). The actual state was reviewed.

## Verification results

All commands run from the repository root:

| Command | Result |
|---|---|
| `bun test test/registry_keys.test.ts test/ir_contracts.test.ts test/plugin.test.ts --timeout=20000` | 10 pass, 0 fail, 39 expect() calls, 4.01s |
| `bun run typecheck` | exit 0, no diagnostics |
| `bun test --timeout=20000` (full) | 403 pass, 0 fail, 38 files, 17.08s |
| `bun test --parallel --no-isolate --timeout=20000` | 403 pass, 0 fail, 19.71s (4× parallel — no speedup; program construction dominates) |

Beyond static reading, five focused probes were executed against the real
modules (scratch scripts kept outside the repo). Results are quoted inline
below; they are the new-behavior proof the plan requires.

## 1. IR/registry identity contract — confirmed defects

The registry's stated contract is content addressing: "anything that would
change the generated code is already in the key" (`src/registry.ts:56-57`).
That contract is violated. A module key is `getTypeKey`
(`src/types.ts:14-42`: named types → `computeTypeIRHash(ir)_fileName:symbolName`,
anonymous → hash alone) plus `payloadKey` (`src/registry.ts:36-51`, built from
`normalizeTypeIR` and `normalizeServiceMethod`).

### Field matrix: emitted-but-unkeyed fields

TypeIR, per kind (normalize logic at `src/ir/types.ts:202-290`):

| Kind | Root annotations in key | `name` in key | Other omissions |
|---|---|---|---|
| primitive, literal, array | `constraints/examples/default/meta` only (`normalizeAnnotations`, `src/ir/types.ts:188-197`) — `description`, `deprecated` never keyed | no | — |
| object | **none** (case omits the spread, `src/ir/types.ts:216-233`) | no | property `fieldNumber` missing from the prop mapping (`:221-228`) |
| tuple, intersection, enum, record | **none** | no | — |
| union | **none** | no | `discriminator` (`src/ir/types.ts:126-135` vs `:250-263`) |
| ref | **none** | no | keyed only by `targetId`, which comes from a process-global counter (see §2) |

All omitted fields are emitted: root `description`/`deprecated`/constraints/
default/examples by `irToJsonSchema` (`src/generators/schema.ts:40-56`) and
`irToOpenApiSchema` (`src/generators/openapi.ts:47-59`); `name` drives `$ref`
component naming (`src/generators/openapi.ts:41-42,270`) and `collectNamedTypes`
schema keys; `fieldNumber` drives protobuf wire tags
(`src/generators/protobuf.ts:583-589,639`) and `.proto` text; `discriminator`
selects `oneOf` vs `anyOf` (`src/generators/openapi.ts:244-249`,
`src/generators/schema.ts:216-221`). Avro consumes `description`; Arrow and
keys are structural only (verified by grep — no annotation reads).

ServiceMethodIR (`normalizeServiceMethod`, `src/ir/service.ts:127-152`): keys
address, overrides, parameter name/in/required/type, body mimetype/content,
bodyComponent, response status/body/headers(name/required/type). Omits — all
emitted by `operationSource` (`src/generators/openapi.ts:329-379`):
`operationId`, `summary`, `description`, `tags`, `deprecated`,
`request.bodyRequired` (`:347`), `response.description` (`:366-371`),
parameter/header `description`/`deprecated` (`:355-357,361-363`).
`ServiceIR.name/version/description` are unkeyed but also unemitted (info comes
from the base document) — latent only.

### Executed proofs

- **P1 — nested `name` omission (anonymous-root path).**
  `openapiSchema<{ profile: User }>` in a.ts vs `<{ profile: Admin }>` in b.ts,
  `User`/`Admin` structurally identical. Both transforms produced the identical
  key `ab745ae0_0e755c93`; b.ts's module defines component `User` and contains
  no `Admin`. File b's document `$ref`s the wrong component — silently.
- **P2 — `fieldNumber` omission (payload path).** Two same-named
  `interface Message { /** @fieldNumber 1|2 */ id: string }`. Hashes equal;
  fresh generation differs (decode `case 1` vs `case 2`); `registerType(hash,
  ir, { protobufSchemaTypes: [...] })` returned the same key `probe2_dcb83257`
  and the second registration silently reused the first module — wire field 1
  served where 2 was declared. Reachable today: two files each calling
  `protobufSchema<[Message]>()` (payload keys use `[name, normalizeTypeIR]`,
  `src/registry.ts:22-26` — no fileName).
- **P5 — root description omission.** Two `interface Message` differing only in
  interface-level JSDoc. Root descriptions extracted ("v1 doc"/"v2 doc"),
  hashes equal, payload-path keys equal; second module carries "v1 doc",
  "v2 doc" dropped.
- **P4 — asymmetry control.** Property-level description *is* keyed (hashes
  differ) — the omission is specifically the root/object level, matching the
  matrix.
- **P3 — service metadata (registry level).** Two methods differing only in
  `operationId` → identical `payloadKey`; second registration reuses the first
  entry. Latent producer: the TS plugin never populates these fields
  (`collectOperations` `src/plugin.ts:115-178` builds only
  address/params/body/status; `httpMethodIR` `:86-105`), so no live miscompile
  today — but `extractApiIR` populates exactly the omitted set
  (`src/extractors/openapi.ts:606,813,823,919-932`) and
  `normalizeServiceMethod`'s own doc says the registry keys on it
  (`src/ir/service.ts:122-126`). The contract is broken ahead of its first
  consumer.

Severity: **High** for the TypeIR omissions (P1/P2/P5 are live, cross-file,
silent-wrong-output); **High-latent** for the service omissions.

Recommendation (bounded): one shared change in the canonical normalizers only —
add `description`/`deprecated` to `normalizeAnnotations` and spread it in every
kind's case; add `name` per kind; add `fn: p.fieldNumber` to the property
mapping; include `discriminator` in the union case; extend
`normalizeServiceMethod` with the omitted service fields. No generator or
registry changes. Note: adding `name` re-keys every module once (the registry is
per-process, so only `wiz eject` output aliases churn in VCS diffs — one-time).
`discriminator` is normally derived from keyed member structure
(`findDiscriminatorProperty`, `src/extractors/typescript.ts:483-519`) but is
order-sensitive while normalization sorts members — include it anyway; it is
cheap and removes the edge.

## 2. Plugin boundaries and state lifetime

Responsibilities still combined in `src/plugin.ts` (1,297 lines): AST
transformation (`transformSource` `:838-1277`, import emission `:1226-1274`),
route discovery (`collectOperations` `:115-178`, `collectRouteOperations`
`:357-493`, `readOperationSpec` `:213-312`, `routeAdapterFor` `:699-712`,
`slotParameters` `:67-83`), static evaluation (`staticValue` `:556-601`,
`readVersionFromBase` `:509-524`), OpenAPI harvesting/document execution
(`harvestDocument` `:633-696`, `runGeneratedDocument` `:611-619`), and TS
program/cache management (`:532-547,854-887`). Bun hook orchestration is already
cleanly extracted (`src/virtualPlugin.ts:14-52`, receives `transformSource` as
an injected function — the pattern to copy).

Per cache:

| State | Location | Lifetime | Assessment |
|---|---|---|---|
| `harvestCache` | `src/plugin.ts:633` | process, never invalidated (only `.set` at `:693`) | Confirmed defect (Medium): in `bun --hot`/watch, a rebuild re-transforms the entry file, `openapiDocument()` re-harvests, and the stale cached document is folded in. Smallest fix: delete the entry when its path is (re)transformed in `transformSource`, or key by harvested-input content. Do not remove the cache — a full program per harvest is the cost being avoided. |
| `TypeRegistry` | `src/registry.ts:20` | process; `clearTypeRegistry` (`:88`) has zero callers (grep across src and test) | With §1 fixed, keys are complete and cross-build staleness disappears for content changes; entries leak memory across watch sessions, bounded by distinct types/payloads. Optional: clear on build start. Not a correctness fix once §1 lands. |
| `declarationFileCache` | `src/plugin.ts:538` | process | Safe: `.d.ts` content is immutable per dependency install; shared per-file programs (`:861-879`). Memory bounded by parsed lib files. Keep. |
| `lastProgram` | `src/plugin.ts:547` | process, module-global across `wizPlugin()` instances | Safe: passed as `oldProgram` to `ts.createProgram` (`:881-887`); TypeScript re-checks file content. Perf-motivated (comment `:540-546`). Keep. |
| `idCounter` | `src/extractors/typescript.ts:20-23` | process-global, monotonic | Maintainability (Low): `ref.targetId` is keyed (`src/ir/types.ts:284-288`), so the same recursive type extracted twice in one process hashes differently → registry misses (perf/memory) and non-deterministic `wiz eject` aliases across runs. The OpenAPI extractor already has the right pattern — per-extraction `ctx.ids` with the comment "so two runs produce equal IR" (`src/extractors/openapi.ts:36-38,57-58`). Align the TS extractor to per-extraction ids. |

## 3. Public API and generator isolation

Clean. `src/index.ts` runtime stubs all throw `PluginInactiveError`; `wizPlugin`
is deliberately not re-exported from the root (comment `src/index.ts:283-286`)
so the TS compiler never enters an app bundle. Dependency directions are
one-way: `registry` → `generators` → `ir`; `plugin` → `registry` + `ir` +
`extractors`; `virtualPlugin` → `registry` only. No cycles found. `document.ts`
is build-time pure (comment `:4-9`). The `overrides` escape hatch is explicit
and correctly keyed: verbatim string spread last by the generator
(`src/generators/openapi.ts:326-328`) and included as `o:` in
`normalizeServiceMethod` (`src/ir/service.ts:133`). No caller-visible
compatibility risk found that follows from the code; the only latent surface is
the unwired `wiz/openapi` export feeding the registry (§1 P3). Per the plan's
contingency: recommend nothing that changes public exports.

## 4. Test architecture

- Entry styles: program-backed IR tests via `test/helpers.ts`
  (`getIRForSource`/`getIRsForSource`, `:88-122`); direct IR→generator tests
  (`test/ir_contracts.test.ts`, `test/service_ir.test.ts` with hand-built IR
  through `httpMethod`/`service` helpers, `:175-216`); registry-identity tests
  through `transformSource` (`test/registry_keys.test.ts:14-20`); true
  end-to-end via a globally registered Bun plugin (`test/plugin.test.ts:9`).
  This layering is sound — `registry_keys.test.ts` is exactly the right seam
  for the §1 regressions.
- Coverage gaps matching the confirmed defects: `annotations.test.ts:92`
  ("annotations participate in the structural hash") exercises property-level
  annotations only; `annotations.test.ts:186` tests type-level annotation
  emission, never hash participation. `service_ir.test.ts:202` proves
  operationId/summary/tags/deprecated reach the operation object but never that
  they reach `normalizeServiceMethod`. Nothing tests `fieldNumber` or
  nested-name identity.
- Isolation hazard: no test ever clears the registry; under default `bun test`
  all 38 files share one process and the module-global `TypeRegistry`,
  `idCounter`, `harvestCache`, and `helpers.ts:33-35` program caches. Today
  benign only because fixtures avoid same-named-different-content types — the
  same collision class as §1 leaking into test reliability. `--no-isolate`
  (`test:parallel`) additionally shares module state across files; measured
  19.71s vs 17.08s sequential, so parallelism currently buys nothing.

Recommended regression scenarios (files an implementation phase would touch;
none added by this review):

- `test/registry_keys.test.ts`: (a) two transforms of same-named types differing
  only in root JSDoc description → two modules (fails today, per P5); (b)
  `openapiSchema<{a: User}>` vs `<{a: Admin}>` → two modules, distinct component
  names (per P1); (c) same-named types differing only in `@fieldNumber` → two
  `protobufSchema` modules with distinct wire numbers (per P2); (d) same service
  differing only in `operationId`/`response.description` → two modules (per P3).
- `test/ir_contracts.test.ts`: `computeTypeIRHash` inequality for
  description/name/fieldNumber/discriminator single-field deltas.
- `test/service_ir.test.ts`: `normalizeServiceMethod` distinguishes the omitted
  metadata fields.
- Cache invalidation: repeated `transformSource` of one path with changed route
  content (harvestCache) in a new `test/harvest.test.ts`.
- Commands: `bun test test/registry_keys.test.ts test/ir_contracts.test.ts
  test/service_ir.test.ts --timeout=20000`, then full `bun test --timeout=20000`
  and `bun run typecheck`.

## Recommended execution sequence

1. Correctness (§1): extend `normalizeTypeIR`/`normalizeAnnotations`/
   `normalizeServiceMethod` in `src/ir/types.ts` + `src/ir/service.ts` to cover
   every emitted field; add the regression tests above to
   `test/registry_keys.test.ts`, `test/ir_contracts.test.ts`,
   `test/service_ir.test.ts`.
2. Cache lifetime (§2): invalidate `harvestCache` per entry-path re-transform in
   `src/plugin.ts`; align the TS extractor's id counter with `extractApiIR`'s
   per-extraction pattern.
3. Boundary extraction (§2): move the harvesting cluster (~600 lines:
   `collectOperations`, `readOperationSpec`, `collectRouteOperations`,
   `harvestDocument`, `runGeneratedDocument`, `staticValue`, version readers,
   `harvestCache`) into a new `src/harvest.ts` following the `virtualPlugin.ts`
   injection pattern — all functions are module-private today, so no public
   surface changes; defer if that stops holding.
4. Test hygiene alongside each step: `clearTypeRegistry()` in a `beforeEach` for
   registry-sensitive suites; leave script/parallelism changes out of scope.
