import { describe, expect, test } from "bun:test";
// @wiz-ignore
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { extractApiIR } from "../src/extractors/openapi.ts";
import { generate } from "../src/generators/generator.ts";
import { generateJsonCode } from "../src/generators/json.ts";
import { tsClientGenerator } from "../src/generators/tsClient.ts";
import { typeText } from "../src/generators/tsTypes.ts";
import { generateValidatorCode } from "../src/generators/validator.ts";
import { type TypeIR } from "../src/ir/types.ts";
import { silentLogger } from "../src/logger.ts";
import { evalModule } from "./helpers.ts";

describe("array-of-unions regression tests", () => {
    test("OpenAPI 3.0 array with oneOf items emits valid parenthesized union array type", async () => {
        const openapiYaml = `
openapi: 3.0.0
info:
  title: Array Union API
  version: 1.0.0
paths: {}
components:
  schemas:
    EventList:
      type: array
      items:
        oneOf:
          - type: object
            required: [type, text]
            properties:
              type:
                type: string
                enum: [message]
              text:
                type: string
          - type: object
            required: [type, code]
            properties:
              type:
                type: string
                enum: [alert]
              code:
                type: number
`;

        const apiIr = extractApiIR(openapiYaml);
        const files = generate(apiIr, tsClientGenerator, {}, silentLogger);
        const model = files["model.ts"]!;

        expect(model).toContain("export type EventList = Array<{");
        expect(model).toContain('type: "message";');
        expect(model).toContain('type: "alert";');
        expect(model).toContain("}>;");

        // Verify emitted model typechecks under strict TypeScript
        const dir = await mkdtemp(join(tmpdir(), "wiz-array-union-"));
        const modelPath = join(dir, "model.ts");
        await Bun.write(modelPath, model);
        try {
            const program = ts.createProgram([modelPath], {
                strict: true,
                noEmit: true,
                target: ts.ScriptTarget.ESNext,
                module: ts.ModuleKind.ESNext,
                skipLibCheck: true,
                lib: ["lib.esnext.d.ts"],
            });
            const diagnostics = [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()].map((d) =>
                ts.flattenDiagnosticMessageText(d.messageText, " "),
            );
            expect(diagnostics).toEqual([]);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("OpenAPI 3.1 array with anyOf items containing primitive and object variants", () => {
        const openapiYaml = `
openapi: "3.1.0"
info:
  title: AnyOf Array API
  version: 1.0.0
paths: {}
components:
  schemas:
    MixedList:
      type: array
      items:
        anyOf:
          - type: string
          - type: object
            required: [id]
            properties:
              id:
                type: string
`;
        const apiIr = extractApiIR(openapiYaml);
        const files = generate(apiIr, tsClientGenerator, {}, silentLogger);
        const model = files["model.ts"]!;
        expect(model).toContain("export type MixedList = Array<string | {");
        expect(model).toContain("id: string;");
        expect(model).toContain("}>;");
    });

    test("direct TypeIR typeText rendering for nested array of unions", () => {
        const ir: TypeIR = {
            kind: "array",
            id: "1",
            element: {
                kind: "union",
                id: "2",
                types: [
                    { kind: "primitive", id: "3", type: "string" },
                    { kind: "primitive", id: "4", type: "number" },
                ],
            },
        };

        const text = typeText(ir, new Map());
        expect(text).toBe("Array<string | number>");
    });

    test("runtime validation and JSON codec for array-of-unions", () => {
        const ir: TypeIR = {
            kind: "array",
            id: "1",
            name: "UnionArray",
            element: {
                kind: "union",
                id: "2",
                types: [
                    {
                        kind: "object",
                        id: "3",
                        properties: [
                            {
                                name: "kind",
                                type: { kind: "literal", id: "4", value: "a" },
                                optional: false,
                                readonly: false,
                            },
                            {
                                name: "valA",
                                type: { kind: "primitive", id: "5", type: "string" },
                                optional: false,
                                readonly: false,
                            },
                        ],
                    },
                    {
                        kind: "object",
                        id: "6",
                        properties: [
                            {
                                name: "kind",
                                type: { kind: "literal", id: "7", value: "b" },
                                optional: false,
                                readonly: false,
                            },
                            {
                                name: "created",
                                type: { kind: "primitive", id: "8", type: "date" },
                                optional: false,
                                readonly: false,
                            },
                        ],
                    },
                ],
            },
        };

        // Test validator
        const validatorCode = generateValidatorCode(ir);
        const { is, validate } = evalModule<{
            is: (val: unknown) => boolean;
            validate: (val: unknown) => unknown[];
        }>(validatorCode);

        const now = new Date("2026-09-01T12:00:00.000Z");
        const valid = [
            { kind: "a", valA: "hello" },
            { kind: "b", created: now },
        ];

        expect(is(valid)).toBe(true);
        expect(validate(valid)).toEqual([]);

        const invalid = [{ kind: "a", valA: 123 }];
        expect(is(invalid)).toBe(false);

        // Test JSON codec
        const jsonCode = generateJsonCode(ir);
        const { encodeJson, decodeJson } = evalModule<{
            encodeJson: (val: unknown) => string;
            decodeJson: (raw: string) => unknown;
        }>(jsonCode);

        const encoded = encodeJson(valid);
        expect(encoded).toContain('"created":"2026-09-01T12:00:00.000Z"');

        const decoded = decodeJson(encoded) as typeof valid;
        expect(decoded[0]).toEqual({ kind: "a", valA: "hello" });
        expect(decoded[1]!.kind).toBe("b");
        expect((decoded[1]! as any).created).toBeInstanceOf(Date);
    });
});
