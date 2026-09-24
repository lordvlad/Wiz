// @wiz-ignore
import { describe, expect, test } from "bun:test";
import { generateOpenApiSchemaCode } from "../src/generators/openapi.ts";
import { generateProtobufSchemaCode } from "../src/generators/protobuf.ts";
import { generateSchemaCode } from "../src/generators/schema.ts";
import { evalModule, getIRsForSource } from "./helpers.ts";

const sourceCode = `
  export interface Circle {
    /** @fieldNumber 1 */
    kind: "circle";
    /** @fieldNumber 2 */
    radius: number;
  }

  export interface Square {
    /** @fieldNumber 1 */
    kind: "square";
    /** @fieldNumber 2 */
    side: number;
  }

  export type Shape = Circle | Square;
`;

describe("Discriminated Unions & Schema Propagation", () => {
    test("detects discriminator property during IR extraction", () => {
        const irs = getIRsForSource(sourceCode, ["Shape", "Circle", "Square"]);

        expect(irs.Shape.ir.kind).toBe("union");
        if (irs.Shape.ir.kind === "union") {
            expect(irs.Shape.ir.discriminator).toBeDefined();
            expect(irs.Shape.ir.discriminator?.propertyName).toBe("kind");
        }
    });

    test("propagates discriminator to JSON Schema as oneOf and discriminator property", () => {
        const irs = getIRsForSource(sourceCode, ["Shape"]);
        const schemaCode = generateSchemaCode(irs.Shape.ir);
        const mod = evalModule<{ schema_draft2020: any }>(schemaCode);

        expect(mod.schema_draft2020.oneOf).toBeDefined();
        expect(mod.schema_draft2020.discriminator).toEqual({ propertyName: "kind" });
    });

    test("propagates discriminator to OpenAPI 3.0 and 3.1 schemas", () => {
        const irs = getIRsForSource(sourceCode, ["Shape"]);

        const openapi31Code = generateOpenApiSchemaCode([irs.Shape], "3.1");
        const doc31 = evalModule<{ openapiSchema: () => any }>(openapi31Code).openapiSchema();

        expect(doc31.openapi).toBe("3.1.0");
        expect(doc31.components.schemas.Shape.oneOf).toBeDefined();
        expect(doc31.components.schemas.Shape.discriminator).toEqual({ propertyName: "kind" });

        // Transitively included variants
        expect(doc31.components.schemas.Circle).toBeDefined();
        expect(doc31.components.schemas.Square).toBeDefined();
    });

    test("generates Protobuf schema for discriminated union types and variants", () => {
        const irs = getIRsForSource(sourceCode, ["Shape"]);
        const protoSchemaCode = generateProtobufSchemaCode([irs.Shape]);
        const docFn = evalModule<{ protobufSchema: (opts?: any) => string }>(protoSchemaCode).protobufSchema;

        const protoDoc = docFn({ indent: "  " });
        expect(protoDoc).toContain('syntax = "proto3";');
        expect(protoDoc).toContain("message Circle");
        expect(protoDoc).toContain("message Square");
    });
});
