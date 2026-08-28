// @wiz-ignore
import { describe, expect, test } from "bun:test";
import { generateOpenApiSchemaCode } from "../src/generators/openapi.ts";
import { generateSchemaCode } from "../src/generators/schema.ts";
import { walkTypeIR, type TypeIR } from "../src/types.ts";
import { evalModule } from "./helpers.ts";

describe("TypeIR graph contracts", () => {
  test("walks distinct graphs even when ids are reused", () => {
    const first: TypeIR = { id: "o_1", kind: "object", properties: [], name: "First" };
    const second: TypeIR = { id: "o_1", kind: "object", properties: [], name: "Second" };
    const seen: string[] = [];
    const visited = new Set<TypeIR>();
    walkTypeIR(first, (node) => seen.push(node.name ?? ""), visited);
    walkTypeIR(second, (node) => seen.push(node.name ?? ""), visited);
    expect(seen).toEqual(["First", "Second"]);
  });

  test("OpenAPI consumes readonly property metadata", () => {
    const ir: TypeIR = {
      id: "o_1",
      kind: "object",
      properties: [{ name: "id", type: { id: "p_1", kind: "primitive", type: "string" }, optional: false, readonly: true }],
    };
    const doc = evalModule<{ openapiSchema: () => any }>(
      generateOpenApiSchemaCode([{ name: "Model", ir }], "3.1")
    ).openapiSchema();
    expect(doc.components.schemas.Model.properties.id.readOnly).toBe(true);
  });

  test("JSON Schema preserves the required prefix of an optional tuple", () => {
    const ir: TypeIR = {
      id: "t_1",
      kind: "tuple",
      elements: [
        { type: { id: "p_1", kind: "primitive", type: "string" }, optional: false },
        { type: { id: "p_2", kind: "primitive", type: "number" }, optional: true },
      ],
    };
    const schema = evalModule<{ schema_draft2020: any }>(generateSchemaCode(ir)).schema_draft2020;
    expect(schema.minItems).toBe(1);
  });
});
