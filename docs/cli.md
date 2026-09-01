# Command Line Interface (CLI)

`wiz` includes a command-line interface for project setup, code ejection, and standalone code generation.

```bash
# Initialize wiz in a project
bunx wiz init [--force]

# Eject transformed code to disk
bunx wiz eject <file.ts> [out.ts]
bunx wiz eject <project-dir> [outdir]

# Run a generator over a document or schema
bunx wiz generate -g <generator.ts> [input-file] [--outdir <dir>]
```

## `wiz init`

`wiz init` configures `wiz` in the current working directory.

```bash
bunx wiz init
```

### What `wiz init` Does

1. Creates `wizPlugin.ts` preloading `wizPlugin()`:
   ```ts
   import { plugin } from "bun";
   import { wizPlugin } from "wiz/plugin";

   plugin(wizPlugin());
   ```
2. Updates `bunfig.toml` to register `wizPlugin.ts` under `preload` for both runtime execution (`bun run`) and testing (`bun test`).

### Options

- `--force`: Overwrites an existing `wizPlugin.ts` instead of leaving it intact.

`wiz init` is idempotent and safe to re-run: existing configuration in `bunfig.toml` is merged rather than overwritten.

## `wiz eject`

`wiz eject` transforms code containing `wiz` callsites and writes the output to disk with no runtime dependency on `wiz`.

### Ejecting a Single File

```bash
bunx wiz eject src/main.ts src/main.ejected.ts
```

If no output filename is provided, the ejected code is printed to stdout as a JSON record.

Single-file eject inlines generated helper functions directly into the file. If the file requires program-wide route harvesting (such as `openapiDocument()`), single-file eject throws an error requiring project-level eject.

### Ejecting a Project

```bash
bunx wiz eject . outdir/
```

Project eject requires a `tsconfig.json` in the root directory. It reads all included files, transforms callsites, and emits generated virtual modules into readable directory siblings (`wiz-User-<digest>/index.js`).

Ejected files include a `@wiz-ignore` header to prevent `wizPlugin` from transforming already-ejected output.

## `wiz generate`

`wiz generate` runs any generator over an input document (OpenAPI spec, `.proto` file, or JSON schema).

```bash
wiz generate -g wiz/generators/tsClient.ts openapi.yaml --outdir src/api
```

### Options

| Flag | Short | Description |
|---|---|---|
| `--generator <path>` | `-g` | Path to generator file (e.g., `wiz/generators/tsClient.ts`). Required. |
| `--outdir <dir>` | `-o` | Output directory. If omitted, JSON record is printed to stdout. |
| `--format <fmt>` | `-f` | Override input format inference (`openapi`, `proto`, `jsonschema`). |
| `--lenient` | | Widen parameter shapes in client generators. |

### Input Inference

Input format is inferred automatically from file extension:
- `.proto` -> Protocol Buffers parser (`extractProtoIR`).
- `.json` / `.yaml` / `.yml` -> OpenAPI extractor (`extractApiIR`).

Input can also be piped from `stdin`:

```bash
cat openapi.yaml | wiz generate -g wiz/generators/tsClient.ts --outdir src/api
```

## Diagnostics and Stderr

Compile-time warnings (such as unsupported OpenAPI keywords or missing JSDoc tags) are printed to `stderr`. Generated code or JSON payloads are written to `stdout` or `--outdir`.

Exit codes:
- `0`: Success.
- `1`: Invocation or generation error.
