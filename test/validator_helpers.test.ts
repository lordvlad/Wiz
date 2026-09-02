// @wiz-ignore
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { helpersFor } from "../src/generators/validator.ts";
import type { TypeIR } from "../src/ir/types.ts";

/**
 * The validator's runtime helpers, held to the same standard as everything
 * else it emits.
 *
 * These are emitted as source text, so nothing in the normal build ever reads
 * them: `validator.ts` puts them in a virtual module Bun loads as JS, and for a
 * long time that meant an unannotated parameter or a genuine type error in one
 * would only surface in a consumer's build of a generated client. That is what
 * this file closes. The helpers are written to a real file and compiled by
 * `tsc` under `strict`, so the same check a consumer would run happens here.
 *
 * They are also the one part of the validator with two renderings - plain for
 * the virtual module, annotated for the `.ts` `tsClient.ts` writes - so the
 * other half of this file pins that the two never become two implementations.
 */

/** A type whose constraints reach for every helper there is. */
const REACHES_ALL: TypeIR = {
  id: "root",
  kind: "object",
  properties: [
    {
      name: "text",
      optional: false,
      readonly: false,
      type: {
        id: "text",
        kind: "primitive",
        type: "string",
        // `minLength` pulls in __wizLength, `pattern` pulls in __wizPattern.
        constraints: [
          { kind: "minLength", value: 3 },
          { kind: "pattern", value: "^a" },
        ],
      },
    },
    {
      name: "items",
      optional: false,
      readonly: false,
      type: {
        id: "items",
        kind: "array",
        element: { id: "element", kind: "primitive", type: "string" },
        // `uniqueItems` pulls in __wizUnique, and __wizEqual with it.
        constraints: [{ kind: "uniqueItems", value: true }],
      },
    },
  ],
};

const HELPER_NAMES = ["__wizLength", "__wizPattern", "__wizUnique", "__wizEqual"];

describe("the emitted helpers", () => {
  test("a type with no constraints pulls in none of them", () => {
    const bare: TypeIR = { id: "b", kind: "primitive", type: "string" };

    expect(helpersFor(bare)).toEqual([]);
  });

  test("only the helpers a constraint reaches for are emitted", () => {
    const lengthOnly: TypeIR = {
      id: "l",
      kind: "primitive",
      type: "string",
      constraints: [{ kind: "maxLength", value: 4 }],
    };

    const source = helpersFor(lengthOnly).join("\n");
    expect(source).toContain("__wizLength");
    expect(source).not.toContain("__wizPattern");
    expect(source).not.toContain("__wizUnique");
  });

  test("every helper is reachable from some constraint", () => {
    const source = helpersFor(REACHES_ALL).join("\n");

    for (const name of HELPER_NAMES) {
      expect(source).toContain(`function ${name}(`);
    }
  });

  /**
   * The annotated rendering exists so a consumer's `strict` build of a
   * generated client compiles. If the two renderings ever differ by more than
   * a parameter list, one of them has become a second implementation - which
   * for a deep equality is a guarantee of eventually disagreeing with itself.
   */
  test("annotating changes signatures and nothing else", () => {
    const plain = helpersFor(REACHES_ALL).join("\n\n").split("\n");
    const annotated = helpersFor(REACHES_ALL, true).join("\n\n").split("\n");

    expect(annotated).toHaveLength(plain.length);

    const changed = plain
      .map((line, index) => (line === annotated[index] ? undefined : line))
      .filter((line): line is string => line !== undefined);

    // Only declaration lines may differ: a body line changing means the two
    // renderings have drifted apart.
    for (const line of changed) {
      expect(line).toMatch(/^(function __wiz|const __wizPatterns)/);
    }
  });
});

describe("the emitted helpers typecheck", () => {
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "wiz-helpers-"));
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /**
   * Compiles `source` as a standalone module and returns what `tsc` said.
   *
   * The helpers are emitted into a consumer's file, so they are compiled the
   * way a consumer would: `strict` on, and `noUnusedLocals` off because a
   * document that reaches for one helper does not have to reach for all.
   */
  const diagnose = async (name: string, source: string): Promise<string[]> => {
    const file = join(directory, name);
    await Bun.write(file, source);

    const program = ts.createProgram([file], {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      skipLibCheck: true,
      lib: ["lib.esnext.d.ts"],
    });

    return [
      ...program.getSyntacticDiagnostics(),
      ...program.getSemanticDiagnostics(),
    ].map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")
    );
  };

  test("under strict TypeScript, on their own", async () => {
    expect(await diagnose("helpers.ts", helpersFor(REACHES_ALL, true).join("\n\n"))).toEqual([]);
  });

  /**
   * Declaring them is not the same as being able to call them: a parameter
   * annotated too narrowly typechecks here and fails at the callsite the
   * checks actually generate.
   */
  test("and are callable at the types the checks pass them", async () => {
    const source = [
      helpersFor(REACHES_ALL, true).join("\n\n"),
      "",
      "// The shapes `generateValidationBlock` hands them.",
      "const value: unknown = { text: 'abc', items: ['a', 'b'] };",
      "const record = value as Record<string, unknown>;",
      "const text = record['text'] as string;",
      "const items = record['items'] as string[];",
      "",
      "export const results: boolean[] = [",
      "  __wizLength(text) >= 3,",
      "  __wizPattern('^a').test(text),",
      "  __wizUnique(items),",
      "  __wizEqual(record, record),",
      "];",
    ].join("\n");

    expect(await diagnose("callsites.ts", source)).toEqual([]);
  });

  /**
   * The plain rendering is loaded as JavaScript, so annotations leaking into
   * it would be a syntax error in every virtual module the plugin mounts.
   */
  test("the plain rendering is still valid JavaScript", () => {
    const source = helpersFor(REACHES_ALL).join("\n\n");

    // No annotation may leak into the rendering Bun loads as JS.
    expect(source).not.toMatch(/function __wiz\w+\([^)]*:/);
    expect(source).not.toContain("new Map<");

    const { diagnostics } = ts.transpileModule(source, {
      reportDiagnostics: true,
      compilerOptions: { allowJs: true, target: ts.ScriptTarget.ESNext },
      fileName: "helpers.js",
    });

    expect(
      (diagnostics ?? []).map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")
      )
    ).toEqual([]);
  });
});

/**
 * What the helpers are for. Each exists because the obvious JS spelling is not
 * what JSON Schema means, so a test that only proved they compile would miss
 * the entire point of them.
 */
describe("the emitted helpers behave", () => {
  interface Helpers {
    __wizLength(str: string): number;
    __wizPattern(src: string): RegExp;
    __wizUnique(items: unknown[]): boolean;
    __wizEqual(a: unknown, b: unknown): boolean;
  }

  const helpers = new Function(
    `${helpersFor(REACHES_ALL).join("\n\n")}\nreturn { __wizLength, __wizPattern, __wizUnique, __wizEqual };`
  )() as Helpers;

  test("length counts code points, not UTF-16 units", () => {
    expect(helpers.__wizLength("abc")).toBe(3);
    // The whole reason the helper exists: String.length says 2.
    expect("😀".length).toBe(2);
    expect(helpers.__wizLength("😀")).toBe(1);
    expect(helpers.__wizLength("a😀b")).toBe(3);
  });

  test("equality is structural and ignores key order", () => {
    expect(helpers.__wizEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(helpers.__wizEqual([1, [2]], [1, [2]])).toBe(true);
    expect(helpers.__wizEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(helpers.__wizEqual([1, 2], { 0: 1, 1: 2 })).toBe(false);
  });

  test("uniqueness compares by value, which is what `Set` would not", () => {
    expect(helpers.__wizUnique([{ a: 1 }, { a: 2 }])).toBe(true);
    // Two distinct objects, one value: a Set would call this unique.
    expect(helpers.__wizUnique([{ a: 1 }, { a: 1 }])).toBe(false);
    expect(helpers.__wizUnique([])).toBe(true);
  });

  test("patterns are compiled once and cached", () => {
    expect(helpers.__wizPattern("^a")).toBe(helpers.__wizPattern("^a"));
    expect(helpers.__wizPattern("^a").test("abc")).toBe(true);
    // A Map rather than an object, so this key cannot reach a prototype.
    expect(helpers.__wizPattern("__proto__").source).toBe("__proto__");
  });
});
