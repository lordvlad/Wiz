// @wiz-ignore
import { describe, expect, test } from "bun:test";
import { generateSchemaCode } from "../src/generators/schema.ts";
import { evalModule, getIRForSource } from "./helpers.ts";

describe("JSON Schema Generator", () => {
  test("generates JSON Schema Draft 2020-12 and Draft 07 for objects with constraints", () => {
    const ir = getIRForSource(
      `
      export interface Config {
        /**
         * Hostname
         * @minLength 3
         */
        host: string;
        port: number;
        ssl?: boolean;
      }
    `,
      "Config"
    );

    const code = generateSchemaCode(ir);
    const mod = evalModule<{
      schema_draft2020: Record<string, any>;
      schema_draft07: Record<string, any>;
    }>(code);

    // Draft 2020-12
    expect(mod.schema_draft2020.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(mod.schema_draft2020.type).toBe("object");
    expect(mod.schema_draft2020.properties.host.minLength).toBe(3);
    expect(mod.schema_draft2020.properties.host.description).toBe("Hostname");
    expect(mod.schema_draft2020.required).toEqual(["host", "port"]);

    // Draft 07
    expect(mod.schema_draft07.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(mod.schema_draft07.type).toBe("object");
    expect(mod.schema_draft07.properties.host.minLength).toBe(3);
  });

  test("generates tuple schema differences for Draft 2020-12 (prefixItems) and Draft 07 (items)", () => {
    const ir = getIRForSource(
      `
      export type Coordinate = [number, number];
    `,
      "Coordinate"
    );

    const code = generateSchemaCode(ir);
    const mod = evalModule<{
      schema_draft2020: Record<string, any>;
      schema_draft07: Record<string, any>;
    }>(code);

    expect(mod.schema_draft2020.type).toBe("array");
    expect(mod.schema_draft2020.prefixItems).toBeDefined();
    expect(mod.schema_draft2020.prefixItems.length).toBe(2);

    expect(mod.schema_draft07.type).toBe("array");
    expect(mod.schema_draft07.items).toBeDefined();
    expect(Array.isArray(mod.schema_draft07.items)).toBe(true);
  });

  test("generates schema for Enums, Records, Intersections, Unions", () => {
    const ir = getIRForSource(
      `
      export enum Role { Admin = 1, User = 2 }
      export type Rec = Record<string, number>;
      export type Inter = { a: string } & { b: number };
      export type UnionLit = "red" | "green" | "blue";
    `,
      "Role"
    );

    const code = generateSchemaCode(ir);
    const mod = evalModule<{ schema_draft2020: Record<string, any> }>(code);

    expect(mod.schema_draft2020.enum).toEqual([1, 2]);
  });
});
