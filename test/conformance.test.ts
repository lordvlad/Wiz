// @wiz-ignore
import { describe, expect, test } from "bun:test";
import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020.js";
import { generateSchemaCode } from "../src/generators/schema.ts";
import { generateValidatorCode } from "../src/generators/validator.ts";
import conformance from "./fixtures/jsonschema-conformance.json";
import { evalModule, getIRForSource } from "./helpers.ts";

/**
 * Conformance against the official JSON Schema Test Suite.
 *
 * Agreeing with Ajv only shows wiz and Ajv reach the same answer, not that the
 * answer is right. These cases are the specification's own, so they pin the
 * behaviour to the standard rather than to another implementation — and they
 * carry the edge cases a hand-written corpus never thinks of, like a string
 * whose length differs from its character count.
 */

interface Case {
    data: unknown;
    valid: boolean;
    description: string;
}
interface Group {
    value: unknown;
    tests: Case[];
}
const KEYWORDS = conformance.keywords as Record<string, { ts: string; groups: Group[] }>;

/** A one-property type carrying the keyword as its JSDoc annotation. */
function sourceFor(keyword: string, tsType: string, value: unknown): string {
    return `
    export interface M {
      /**
       * @${keyword} ${typeof value === "string" ? value : JSON.stringify(value)}
       */
      v: ${tsType};
    }
  `;
}

const ajv = (() => {
    const instance = new Ajv2020({ strict: false });
    addFormats(instance as never);
    return instance;
})();

describe("JSON Schema Test Suite", () => {
    for (const [keyword, { ts, groups }] of Object.entries(KEYWORDS)) {
        describe(keyword, () => {
            groups.forEach((group, index) => {
                const label = `${keyword} = ${JSON.stringify(group.value)}${
                    groups.length > 1 ? ` (#${index + 1})` : ""
                }`;

                test(`the validator matches the spec for ${label}`, () => {
                    const ir = getIRForSource(sourceFor(keyword, ts, group.value), "M");
                    const validator = evalModule<{ is: (v: unknown) => boolean }>(generateValidatorCode(ir));

                    const wrong = group.tests
                        .filter((c) => validator.is({ v: c.data }) !== c.valid)
                        .map((c) => `${c.description}: ${JSON.stringify(c.data)}`);
                    expect(wrong).toEqual([]);
                });

                test(`the generated schema matches the spec for ${label}`, () => {
                    const ir = getIRForSource(sourceFor(keyword, ts, group.value), "M");
                    const { schema_draft2020 } = evalModule<{ schema_draft2020: object }>(generateSchemaCode(ir));
                    const check = ajv.compile(schema_draft2020);

                    const wrong = group.tests
                        .filter((c) => check({ v: c.data }) !== c.valid)
                        .map((c) => `${c.description}: ${JSON.stringify(c.data)}`);
                    expect(wrong).toEqual([]);
                });
            });
        });
    }
});
