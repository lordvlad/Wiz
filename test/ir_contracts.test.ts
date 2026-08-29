// @wiz-ignore
import { describe, expect, test } from "bun:test";
import { generateOpenApiSchemaCode } from "../src/generators/openapi.ts";
import { generateSchemaCode } from "../src/generators/schema.ts";
import {
  computeTypeIRHash,
  normalizeTypeIR,
  walkTypeIR,
  type PropertyIR,
  type TypeIR,
} from "../src/types.ts";
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

/**
 * The registry is content-addressed: every field a generator emits has to reach
 * the key, or two modules that differ collapse onto one entry.
 */
describe("canonical key coverage", () => {
  const property = (over: Partial<PropertyIR> = {}): PropertyIR => ({
    name: "id",
    type: { id: "p_1", kind: "primitive", type: "string" },
    optional: false,
    readonly: false,
    ...over,
  });

  const object = (over: Partial<Extract<TypeIR, { kind: "object" }>> = {}): TypeIR => ({
    id: "o_1",
    kind: "object",
    properties: [property()],
    ...over,
  });

  test("root annotations separate two otherwise equal types", () => {
    const bare = computeTypeIRHash(object());

    expect(computeTypeIRHash(object({ description: "docs" }))).not.toBe(bare);
    expect(
      computeTypeIRHash(object({ deprecated: { isDeprecated: true } }))
    ).not.toBe(bare);
    expect(
      computeTypeIRHash(object({ constraints: [{ kind: "minLength", value: 2 }] }))
    ).not.toBe(bare);
    expect(computeTypeIRHash(object({ examples: [{ id: "x" }] }))).not.toBe(bare);
    expect(computeTypeIRHash(object({ default: { id: "x" } }))).not.toBe(bare);
    expect(computeTypeIRHash(object({ meta: { since: ["1.1"] } }))).not.toBe(bare);
  });

  test("a protobuf field number separates two otherwise equal types", () => {
    expect(
      computeTypeIRHash(object({ properties: [property({ fieldNumber: 1 })] }))
    ).not.toBe(
      computeTypeIRHash(object({ properties: [property({ fieldNumber: 2 })] }))
    );
  });

  test("a discriminator separates two unions with the same members", () => {
    const members: TypeIR[] = [
      {
        id: "u_1",
        kind: "object",
        properties: [
          property({ name: "kind", type: { id: "l_1", kind: "literal", value: "a" } }),
        ],
      },
      {
        id: "u_2",
        kind: "object",
        properties: [
          property({ name: "kind", type: { id: "l_2", kind: "literal", value: "b" } }),
        ],
      },
    ];
    const plain: TypeIR = { id: "n_1", kind: "union", types: members };
    const tagged: TypeIR = {
      ...plain,
      discriminator: { propertyName: "kind" },
    };

    expect(computeTypeIRHash(plain)).not.toBe(computeTypeIRHash(tagged));
  });

  test("names are keyed for payloads that emit them, not for bare modules", () => {
    const user = object({ name: "User" });
    const admin = object({ name: "Admin" });

    // Keys, JSON Schema, validators and codecs are structural, so a bare
    // module is shared.
    expect(computeTypeIRHash(user)).toBe(computeTypeIRHash(admin));
    // A document names its components, so those keys must differ.
    expect(normalizeTypeIR(user, true)).not.toEqual(normalizeTypeIR(admin, true));
  });

  test("a nested name reaches the payload key", () => {
    const wrap = (name: string): TypeIR =>
      object({
        id: "w_1",
        properties: [property({ name: "profile", type: object({ name }) })],
      });

    expect(normalizeTypeIR(wrap("User"), true)).not.toEqual(
      normalizeTypeIR(wrap("Admin"), true)
    );
  });
});
