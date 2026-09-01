import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  extractApiIR,
  extractApiIRFromFile,
  type ExtractApiOptions,
} from "../extractors/openapi.ts";
import {
  extractProtoIR,
  extractProtoIRFromFile,
} from "../extractors/proto.ts";
import {
  generate,
  type GeneratedFiles,
  type Generator,
} from "../generators/generator.ts";
import type { ValidateTarget } from "../generators/tsClient.ts";
import type { ApiIR } from "../ir/api.ts";
import { consoleLogger } from "../logger.ts";

/**
 * Running one emitter over one document from the command line.
 *
 * The generator is not part of wiz: it is a module the caller names, so this
 * command is the only place that turns a string into code to run. Everything
 * else here is plumbing around that single decision — read a document, hand it
 * to the generator, put the files somewhere — and both ends of the plumbing
 * accept `-` so the command composes in a pipe instead of only on disk.
 */

/** What the CLI can configure on a generator; the rest is the generator's own. */
interface GenerateOptions {
  /** Passed through, not interpreted: a generator decides what it relaxes. */
  lenient: boolean;
  validate?: boolean | ValidateTarget[];
}

/**
 * `--format` values, as a table rather than a list so an unknown value is one
 * lookup and the parsed result is already the extractor's own union.
 */
const FORMATS: Record<string, ExtractApiOptions["format"]> = {
  json: "json",
  jsonc: "jsonc",
  json5: "json5",
  yaml: "yaml",
};

interface Invocation {
  generator: string;
  /** Undefined means stdin; a literal `-` is normalized to it. */
  input: string | undefined;
  /** Undefined means stdout; a literal `-` is normalized to it. */
  outdir: string | undefined;
  lenient: boolean;
  validate?: boolean | ValidateTarget[];
  format: ExtractApiOptions["format"];
}

/** The parts of a call `--validate` can name, in the order they are checked. */
const VALIDATE_TARGETS = ["path", "query", "headers", "body", "response"] as const;

function isValidateTarget(value: string): value is ValidateTarget {
  return (VALIDATE_TARGETS as readonly string[]).includes(value);
}

function parseValidateTargets(raw: string): ValidateTarget[] {
  const parts = raw.split(",").map((part) => part.trim());
  for (const part of parts) {
    if (!isValidateTarget(part)) {
      throw new Error(
        `unknown validate target '${part}'; expected ${VALIDATE_TARGETS.join(", ")}`
      );
    }
  }
  return parts as ValidateTarget[];
}

/**
 * Parsing throws rather than returning a result union: every failure in this
 * command reports the same way, so one catch in {@link runGenerate} covers the
 * argument errors, the load errors and the extractor's own.
 */

function parse(argv: string[]): Invocation {
  let generator: string | undefined;
  let input: string | undefined;
  let outdir: string | undefined;
  let lenient = false;
  let validate: boolean | ValidateTarget[] | undefined;
  let format: ExtractApiOptions["format"];

  /**
   * Flags that take a value must not silently swallow the next flag. A bare `-`
   * is exempt: it is a value, and the one `--outdir` legitimately takes.
   */
  const valueOf = (flag: string, raw: string | undefined): string => {
    if (raw === undefined || (raw.startsWith("-") && raw !== "-")) {
      throw new Error(`${flag} needs a value`);
    }
    return raw;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === "--generator" || arg === "-g") {
      generator = valueOf(arg, argv[++i]);
      continue;
    }
    if (arg === "--outdir" || arg === "-o") {
      outdir = valueOf(arg, argv[++i]);
      continue;
    }
    if (arg === "--format") {
      const raw = valueOf(arg, argv[++i]);
      format = FORMATS[raw];
      if (format === undefined) {
        throw new Error(
          `unknown format '${raw}'; expected ${Object.keys(FORMATS).join(", ")}`
        );
      }
      continue;
    }
    if (arg === "--lenient") {
      lenient = true;
      continue;
    }
    // The one flag whose value is optional: bare it means "everything", and a
    // comma-separated list narrows it. The value is only claimed when it can
    // be one - otherwise `--validate document.json` would eat the input - but
    // a comma is unambiguous enough to be worth a precise error on a typo,
    // since no input filename this command accepts contains one.
    if (arg === "--validate" || arg.startsWith("--validate=")) {
      if (arg.startsWith("--validate=")) {
        const raw = arg.slice("--validate=".length);
        validate = raw.length > 0 ? parseValidateTargets(raw) : true;
        continue;
      }

      const next = argv[i + 1];
      const claimable =
        next !== undefined &&
        (!next.startsWith("-") || next === "-") &&
        (next.includes(",") || isValidateTarget(next));

      if (claimable) {
        validate = parseValidateTargets(next);
        i++;
      } else {
        validate = true;
      }
      continue;
    }
    // A bare `-` is the stdin positional, so only longer dashed words are flags.
    if (arg.startsWith("-") && arg !== "-") {
      throw new Error(`unknown option '${arg}'`);
    }
    if (input !== undefined) {
      throw new Error(`unexpected argument '${arg}'`);
    }
    input = arg;
  }

  if (generator === undefined) {
    throw new Error("needs --generator <module>");
  }

  // Normalized here so nothing downstream has to know that `-` and an absent
  // argument mean the same thing at either end of the pipe.
  return {
    generator,
    input: input === "-" ? undefined : input,
    outdir: outdir === "-" ? undefined : outdir,
    lenient,
    validate,
    format,
  };
}

/**
 * A generator is a plugin, so its shape is only known at runtime. Checking the
 * three roots individually is what makes the failure message say which export
 * was missing instead of "not a generator".
 */
function usable(value: unknown): value is Generator<GenerateOptions> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Generator<GenerateOptions>>;
  if (typeof candidate.name !== "string") return false;
  return (
    typeof candidate.type === "function" ||
    typeof candidate.service === "function" ||
    typeof candidate.api === "function"
  );
}

const GENERATOR_SHORTCUTS: Record<string, string> = {
  reactQuery: "../generators/reactQuery.ts",
  "reactQuery.ts": "../generators/reactQuery.ts",
  tsClient: "../generators/tsClient.ts",
  "tsClient.ts": "../generators/tsClient.ts",
  openrpc: "../generators/openrpc.ts",
  "openrpc.ts": "../generators/openrpc.ts",
};

async function loadGenerator(
  module: string
): Promise<Generator<GenerateOptions>> {
  // The sanctioned exception to the repo's no-dynamic-import rule: the module
  // is named on the command line, so no static specifier can exist for it.
  // `resolve` pins it to the cwd rather than to this file, which is what makes
  // `--generator ./gen.ts` mean what the caller typed, and `pathToFileURL`
  // keeps an absolute path a legal specifier on Windows too.
  const shortcut = GENERATOR_SHORTCUTS[module];
  const url = shortcut
    ? new URL(shortcut, import.meta.url).href
    : pathToFileURL(resolve(module)).href;

  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(url)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `cannot load generator '${module}': ${(error as Error).message}`
    );
  }

  // `default` first: a module written for this command exports one generator.
  // A named `generator` export lets a module that already has a default (a
  // plugin, a config) still be addressable here.
  const candidate = loaded.default ?? loaded.generator;
  if (!usable(candidate)) {
    throw new Error(
      `'${module}' exports no usable generator; expected a default or 'generator' ` +
        "export with a string name and a type, service or api method"
    );
  }
  return candidate;
}

/**
 * Writes the record to disk, echoing paths the way `wiz eject` does.
 *
 * `Bun.write` creates parent directories, so the explicit `mkdir` is only for
 * the generator that emitted nothing: an outdir the caller asked for should
 * exist either way. Paths are echoed as given rather than resolved so the
 * output stays copy-pasteable.
 */
async function writeFiles(
  outdir: string,
  files: GeneratedFiles
): Promise<void> {
  await mkdir(outdir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    const path = join(outdir, name);
    await Bun.write(resolve(path), contents);
    console.log(`  ${path}`);
  }
}

/**
 * Reads the input through the front end its shape calls for.
 *
 * `.proto` is the only extension that is not an API document, and stdin has no
 * name at all: there, the `syntax = "proto3"` line is the only signal, and it is
 * a reliable one because a proto file must open with it.
 */
async function extractInput(
  invocation: Invocation,
  options: ExtractApiOptions
): Promise<ApiIR> {
  if (invocation.input === undefined) {
    const text = await Bun.stdin.text();
    return /^\s*syntax\s*=\s*["']proto[23]["']/m.test(text)
      ? extractProtoIR(text)
      : extractApiIR(text, options);
  }

  return invocation.input.toLowerCase().endsWith(".proto")
    ? await extractProtoIRFromFile(invocation.input)
    : await extractApiIRFromFile(invocation.input, options);
}

export async function runGenerate(argv: string[]): Promise<number> {
  try {
    const invocation = parse(argv);
    const options: ExtractApiOptions = { format: invocation.format };

    // The extension decides the front end: a `.proto` file is a gRPC service
    // definition, anything else is an API document, and each extractor already
    // infers its own dialect from the same name.
    const ir = await extractInput(invocation, options);

    // Dropped keywords are a fact about the output, not a failure: the caller
    // still gets the files, on stderr so stdout stays one JSON value.
    for (const diagnostic of ir.diagnostics) {
      console.warn(
        `wiz generate: dropped '${diagnostic.keyword}' at ${diagnostic.pointer}: ${diagnostic.message}`
      );
    }

    const generator = await loadGenerator(invocation.generator);
    const files = generate(
      ir,
      generator,
      { lenient: invocation.lenient, validate: invocation.validate },
      consoleLogger
    );

    if (invocation.outdir === undefined) {
      // Keys are file names, values are contents, so the whole output is one
      // JSON value — the same shape `wiz eject <dir>` prints.
      process.stdout.write(`${JSON.stringify(files, null, 2)}\n`);
      return 0;
    }

    await writeFiles(invocation.outdir, files);
    return 0;
  } catch (error) {
    console.error(`wiz generate: ${(error as Error).message}`);
    return 1;
  }
}
