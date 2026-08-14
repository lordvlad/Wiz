// @wiz-ignore
import { describe, expect, test } from "bun:test";
import { plugin } from "bun";
import { wizPlugin } from "../src/plugin.ts";
import { silentLogger } from "../src/logger.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Registered for this file's own imports; `Bun.build` below gets its own copy.
plugin(wizPlugin({ logger: silentLogger }));

/**
 * What survives `bun build`.
 *
 * wiz is a compile-time tool, so the only honest test of that claim is to build
 * something and read the output. Every helper is replaced, every document is
 * resolved, and none of wiz's own runtime is dragged along.
 */

async function bundle(entry: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [entry],
    plugins: [wizPlugin({ logger: silentLogger })],
    target: "bun",
  });
  if (!result.success) {
    throw new Error(result.logs.map(String).join("\n"));
  }
  return result.outputs[0]!.text();
}

/** Names that only exist if a piece of wiz reached the output. */
const RUNTIME_TRACES = [
  "PluginInactiveError",
  "__mergeDocument",
  "mergeDocumentFragment",
  "mergeDocuments",
  "mergedDocument",
  "wiz] Function",
  "openapiDocument",
];

describe("nothing of wiz survives the build", () => {
  test("a route module bundles to the routes literal alone", async () => {
    const code = await bundle("./test/fixtures/serverFixture.ts");

    for (const trace of RUNTIME_TRACES) expect(code).not.toContain(trace);
    // `op()` is a compile-time carrier and must not appear as a call.
    expect(code).not.toMatch(/\bop\(/);
    // The handlers themselves obviously survive.
    expect(code).toContain("Response.json");
  });

  test("the document is inlined as data, not rebuilt at runtime", async () => {
    const code = await bundle("./test/fixtures/errorsFixture.ts");

    for (const trace of RUNTIME_TRACES) expect(code).not.toContain(trace);
    // No function that assembles a document, just the finished value.
    expect(code).not.toContain("buildDocument");
    expect(code).toContain('"/users/{id}"');
    expect(code).toContain('"#/components/schemas/NotFound"');
  });

  test("the inlined document is the one the fixture reports", async () => {
    const fixture = await import("./fixtures/errorsFixture.ts");
    const code = await bundle("./test/fixtures/errorsFixture.ts");

    // Running the bundle must produce the same document the plugin serves at
    // runtime; the literal is a substitution, not a second answer.
    const dir = await mkdtemp(join(tmpdir(), "wiz-bundle-"));
    try {
      const path = join(dir, "bundle.mjs");
      await Bun.write(path, code);
      const built = await import(pathToFileURL(path).href);
      expect(built.document).toEqual(fixture.document);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("validators and schemas inline without importing wiz", async () => {
    const code = await bundle("./test/fixtures/readmeFixture.ts");

    for (const trace of RUNTIME_TRACES) expect(code).not.toContain(trace);
    expect(code).not.toMatch(/from\s+"[^"]*src\/index\.ts"/);
    // The generated validator is present instead of a call into wiz.
    expect(code).toContain("function validate(");
    expect(code).toContain("function is(");
  });

  test("a module that validates carries no codec it never calls", async () => {
    // Every virtual module holds all the generators, so the unused ones have to
    // be free of top-level side effects for a bundler to drop them.
    const code = await bundle("./test/fixtures/readmeFixture.ts");

    expect(code).not.toContain("new TextEncoder");
    expect(code).not.toContain("new TextDecoder");
    expect(code).not.toContain("writeVarint");
    expect(code).not.toContain("__wizPatterns");
  });

  test("but a module that does encode keeps it", async () => {
    const code = await bundle("./test/fixtures/userFixture.ts");
    expect(code).toContain("writeVarint");
  });

  test("a codec module carries its codec and nothing else of wiz", async () => {
    const code = await bundle("./test/fixtures/avroFixture.ts");

    for (const trace of RUNTIME_TRACES) expect(code).not.toContain(trace);
    expect(code).toContain("writeLong");
  });

  test("an arrow module carries its codec but not apache-arrow", async () => {
    const code = await bundle("./test/fixtures/arrowFixture.ts");

    for (const trace of RUNTIME_TRACES) expect(code).not.toContain(trace);
    // The schema was built during the transform and inlined as bytes, so the
    // library that built it has no reason to be here.
    expect(code).not.toMatch(/apache-arrow/);
    expect(code).not.toContain("RecordBatchReader");
    expect(code).not.toContain("tableToIPC");
    // What remains is the generated codec and the schema it inlined.
    expect(code).toContain("function encodeArrow(");
    expect(code).toContain("__arrowSchema");
  });
});
