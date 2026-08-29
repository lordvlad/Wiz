// @wiz-ignore
import { describe, expect, test } from "bun:test";
import { computeTypeIRHash, normalizeTypeIR } from "../src/types.ts";
import { getIRForSource, getIRsForSource } from "./helpers.ts";

describe("TypeIR Extractor & Normalization", () => {
  test("extracts object properties with JSDoc constraints and documentation", () => {
    const code = `
      export interface User {
        /** Unique identifier */
        id: string;

        /**
         * Full display name
         * @minLength 2
         * @maxLength 50
         */
        name: string;

        /**
         * @minimum 0
         * @maximum 120
         */
        age?: number;

        /**
         * @format email
         */
        email: string;

        /**
         * @deprecated Use email instead
         */
        oldEmail?: string;
      }
    `;

    const ir = getIRForSource(code, "User");
    expect(ir.kind).toBe("object");

    if (ir.kind === "object") {
      expect(ir.properties.length).toBe(5);

      const idProp = ir.properties.find((p) => p.name === "id")!;
      expect(idProp.description).toBe("Unique identifier");
      expect(idProp.optional).toBe(false);

      const nameProp = ir.properties.find((p) => p.name === "name")!;
      expect(nameProp.description).toBe("Full display name");
      expect(nameProp.constraints).toEqual([
        { kind: "minLength", value: 2 },
        { kind: "maxLength", value: 50 },
      ]);

      const ageProp = ir.properties.find((p) => p.name === "age")!;
      expect(ageProp.optional).toBe(true);
      expect(ageProp.constraints).toEqual([
        { kind: "minimum", value: 0 },
        { kind: "maximum", value: 120 },
      ]);

      const emailProp = ir.properties.find((p) => p.name === "email")!;
      expect(emailProp.constraints).toEqual([{ kind: "format", value: "email" }]);

      const oldEmailProp = ir.properties.find((p) => p.name === "oldEmail")!;
      expect(oldEmailProp.deprecated).toEqual({
        isDeprecated: true,
        note: "Use email instead",
      });
    }
  });

  test("extracts Enums, Tuples, Intersections, Records, Literals, and Recursive Refs", () => {
    const code = `
      export enum Status {
        Active = 1,
        Pending = "pending"
      }

      export type MyTuple = [string, number?];

      export type MyRecord = Record<string, number>;

      export type LiteralObj = {
        boolLit: true;
        numLit: 42;
        bigLit: 100n;
        nullLit: null;
      };

      export interface Node {
        val: string;
        next?: Node;
      }
    `;

    const irs = getIRsForSource(code, ["Status", "MyTuple", "MyRecord", "LiteralObj", "Node"]);

    // Enum
    expect(irs.Status.ir.kind).toBe("enum");
    if (irs.Status.ir.kind === "enum") {
      expect(irs.Status.ir.members).toEqual([
        { name: "Active", value: 1 },
        { name: "Pending", value: "pending" },
      ]);
    }

    // Tuple
    expect(irs.MyTuple.ir.kind).toBe("tuple");
    if (irs.MyTuple.ir.kind === "tuple") {
      expect(irs.MyTuple.ir.elements.length).toBe(2);
      expect(irs.MyTuple.ir.elements[0]!.optional).toBe(false);
      expect(irs.MyTuple.ir.elements[1]!.optional).toBe(true);
    }

    // Record
    expect(irs.MyRecord.ir.kind).toBe("record");
    if (irs.MyRecord.ir.kind === "record") {
      expect(irs.MyRecord.ir.keyType.kind).toBe("primitive");
      expect(irs.MyRecord.ir.valueType.kind).toBe("primitive");
    }

    // Literals
    expect(irs.LiteralObj.ir.kind).toBe("object");
    if (irs.LiteralObj.ir.kind === "object") {
      const boolProp = irs.LiteralObj.ir.properties.find((p) => p.name === "boolLit")!;
      expect(boolProp.type.kind).toBe("literal");
      if (boolProp.type.kind === "literal") {
        expect(boolProp.type.value).toBe(true);
      }
    }

    // Recursive Ref
    expect(irs.Node.ir.kind).toBe("object");
    if (irs.Node.ir.kind === "object") {
      const nextProp = irs.Node.ir.properties.find((p) => p.name === "next")!;
      expect(nextProp.optional).toBe(true);
      expect(nextProp.type.kind).toBe("union");
    }
  });

  test("computes deterministic hash for structurally equivalent type signatures", () => {
    const code1 = `export interface Product { id: string; price: number; }`;
    const code2 = `export interface Item { price: number; id: string; }`;

    const ir1 = getIRForSource(code1, "Product");
    const ir2 = getIRForSource(code2, "Item");

    const hash1 = computeTypeIRHash(ir1);
    const hash2 = computeTypeIRHash(ir2);

    expect(hash1).toBe(hash2);
    expect(normalizeTypeIR(ir1)).toEqual(normalizeTypeIR(ir2));
  });

  test("a recursive type hashes the same however much was extracted before it", () => {
    const recursive = `export interface Node { value: string; next?: Node }`;

    const before = computeTypeIRHash(getIRForSource(recursive, "Node"));
    // Unrelated extractions in between: node ids belong to one extraction, so
    // the `ref` a recursive type carries must not depend on them.
    getIRForSource(`export interface Filler { a: string; b: string }`, "Filler");
    const after = computeTypeIRHash(getIRForSource(recursive, "Node"));

    expect(after).toBe(before);
  });
});
