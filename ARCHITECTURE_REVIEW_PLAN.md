# Pragmatic Architecture Review

## Context
Review the current wiz architecture and return a prioritized, evidence-backed assessment rather than making source changes. The review must cover module boundaries, IR/API contracts, state and cache lifetimes, generated-code boundaries, and test architecture. Keep recommendations practical: identify the smallest changes that remove correctness risk or materially improve maintainability; do not propose a broad rewrite.

## Approach
1. **Validate the IR and registry contract first.** Re-read `src/types.ts` (`normalizeTypeIR`, `walkTypeIR`), `src/ir/service.ts` (`normalizeServiceMethod`), `src/registry.ts` (`payloadKey`, `registerType`), and each generator’s consumed fields. Produce a concrete field matrix: every emitted field must appear in the canonical key, or be explicitly documented as non-emitted. Treat this as the highest-priority correctness finding because registry identity is content-addressed.
   - Specifically check root and nested `Annotated` fields (`description`, `deprecated`, `constraints`, `examples`, `default`, `meta`) across every `TypeIR` variant, plus `PropertyIR` metadata and all `ServiceMethodIR` request/response/operation metadata.
   - Compare the matrix against `normalizeTypeIR` and `normalizeServiceMethod`; call out exact omissions and whether they can make two different generated modules share a registry key.
   - Do not edit the implementation during the review; recommend a shared canonical normalization change only if the comparison confirms the omission.
2. **Map plugin boundaries and state lifetime.** Read `src/plugin.ts`, `src/virtualPlugin.ts`, `src/document.ts`, and `src/extractors/typescript.ts`. Identify which responsibilities are already isolated and which remain combined. Explicitly inspect `harvestCache`, `lastProgram`, `declarationFileCache`, the type registry, and the TypeScript ID counter for ownership, invalidation, and cross-build lifetime.
   - Evaluate the existing `virtualPlugin.ts` extraction as the boundary pattern to copy.
   - Recommend extracting only a clearly cohesive responsibility (most likely OpenAPI route harvesting) if the review confirms `plugin.ts` still mixes AST transformation, route discovery, static evaluation, and Bun hook orchestration.
   - For each cache, state the observable stale-data or memory-lifetime scenario and the smallest safe ownership change; do not recommend removing caching without evidence.
3. **Review public API and generator isolation.** Read `src/index.ts`, `src/ir/api.ts`, `src/ir/service.ts`, `src/document.ts`, `src/generators/virtualGenerator.ts`, and the README usage sections. Check that runtime stubs, compile-time transforms, generated modules, and the IR have one-way dependencies and that escape hatches such as operation overrides are explicit. Report compatibility risks only where a concrete caller-visible behavior follows from the code.
4. **Review test architecture and scenarios.** Read `test/helpers.ts`, `package.json`, and representative tests for plugin transforms, registry keys, extractors, schema/OpenAPI generation, and codecs. Map which tests enter through TypeScript program construction versus direct IR/generator tests, how caches affect isolation, and what `test` versus `test:parallel` actually exercises.
   - Recommend behavior-level regression scenarios for confirmed risks, including a same-type registry collision caused by annotation/service metadata differences and cache invalidation across repeated transforms of one path.
   - Do not add tests or change scripts as part of this review; list exact test files and commands an implementation phase would use.
5. **Deliver the review in priority order.** For each finding provide severity, evidence with exact paths/symbols, impact, and a bounded recommendation. Separate confirmed defects from maintainability opportunities. End with a short recommended execution sequence: correctness fix first, cache lifetime second, boundary extraction third, and test improvements alongside each change. Scope ends at the review report; no source, test, dependency, or configuration edits.

## Critical files & anchors
- `src/types.ts` — `normalizeTypeIR`, `normalizeAnnotations`, `walkTypeIR`; canonical TypeIR identity and traversal.
- `src/ir/service.ts` — `normalizeServiceMethod`; service payload identity used by the registry.
- `src/registry.ts` — `payloadKey`, `registerType`, module registry lifetime.
- `src/plugin.ts` — `transformSource`, `harvestDocument`, `routeAdapterFor`, cache declarations, and plugin setup orchestration.
- `test/helpers.ts` — `programFor`, `getIRForSource`, global TypeScript program caches, and direct-generator test seam.

## Verification
- Static verification: every finding must cite a read source path and symbol; no claim about field consumption, cache scope, or dependency direction may be included without that evidence.
- Run targeted read-only checks only if needed to validate behavior: `bun test test/registry_keys.test.ts test/ir_contracts.test.ts test/plugin.test.ts --timeout=20000` and `bun run typecheck`, from the repository root. Report exact results; these checks support the review but do not turn it into an implementation.
- The review’s new-behavior proof must be concrete: demonstrate from the code or a focused existing test that two inputs differing only in an omitted identity field can produce different generated output while sharing the current normalization key, or state that no such omission is confirmed.

## Assumptions & contingencies
- Assume the requested deliverable is an architecture review only because the request says “review”; do not modify source or tests. If the repository state differs from the inspected files, report the exact discrepancy and review the current state instead of extrapolating.
- If a suspected cache defect cannot be demonstrated from the current API and lifecycle, label it as a maintainability concern rather than a confirmed bug; do not invent invalidation semantics.
- If a proposed extraction would require changing public exports or introducing a compatibility layer, recommend deferring it and keep the existing public surface unchanged.
