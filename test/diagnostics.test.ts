// @wiz-ignore
import { beforeAll, describe, expect, test } from "bun:test";
import { wizPlugin } from "../src/plugin.ts";
import {
  consoleLogger,
  silentLogger,
  type WizLogger,
} from "../src/logger.ts";

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

/**
 * Warnings are emitted during transformation, so the build is driven directly
 * rather than importing the fixture (module init would only happen once, and
 * the transform may already have been cached by another suite).
 */
async function buildWith(
  entrypoint: string,
  logger: WizLogger
): Promise<void> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: "bun",
    plugins: [wizPlugin({ logger })],
  });
  expect(result.success).toBe(true);
}

async function warningsFor(entrypoint: string): Promise<string[]> {
  const { logger, captured } = capturingLogger();
  await buildWith(entrypoint, logger);
  return captured.warn;
}

describe("undocumentable route diagnostics", () => {
  let warnings: string[];

  beforeAll(async () => {
    warnings = await warningsFor("./test/fixtures/undocumentableFixture.ts");
  }, 30_000);

  const matching = (needle: string) => () =>
    warnings.filter((w) => w.includes(needle));

  test("warns when the routes argument is not an inline object literal", () => {
    const hits = matching("must be an inline object literal")();
    expect(hits.length).toBe(1);
  });

  test("warns on spread route entries", () => {
    expect(matching("spread routes are resolved at runtime")().length).toBe(1);
  });

  test("warns on computed route keys", () => {
    expect(matching("route keys must be string literals")().length).toBe(1);
  });

  test("warns when a route value is a reference that cannot be introspected", () => {
    const hits = matching("cannot be introspected")();
    expect(hits.length).toBe(1);
    expect(hits[0]).toContain('"/referenced"');
  });

  test("every warning carries a file:line:column location", () => {
    expect(warnings.length).toBeGreaterThan(0);
    for (const warning of warnings) {
      expect(warning).toMatch(/ {2}at .+undocumentableFixture\.ts:\d+:\d+$/m);
    }
  });

  test("clean fixtures produce no warnings at all", async () => {
    expect(await warningsFor("./test/fixtures/serverFixture.ts")).toEqual([]);
    expect(await warningsFor("./test/fixtures/honoFixture.ts")).toEqual([]);
  });
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

  test("defaults to console for warnings", async () => {
    const seen = await withConsoleCapture("warn", async () => {
      const result = await Bun.build({
        entrypoints: ["./test/fixtures/undocumentableFixture.ts"],
        target: "bun",
        plugins: [wizPlugin()],
      });
      expect(result.success).toBe(true);
    });
    expect(seen.some((line) => line.includes("[wiz]"))).toBe(true);
  });

  test("default logger drops trace, so builds are not buried in stacks", async () => {
    // serverFixture documents five routes; each would emit a stack via
    // console.trace if the default wired trace up.
    const seen = await withConsoleCapture("trace", async () => {
      const result = await Bun.build({
        entrypoints: ["./test/fixtures/serverFixture.ts"],
        target: "bun",
        plugins: [wizPlugin()],
      });
      expect(result.success).toBe(true);
    });
    expect(seen).toEqual([]);
  });

  test("consoleLogger opts trace back in", async () => {
    const seen = await withConsoleCapture("trace", async () => {
      await buildWith("./test/fixtures/serverFixture.ts", consoleLogger);
    });
    expect(seen).toEqual([
      "[wiz] documented GET /api/status",
      "[wiz] documented GET /users",
      "[wiz] documented POST /users",
      "[wiz] documented GET /users/{id}",
      "[wiz] documented DELETE /users/{id}",
    ]);
  });

  test("silentLogger suppresses every diagnostic", async () => {
    const seen = await withConsoleCapture("warn", () =>
      buildWith("./test/fixtures/undocumentableFixture.ts", silentLogger)
    );
    expect(seen).toEqual([]);
  });

  test("a custom logger receives the route trace without touching console", async () => {
    const { logger, captured } = capturingLogger();
    await buildWith("./test/fixtures/serverFixture.ts", logger);

    expect(captured.warn).toEqual([]);
    expect(captured.trace).toEqual([
      "[wiz] documented GET /api/status",
      "[wiz] documented GET /users",
      "[wiz] documented POST /users",
      "[wiz] documented GET /users/{id}",
      "[wiz] documented DELETE /users/{id}",
    ]);
  });
});
