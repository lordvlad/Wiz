// @wiz-ignore
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transformSource, wizPlugin } from "../src/plugin.ts";
import { silentLogger, type WizLogger } from "../src/logger.ts";

interface Captured {
  warn: string[];
  error: string[];
  trace: string[];
  info: string[];
}

function capturingLogger(): { logger: WizLogger; captured: Captured } {
  const captured: Captured = { warn: [], error: [], trace: [], info: [] };
  const record = (level: keyof Captured) => (...args: unknown[]) => {
    captured[level].push(args.map(String).join(" "));
  };
  return {
    logger: {
      trace: record("trace"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
    },
    captured,
  };
}

/** A type argument that describes nothing: no method, so no operation. */
const UNDOCUMENTABLE = `
import { mcpSchema, openRPCSchema } from "../../src/index.ts";

export interface Payload {
  id: string;
}

export const rpc = openRPCSchema<[Payload]>();
export const tools = mcpSchema<[Payload]>();
`;

/**
 * The same shape with methods beside it. A payload-only argument is what the
 * warning is about, so the clean case passes the service alone.
 */
const CLEAN = `
import { openRPCSchema } from "../../src/index.ts";

export interface Payload {
  id: string;
}

export interface PayloadApi {
  /** @summary Reads one */
  read(id: string): Promise<Payload>;
}

export const rpc = openRPCSchema<[PayloadApi]>();
`;

function warningsFor(contents: string): string[] {
  const { logger, captured } = capturingLogger();
  transformSource({ path: "test/fixtures/diagnostic.ts", contents, logger });
  return captured.warn;
}

/**
 * Each `transformSource` here builds a `ts.Program` over `src/index.ts` and
 * everything it imports, so the timeouts are generous on purpose: the default
 * five seconds is a cold TypeScript program away from flaking.
 */
describe("undocumentable type diagnostics", () => {
  let warnings: string[];

  beforeAll(() => {
    warnings = warningsFor(UNDOCUMENTABLE);
  }, 60_000);

  test("warns once per macro that has nothing to describe", () => {
    expect(
      warnings.filter((warning) =>
        warning.includes("no methods found on object type 'Payload' for openRPCSchema")
      )
    ).toHaveLength(1);
    expect(
      warnings.filter((warning) =>
        warning.includes("no methods found on object type 'Payload' for mcpSchema")
      )
    ).toHaveLength(1);
  });

  test("every warning carries a file:line:column location", () => {
    expect(warnings.length).toBeGreaterThan(0);
    for (const warning of warnings) {
      expect(warning).toMatch(/ {2}at .+diagnostic\.ts:\d+:\d+$/m);
    }
  });

  test("a service with methods produces no warnings at all", () => {
    expect(warningsFor(CLEAN)).toEqual([]);
  }, 60_000);
});

describe("openapiDocument() with nothing to harvest", () => {
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "wiz-diagnostics-"));
  });

  test("says so rather than emitting an empty document silently", async () => {
    const entry = join(directory, "entry.ts");
    await writeFile(
      entry,
      `declare function openapiDocument(): Record<string, unknown>;\n` +
        `export const document = openapiDocument();\n`
    );

    const { logger, captured } = capturingLogger();
    transformSource({
      path: entry,
      contents: await Bun.file(entry).text(),
      logger,
    });

    expect(
      captured.warn.some((warning) =>
        warning.includes("found no operations reachable from")
      )
    ).toBe(true);

    await rm(directory, { recursive: true, force: true });
  }, 60_000);
});

describe("logger parameter", () => {
  /** Captures a console method for the duration of one build. */
  async function withConsoleCapture(
    level: "warn" | "trace",
    run: () => Promise<void>
  ): Promise<string[]> {
    const seen: string[] = [];
    const original = console[level];
    console[level] = (...args: unknown[]) => {
      seen.push(args.map(String).join(" "));
    };
    try {
      await run();
    } finally {
      console[level] = original;
    }
    return seen;
  }

  let fixture: string;

  beforeAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), "wiz-logger-"));
    fixture = join(directory, "undocumentable.ts");
    await writeFile(
      fixture,
      UNDOCUMENTABLE.replaceAll("../../src/index.ts", join(process.cwd(), "src/index.ts"))
    );
  });

  const build = async (logger?: WizLogger): Promise<void> => {
    const result = await Bun.build({
      entrypoints: [fixture],
      target: "bun",
      plugins: [logger ? wizPlugin({ logger }) : wizPlugin()],
    });
    expect(result.success).toBe(true);
  };

  test("defaults to console for warnings", async () => {
    const seen = await withConsoleCapture("warn", () => build());
    expect(seen.some((line) => line.includes("[wiz]"))).toBe(true);
  }, 60_000);

  test("silentLogger suppresses every diagnostic", async () => {
    const seen = await withConsoleCapture("warn", () => build(silentLogger));
    expect(seen).toEqual([]);
  }, 60_000);

  test("a custom logger receives them without touching console", async () => {
    const { logger, captured } = capturingLogger();
    const seen = await withConsoleCapture("warn", () => build(logger));

    expect(seen).toEqual([]);
    expect(captured.warn.some((warning) => warning.includes("[wiz]"))).toBe(true);
  }, 60_000);
});
