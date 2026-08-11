// @wiz-ignore
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { wizPlugin } from "../src/plugin.ts";

/**
 * Warnings are emitted during transformation, so the build is driven directly
 * rather than importing the fixture (module init would only happen once, and
 * the transform may already have been cached by another suite).
 */
async function buildWithWarnings(entrypoint: string): Promise<string[]> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    const result = await Bun.build({
      entrypoints: [entrypoint],
      target: "bun",
      plugins: [wizPlugin()],
    });
    expect(result.success).toBe(true);
  } finally {
    console.warn = original;
  }
  return warnings.filter((w) => w.includes("[wiz]"));
}

describe("undocumentable route diagnostics", () => {
  let warnings: string[];

  beforeAll(async () => {
    warnings = await buildWithWarnings(
      "./test/fixtures/undocumentableFixture.ts"
    );
  });

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
    expect(await buildWithWarnings("./test/fixtures/serverFixture.ts")).toEqual(
      []
    );
    expect(await buildWithWarnings("./test/fixtures/honoFixture.ts")).toEqual(
      []
    );
  });
});
