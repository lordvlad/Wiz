// @wiz-ignore
import { describe, expect, test } from "bun:test";
import { generateZodSchemaCode } from "../src/generators/zod.ts";
import { generateValidatorCode } from "../src/generators/validator.ts";
import { evalModule, getIRsForSource } from "./helpers.ts";
import type { TypeIR } from "../src/types.ts";

/**
 * zod is the caller's copy, loaded through the function the module exports, so
 * a test supplies the loader the plugin would write at the callsite.
 */
type ZodModule = {
  zodSchema: (load: () => Promise<unknown>) => Promise<ZodLike>;
};

interface ZodLike {
  parse(value: unknown): unknown;
  safeParse(value: unknown): { success: boolean };
}

const load = (): Promise<unknown> => import("zod");

const irFor = (source: string, name: string): TypeIR =>
  getIRsForSource(source, [name])[name]!.ir;

const codeFor = (source: string, name: string): string =>
  generateZodSchemaCode(irFor(source, name));

const schemaFor = async (source: string, name: string): Promise<ZodLike> => {
  const mod = evalModule<ZodModule>(codeFor(source, name));
  return mod.zodSchema(load);
};

const accepts = (schema: ZodLike, value: unknown): boolean =>
  schema.safeParse(value).success;

describe("mapping the IR onto zod", () => {
  test("nothing in the emitted module names zod", () => {
    const code = codeFor("export interface A { id: string }", "A");

    // The import belongs at the callsite: a virtual module has nowhere to
    // resolve a package from.
    expect(code).not.toContain('import("zod")');
    expect(code).toContain("export const zodSchema = (load)");
    expect(code).toContain("await load()");
  });

  test("the schema is built once, however many callsites ask", async () => {
    const mod = evalModule<ZodModule>(
      codeFor("export interface A { id: string }", "A")
    );

    expect(await mod.zodSchema(load)).toBe(await mod.zodSchema(load));
  });

  test("primitives, optionality and literal unions", async () => {
    const schema = await schemaFor(
      `export interface A {
         id: string;
         age?: number;
         big: bigint;
         when: Date;
         kind: "a" | "b";
       }`,
      "A"
    );

    const valid = { id: "x", big: 1n, when: new Date(), kind: "a" };
    expect(accepts(schema, valid)).toBe(true);
    expect(accepts(schema, { ...valid, age: 3 })).toBe(true);
    expect(accepts(schema, { ...valid, kind: "c" })).toBe(false);
    expect(accepts(schema, { ...valid, big: 1 })).toBe(false);
    expect(accepts(schema, { ...valid, when: "yesterday" })).toBe(false);
  });

  test("an enum of strings, and one of numbers", async () => {
    const strings = await schemaFor(
      `export enum E { A = "a", B = "b" }
       export interface S { e: E }`,
      "S"
    );
    expect(accepts(strings, { e: "a" })).toBe(true);
    expect(accepts(strings, { e: "z" })).toBe(false);

    const numbers = await schemaFor(
      `export enum N { A = 1, B = 2 }
       export interface S { n: N }`,
      "S"
    );
    expect(accepts(numbers, { n: 2 })).toBe(true);
    expect(accepts(numbers, { n: 3 })).toBe(false);
  });

  test("records and nested objects", async () => {
    const schema = await schemaFor(
      `export interface A {
         counts: Record<string, number>;
         inner: { flag: boolean };
       }`,
      "A"
    );

    expect(accepts(schema, { counts: { a: 1 }, inner: { flag: true } })).toBe(true);
    expect(accepts(schema, { counts: { a: "1" }, inner: { flag: true } })).toBe(false);
    expect(accepts(schema, { counts: {}, inner: { flag: 1 } })).toBe(false);
  });

  test("a fixed tuple maps; one that varies in length says why it cannot", async () => {
    const fixed = await schemaFor("export type T = [string, number];", "T");
    expect(accepts(fixed, ["a", 1])).toBe(true);
    expect(accepts(fixed, ["a"])).toBe(false);
    // A zod tuple has no rest element, so the schema refuses to exist rather
    // than quietly accepting a different shape. The TypeScript extractor
    // flattens a rest tuple into a fixed one, so the IR is built here.
    const withRest: TypeIR = {
      id: "t_1",
      kind: "tuple",
      elements: [
        { type: { id: "t_2", kind: "primitive", type: "string" }, optional: false },
      ],
      rest: { id: "t_3", kind: "primitive", type: "number" },
    };
    const mod = evalModule<ZodModule>(generateZodSchemaCode(withRest));
    await expect(mod.zodSchema(load)).rejects.toThrow(
      "[wiz] zod cannot express a tuple with a rest element"
    );
  });
});

describe("constraints reach the schema", () => {
  test("string length, pattern and format", async () => {
    const schema = await schemaFor(
      `export interface A {
         /** @minLength 2 @maxLength 4 */
         short: string;
         /** @pattern ^a+$ */
         letters: string;
         /** @format email */
         mail: string;
       }`,
      "A"
    );

    const valid = { short: "ab", letters: "aaa", mail: "a@b.co" };
    expect(accepts(schema, valid)).toBe(true);
    expect(accepts(schema, { ...valid, short: "a" })).toBe(false);
    expect(accepts(schema, { ...valid, short: "abcde" })).toBe(false);
    expect(accepts(schema, { ...valid, letters: "b" })).toBe(false);
    expect(accepts(schema, { ...valid, mail: "nope" })).toBe(false);
  });

  test("number bounds and integer widths", async () => {
    const schema = await schemaFor(
      `export interface A {
         /** @min 1 @max 10 */
         ranged: number;
         /** @format int32 */
         width: number;
       }`,
      "A"
    );

    expect(accepts(schema, { ranged: 5, width: 2147483647 })).toBe(true);
    expect(accepts(schema, { ranged: 0, width: 1 })).toBe(false);
    expect(accepts(schema, { ranged: 11, width: 1 })).toBe(false);
    // An int32 field is an integer inside its width, and the schema says both.
    expect(accepts(schema, { ranged: 5, width: 2147483648 })).toBe(false);
    expect(accepts(schema, { ranged: 5, width: 1.5 })).toBe(false);
  });

  test("array length and uniqueness", async () => {
    const schema = await schemaFor(
      `export interface A {
         /** @minItems 1 @uniqueItems */
         tags: string[];
       }`,
      "A"
    );

    expect(accepts(schema, { tags: ["a", "b"] })).toBe(true);
    expect(accepts(schema, { tags: [] })).toBe(false);
    expect(accepts(schema, { tags: ["a", "a"] })).toBe(false);
  });

  test("`@uniqueItems false` states no requirement, so it imposes none", async () => {
    const schema = await schemaFor(
      `export interface A {
         /** @uniqueItems false */
         tags: string[];
       }`,
      "A"
    );

    expect(accepts(schema, { tags: ["a", "a"] })).toBe(true);
  });
});

/**
 * The schema and the generated validator come from one IR, so nothing else was
 * checking that they agree - the same reason Ajv is run against the validator.
 */
describe("the zod schema and the generated validator agree", () => {
  const SOURCE = `
    export interface Agree {
      /** @minLength 2 */
      id: string;
      /** @min 0 @max 5 */
      score: number;
      /** @minItems 1 */
      tags: string[];
      kind: "a" | "b";
      nested?: { flag: boolean };
    }
  `;

  const CASES: unknown[] = [
    { id: "ab", score: 1, tags: ["x"], kind: "a" },
    { id: "ab", score: 1, tags: ["x"], kind: "a", nested: { flag: true } },
    { id: "a", score: 1, tags: ["x"], kind: "a" },
    { id: "ab", score: 9, tags: ["x"], kind: "a" },
    { id: "ab", score: -1, tags: ["x"], kind: "a" },
    { id: "ab", score: 1, tags: [], kind: "a" },
    { id: "ab", score: 1, tags: ["x"], kind: "c" },
    { id: "ab", score: 1, tags: ["x"] },
    { id: 2, score: 1, tags: ["x"], kind: "a" },
    { id: "ab", score: 1, tags: ["x"], kind: "b", nested: { flag: "yes" } },
  ];

  test("every case gets the same verdict from both", async () => {
    const ir = irFor(SOURCE, "Agree");
    const schema = await evalModule<ZodModule>(
      generateZodSchemaCode(ir)
    ).zodSchema(load);
    const { validate } = evalModule<{
      validate: (value: unknown) => unknown[];
    }>(generateValidatorCode(ir));

    for (const value of CASES) {
      expect({
        value,
        zod: accepts(schema, value),
      }).toEqual({ value, zod: validate(value).length === 0 });
    }
  });
});
