import { beforeEach, describe, expect, test } from "bun:test";
import { generateValidatorCode } from "../src/generators/validator.ts";
import { generateZodSchemaCode } from "../src/generators/zod.ts";
import { generateSchemaCode } from "../src/generators/schema.ts";
import { evalModule, getIRForSource } from "./helpers.ts";
import type { ValidationError } from "../src/types.ts";
import { clearTypeRegistry } from "../src/registry.ts";

describe("@pattern forward slash handling", () => {
  beforeEach(() => {
    clearTypeRegistry();
  });
  test("extracts pattern with unescaped forward slashes without syntax error", () => {
    const sourceText = `
export interface PatternObj {
  /** @pattern [0-9]{2}/[0-9]{4} */
  date1: string;
  /** @pattern /^[0-9]{2}\\/[0-9]{4}$/ */
  date2: string;
}
`;

    const ir = getIRForSource(sourceText, "PatternObj");
    expect(ir.kind).toBe("object");

    const validatorCode = generateValidatorCode(ir);
    const zodCode = generateZodSchemaCode(ir);
    const schemaCode = generateSchemaCode(ir);

    expect(validatorCode.includes('__wizPattern("[0-9]{2}/[0-9]{4}")')).toBe(true);
    expect(validatorCode.includes('__wizPattern("^[0-9]{2}/[0-9]{4}$")')).toBe(true);
    expect(zodCode.includes('regex(new RegExp("[0-9]{2}/[0-9]{4}"))')).toBe(true);
    expect(zodCode.includes('regex(new RegExp("^[0-9]{2}/[0-9]{4}$"))')).toBe(true);
    expect(schemaCode.indexOf("^[0-9]{2}/[0-9]{4}$")).toBeGreaterThan(-1);

    const mod = evalModule<{
      validate: (arg: unknown, path?: string) => ValidationError[];
      is: (arg: unknown) => boolean;
    }>(validatorCode);

    expect(mod.is({ date1: "09/2026", date2: "09/2026" })).toBe(true);
    expect(mod.is({ date1: "invalid", date2: "09/2026" })).toBe(false);
    expect(mod.is({ date1: "09/2026", date2: "invalid" })).toBe(false);

    expect(mod.validate({ date1: "invalid", date2: "09/2026" }).length).toBeGreaterThan(0);
    expect(mod.validate({ date1: "09/2026", date2: "invalid" }).length).toBeGreaterThan(0);
  });
});
