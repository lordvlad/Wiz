// @wiz-ignore
import { describe, expect, test } from "bun:test";
import { generateAvroCode, generateAvroSchemaCode } from "../src/generators/avro.ts";
import { evalModule, getIRForSource } from "./helpers.ts";

interface AvroModule {
  encodeAvro: (val: unknown, buf: Uint8Array, offset?: number) => number;
  decodeAvro: (buf: Uint8Array, offset?: number) => any;
}

function codecFor(source: string, typeName: string): AvroModule {
  return evalModule<AvroModule>(generateAvroCode(getIRForSource(source, typeName)));
}

function schemaFor(source: string, typeName: string): any {
  const ir = getIRForSource(source, typeName);
  const mod = evalModule<{ avroSchema: (o?: any) => string }>(
    generateAvroSchemaCode([{ name: typeName, ir }])
  );
  return JSON.parse(mod.avroSchema());
}

function roundtrip(mod: AvroModule, value: unknown, size = 1024) {
  const buf = new Uint8Array(size);
  const written = mod.encodeAvro(value, buf);
  return { value: mod.decodeAvro(buf.subarray(0, written)), written };
}

const userSource = `
  export interface User {
    id: number;
    name: string;
    active: boolean;
    nickname?: string;
  }
`;

describe("avro schema", () => {
  test("records carry name, fields in declaration order, and docs", () => {
    const schema = schemaFor(
      `
      /** A person */
      export interface User {
        /** Their id */
        id: number;
        name: string;
      }
    `,
      "User"
    );

    expect(schema).toEqual({
      type: "record",
      name: "User",
      doc: "A person",
      fields: [
        { name: "id", type: "double", doc: "Their id" },
        { name: "name", type: "string" },
      ],
    });
  });

  test("a JS number defaults to double, since that is what it is", () => {
    const schema = schemaFor(`export interface N { v: number }`, "N");
    expect(schema.fields[0].type).toBe("double");
  });

  test("@format selects the numeric width, reusing the OpenAPI registry", () => {
    const schema = schemaFor(
      `
      export interface Widths {
        /** @format int32 */
        small: number;
        /** @format int64 */
        big: number;
        /** @format float */
        approx: number;
        /** @format double */
        exact: number;
        plain: bigint;
      }
    `,
      "Widths"
    );

    expect(schema.fields.map((f: any) => [f.name, f.type])).toEqual([
      ["small", "int"],
      ["big", "long"],
      ["approx", "float"],
      ["exact", "double"],
      ["plain", "long"],
    ]);
  });

  test("optional properties become a null union with a null default", () => {
    const schema = schemaFor(userSource, "User");
    const nickname = schema.fields.find((f: any) => f.name === "nickname");
    expect(nickname.type).toEqual(["null", "string"]);
    expect(nickname.default).toBe(null);
  });

  test("arrays, maps and enums map to their avro complex types", () => {
    const schema = schemaFor(
      `
      export enum Role { Admin = "admin", User = "user" }
      export interface Shapes {
        tags: string[];
        lookup: Record<string, number>;
        role: Role;
      }
    `,
      "Shapes"
    );

    const byName = Object.fromEntries(
      schema.fields.map((f: any) => [f.name, f.type])
    );
    expect(byName.tags).toEqual({ type: "array", items: "string" });
    expect(byName.lookup).toEqual({ type: "map", values: "double" });
    expect(byName.role).toEqual({
      type: "enum",
      name: "Role",
      symbols: ["Admin", "User"],
    });
  });

  test("several root types form a union, as a single .avsc must", () => {
    const src = `
      export interface A { a: string }
      export interface B { b: string }
    `;
    const mod = evalModule<{ avroSchema: (o?: any) => string }>(
      generateAvroSchemaCode([
        { name: "A", ir: getIRForSource(src, "A") },
        { name: "B", ir: getIRForSource(src, "B") },
      ])
    );
    const parsed = JSON.parse(mod.avroSchema());
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.map((s: any) => s.name)).toEqual(["A", "B"]);
  });

  test("indent is honoured, and the result parses as JSON", () => {
    const ir = getIRForSource(userSource, "User");
    const mod = evalModule<{ avroSchema: (o?: any) => string }>(
      generateAvroSchemaCode([{ name: "User", ir }])
    );
    const text = mod.avroSchema({ indent: "    " });
    expect(text).toContain('\n    "type": "record"');
    expect(() => JSON.parse(text)).not.toThrow();
  });
});

describe("avro binary codec", () => {
  test("round-trips a record", () => {
    const mod = codecFor(userSource, "User");
    const user = { id: 42, name: "Alice", active: true, nickname: "al" };
    expect(roundtrip(mod, user).value).toEqual(user);
  });

  test("absent optionals decode as null via the union branch", () => {
    const mod = codecFor(userSource, "User");
    const { value } = roundtrip(mod, { id: 1, name: "Bob", active: false });
    expect(value).toEqual({ id: 1, name: "Bob", active: false, nickname: null });
  });

  test("encodes zig-zag varints exactly as the spec describes", () => {
    const mod = codecFor(`export interface I { v: bigint }`, "I");
    const bytes = (v: bigint) => {
      const buf = new Uint8Array(16);
      const n = mod.encodeAvro({ v }, buf);
      return [...buf.subarray(0, n)];
    };
    // Reference values from the Avro spec: 0->0, -1->1, 1->2, -2->3, 2->4.
    expect(bytes(0n)).toEqual([0x00]);
    expect(bytes(-1n)).toEqual([0x01]);
    expect(bytes(1n)).toEqual([0x02]);
    expect(bytes(-2n)).toEqual([0x03]);
    expect(bytes(2n)).toEqual([0x04]);
    // 64 zig-zags to 128, which is the first two-byte varint.
    expect(bytes(64n)).toEqual([0x80, 0x01]);
  });

  test("strings are a length prefix followed by UTF-8", () => {
    const mod = codecFor(`export interface S { v: string }`, "S");
    const buf = new Uint8Array(32);
    const n = mod.encodeAvro({ v: "foo" }, buf);
    // zig-zag(3) === 6, then the three bytes of "foo".
    expect([...buf.subarray(0, n)]).toEqual([0x06, 0x66, 0x6f, 0x6f]);
    expect(mod.decodeAvro(buf.subarray(0, n))).toEqual({ v: "foo" });
  });

  test("round-trips multi-byte UTF-8 by byte length, not code points", () => {
    const mod = codecFor(`export interface S { v: string }`, "S");
    const value = { v: "héllo — 世界 🌍" };
    expect(roundtrip(mod, value).value).toEqual(value);
  });

  test("long keeps full 64-bit precision", () => {
    const mod = codecFor(`export interface L { v: bigint }`, "L");
    for (const v of [
      9007199254740993n,
      -9007199254740993n,
      9223372036854775807n,
      -9223372036854775808n,
    ]) {
      expect(roundtrip(mod, { v }).value.v).toBe(v);
    }
  });

  test("@format int64 on a number decodes back to a number", () => {
    const mod = codecFor(
      `export interface L {
        /** @format int64 */
        v: number
      }`,
      "L"
    );
    const { value } = roundtrip(mod, { v: 123456789 });
    expect(value.v).toBe(123456789);
    expect(typeof value.v).toBe("number");
  });

  test("float is 4 bytes and double is 8", () => {
    const f = codecFor(
      `export interface F {
        /** @format float */
        v: number
      }`,
      "F"
    );
    const d = codecFor(`export interface D { v: number }`, "D");
    const buf = new Uint8Array(16);
    expect(f.encodeAvro({ v: 1.5 }, buf)).toBe(4);
    expect(d.encodeAvro({ v: 1.5 }, buf)).toBe(8);
    expect(roundtrip(f, { v: 1.5 }).value.v).toBe(1.5);
    expect(roundtrip(d, { v: 0.1 }).value.v).toBe(0.1);
  });

  test("round-trips arrays, including empty ones", () => {
    const mod = codecFor(`export interface A { tags: string[] }`, "A");
    expect(roundtrip(mod, { tags: ["a", "b", "c"] }).value).toEqual({
      tags: ["a", "b", "c"],
    });
    expect(roundtrip(mod, { tags: [] }).value).toEqual({ tags: [] });
  });

  test("round-trips maps", () => {
    const mod = codecFor(
      `export interface M { lookup: Record<string, number> }`,
      "M"
    );
    const value = { lookup: { a: 1, b: 2 } };
    expect(roundtrip(mod, value).value).toEqual(value);
  });

  test("round-trips nested records and arrays of records", () => {
    const mod = codecFor(
      `
      export interface Item { sku: string; qty: number }
      export interface Order { id: string; items: Item[]; billing: Item }
    `,
      "Order"
    );
    const value = {
      id: "o1",
      items: [
        { sku: "a", qty: 1 },
        { sku: "b", qty: 2 },
      ],
      billing: { sku: "c", qty: 3 },
    };
    expect(roundtrip(mod, value).value).toEqual(value);
  });

  test("round-trips enums by symbol index", () => {
    const mod = codecFor(
      `
      export enum Role { Admin = "admin", User = "user" }
      export interface P { role: Role }
    `,
      "P"
    );
    const buf = new Uint8Array(16);
    const n = mod.encodeAvro({ role: "user" }, buf);
    // Index 1, zig-zagged to 2, in a single byte.
    expect([...buf.subarray(0, n)]).toEqual([0x02]);
    expect(mod.decodeAvro(buf.subarray(0, n))).toEqual({ role: "user" });
  });

  test("writes nothing but the payload: no field tags on the wire", () => {
    // Avro is schema-driven, so unlike protobuf there are no per-field tags.
    const mod = codecFor(`export interface B { flag: boolean }`, "B");
    const buf = new Uint8Array(8);
    expect(mod.encodeAvro({ flag: true }, buf)).toBe(1);
    expect([...buf.subarray(0, 1)]).toEqual([0x01]);
  });

  test("honours a non-zero offset", () => {
    const mod = codecFor(`export interface S { v: string }`, "S");
    const buf = new Uint8Array(32);
    buf[0] = 0xff;
    const written = mod.encodeAvro({ v: "hi" }, buf, 1);
    expect(mod.decodeAvro(buf.subarray(1, 1 + written))).toEqual({ v: "hi" });
    expect(buf[0]).toBe(0xff);
  });
});
