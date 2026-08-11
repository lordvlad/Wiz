// @wiz-ignore
import { describe, expect, test } from "bun:test";
import { generateKeysCode } from "../src/generators/keys.ts";
import { generateSchemaCode } from "../src/generators/schema.ts";
import { generateValidatorCode } from "../src/generators/validator.ts";
import { generateOpenApiSchemaCode } from "../src/generators/openapi.ts";
import {
  generateProtobufCode,
  generateProtobufSchemaCode,
} from "../src/generators/protobuf.ts";
import { evalModule, getIRsForSource } from "./helpers.ts";

const sourceCode = `
  export interface User {
    /** @fieldNumber 1 */
    id: number;
    /** @fieldNumber 2 */
    name: string;
  }

  export interface Permissions {
    /** @fieldNumber 3 */
    roles: string[];
  }

  export type NamedUnion = "active" | "inactive" | "pending";

  export type AnonUnion =
    | { kind: "user"; name: string }
    | { kind: "bot"; botId: number };

  export type DisparateUnion = string | User;

  export type NamedInter = User & Permissions;

  export type AnonInter = { id: string } & { count: number };
`;

describe("Unions & Intersections Coverage", () => {
  test("Key extraction for unions and intersections", () => {
    const irs = getIRsForSource(sourceCode, [
      "NamedUnion",
      "AnonUnion",
      "DisparateUnion",
      "NamedInter",
      "AnonInter",
    ]);

    // Disparate / Named unions have no shared keys
    const dispKeys = evalModule<{ keys: string[] }>(generateKeysCode(irs.DisparateUnion.ir));
    expect(dispKeys.keys).toEqual([]);

    // Intersections merge keys
    const namedInterKeys = evalModule<{ keys: string[]; requiredKeys: string[] }>(
      generateKeysCode(irs.NamedInter.ir)
    );
    expect(namedInterKeys.keys).toEqual(["id", "name", "roles"]);
    expect(namedInterKeys.requiredKeys).toEqual(["id", "name", "roles"]);

    const anonInterKeys = evalModule<{ keys: string[] }>(
      generateKeysCode(irs.AnonInter.ir)
    );
    expect(anonInterKeys.keys).toEqual(["id", "count"]);
  });

  test("JSON Schema generation for unions and intersections", () => {
    const irs = getIRsForSource(sourceCode, [
      "NamedUnion",
      "AnonUnion",
      "DisparateUnion",
      "NamedInter",
      "AnonInter",
    ]);

    // Named literal union -> enum
    const namedUnionSchema = evalModule<{ schema_draft2020: any }>(
      generateSchemaCode(irs.NamedUnion.ir)
    );
    expect(namedUnionSchema.schema_draft2020.enum).toEqual([
      "active",
      "inactive",
      "pending",
    ]);

    // Disparate union -> anyOf
    const dispSchema = evalModule<{ schema_draft2020: any }>(
      generateSchemaCode(irs.DisparateUnion.ir)
    );
    expect(dispSchema.schema_draft2020.anyOf).toBeDefined();
    expect(dispSchema.schema_draft2020.anyOf.length).toBe(2);

    // Intersections -> allOf
    const interSchema = evalModule<{ schema_draft2020: any }>(
      generateSchemaCode(irs.NamedInter.ir)
    );
    expect(interSchema.schema_draft2020.allOf).toBeDefined();
  });

  test("Validator generation for unions and intersections", () => {
    const irs = getIRsForSource(sourceCode, [
      "NamedUnion",
      "AnonUnion",
      "DisparateUnion",
      "NamedInter",
    ]);

    // Disparate union validator
    const dispVal = evalModule<{
      is: (arg: unknown) => boolean;
      validate: (arg: unknown) => any[];
    }>(generateValidatorCode(irs.DisparateUnion.ir));

    // String matches disparate union
    expect(dispVal.is("hello")).toBe(true);
    // User object matches disparate union
    expect(dispVal.is({ id: 1, name: "Alice" })).toBe(true);
    // Invalid type (boolean) fails disparate union
    expect(dispVal.is(true)).toBe(false);
    expect(dispVal.validate(true).length).toBeGreaterThan(0);

    // Named intersection validator
    const interVal = evalModule<{
      is: (arg: unknown) => boolean;
      validate: (arg: unknown) => any[];
    }>(generateValidatorCode(irs.NamedInter.ir));

    expect(interVal.is({ id: 1, name: "Alice", roles: ["admin"] })).toBe(true);
    expect(interVal.is({ id: 1, name: "Alice" })).toBe(false); // missing roles
  });

  test("OpenAPI 3.0 and 3.1 schema generation for unions and intersections", () => {
    const irs = getIRsForSource(sourceCode, [
      "DisparateUnion",
      "NamedInter",
      "User",
    ]);

    // OpenAPI 3.1
    const openapi31Code = generateOpenApiSchemaCode([irs.DisparateUnion], "3.1");
    const openapi31 = evalModule<{ openapiSchema: (base?: any) => any }>(openapi31Code).openapiSchema();

    expect(openapi31.openapi).toBe("3.1.0");
    expect(openapi31.components.schemas.DisparateUnion.anyOf).toBeDefined();
    expect(openapi31.components.schemas.User).toBeDefined(); // Transitively discovered

    // OpenAPI 3.0
    const openapi30Code = generateOpenApiSchemaCode([irs.NamedInter], "3.0");
    const openapi30 = evalModule<{ openapiSchema: (base?: any) => any }>(openapi30Code).openapiSchema();

    expect(openapi30.openapi).toBe("3.0.3");
    expect(openapi30.components.schemas.NamedInter.allOf).toBeDefined();
  });

  test("Protobuf encoding/decoding for intersections", () => {
    const irs = getIRsForSource(sourceCode, ["NamedInter"]);

    const protoCode = generateProtobufCode(irs.NamedInter.ir);
    const mod = evalModule<{
      encodeProto: (val: any, buf: Uint8Array) => number;
      decodeProto: (buf: Uint8Array) => any;
    }>(protoCode);

    const adminUser = {
      id: 1,
      name: "Alice",
      roles: ["admin", "super"],
    };

    const buf = new Uint8Array(1024);
    const bytes = mod.encodeProto(adminUser, buf);
    expect(bytes).toBeGreaterThan(0);

    const decoded = mod.decodeProto(buf.subarray(0, bytes));
    expect(decoded).toEqual(adminUser);
  });
});
