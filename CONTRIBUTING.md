# Contributing to Wiz

Thank you for your interest in contributing to `wiz`!

`wiz` is a compile-time type introspection engine and code generator for Bun and TypeScript. This document outlines the development workflow, project conventions, testing guidelines, and submission process for contributors.

---

## 1. Prerequisites & Development Setup

`wiz` is built for [Bun](https://bun.sh/). Make sure you have Bun installed (`>= 1.1`).

### Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/waldemar/wiz.git
cd wiz
bun install
```

### Useful Scripts

- **Run all unit & integration tests**:
  ```bash
  bun test
  ```
- **Run tests in parallel**:
  ```bash
  bun run test:parallel
  ```
- **Typecheck TypeScript files**:
  ```bash
  bun run typecheck
  ```

---

## 2. Project Architecture

Understanding the data flow makes contributing to `wiz` straightforward:

1. **Extractors** (`src/extractors/`): Parse input documents (OpenAPI, AsyncAPI, OpenRPC, Protobuf, TypeScript source) into intermediate representation (IR) nodes (`TypeIR`, `ServiceIR`, `ApiIR`).
2. **Intermediate Representation** (`src/ir/`):
   - `TypeIR`: Normalized, structural type graph nodes.
   - `ServiceIR`: Transport-agnostic operation definitions.
   - `ApiIR`: Combined API document root.
3. **Generators** (`src/generators/`): Code generators that translate IR nodes into TypeScript/JavaScript code, virtual modules, or JSON documents.
4. **Plugin Transformer** (`src/plugin.ts`, `src/harvest.ts`): Bun plugin (`wizPlugin()`) that harvests AST callsites during transpilation and rewrites them to import from auto-generated virtual modules mounted on `wiz-virtual/<hash>/index.js`.
5. **JSON Schema Validation Utility** (`src/validators/jsonSchema.ts`): Pre-validates generated OpenAPI, OpenRPC, and AsyncAPI schema outputs against official spec meta-schemas stored in `schemas/`.

---

## 3. How to Contribute

### Adding or Updating a Codec or Generator

1. **Implement the Generator**: Add or update generator logic under `src/generators/`.
2. **Pre-Validate Output**: Ensure any generated spec document runs through `assertValidSpecDocumentSync` before emitting.
3. **Wire Virtual Exports**: Update `VIRTUAL_EXPORTS` and visitor cases in `src/plugin.ts` and `SECTION_EXPORTS` in `src/generators/virtualGenerator.ts` if adding virtual module functions.
4. **Update Public Stubs**: Add function stubs in `src/index.ts` so callsites typecheck before transpilation.
5. **Add Tests**: Create or update tests under `test/`.
6. **Update Documentation**: Update the corresponding guide in `docs/` and the index in `README.md`.

---

## 4. Testing Guidelines

- Every new feature, extractor, or generator must include unit tests in `test/`.
- Ensure tests verify both compile-time code generation and runtime behavior.
- Run `bun run typecheck` and `bun test` to ensure there are no regressions across existing test suites.

---

## 5. Pull Request Guidelines

- Keep pull requests focused on a single feature or bug fix.
- Ensure all tests pass (`bun test`) and TypeScript typechecking succeeds (`bun run typecheck`).
- Write clear, descriptive commit messages describing the change.
