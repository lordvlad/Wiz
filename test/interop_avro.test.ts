// @wiz-ignore
import { describe, expect, test } from "bun:test";
import avro from "avsc";
import { generateAvroCode, generateAvroSchemaCode } from "../src/generators/avro.ts";
import { evalModule, getIRForSource } from "./helpers.ts";

/**
 * Interop against avsc.
 *
 * Avro is schema-driven with no tags on the wire, so a decoder has nothing to
 * resynchronise against: a field written one byte wide but read another
 * silently shifts everything after it. Round-tripping wiz against itself
 * cannot see that. avsc can.
 */

interface Codec {
    encodeAvro: (val: unknown, buf: Uint8Array, offset?: number) => number;
    decodeAvro: (buf: Uint8Array, offset?: number) => any;
}

/**
 * avsc reads `long` into a JS number and refuses anything past 2^53, which is
 * the range int64 exists to carry. This reads them as BigInt instead, so the
 * 64-bit path is genuinely compared rather than skipped.
 */
const bigintLong = avro.types.LongType.__with({
    fromBuffer: (buf: Buffer) => buf.readBigInt64LE(),
    toBuffer: (n: bigint) => {
        const buf = Buffer.alloc(8);
        buf.writeBigInt64LE(n);
        return buf;
    },
    fromJSON: BigInt,
    toJSON: Number,
    isValid: (n: unknown) => typeof n === "bigint",
    compare: (a: bigint, b: bigint) => (a === b ? 0 : a < b ? -1 : 1),
});

/** wiz's codec, its `.avsc` text, and avsc's view of that schema. */
function pair(source: string, root = "M") {
    const ir = getIRForSource(source, root);
    const codec = evalModule<Codec>(generateAvroCode(ir));
    const schemaText = evalModule<{ avroSchema: (o?: any) => string }>(
        generateAvroSchemaCode([{ name: root, ir }]),
    ).avroSchema();

    // Parsing is itself an assertion: avsc rejects a malformed schema.
    const type = avro.Type.forSchema(JSON.parse(schemaText), {
        registry: { long: bigintLong } as never,
    });
    return { codec, schema: JSON.parse(schemaText), type };
}

const wizEncode = (codec: Codec, value: unknown) => {
    const buf = new Uint8Array(4096);
    return buf.subarray(0, codec.encodeAvro(value, buf));
};

describe("avsc reads what wiz writes", () => {
    test("primitives, at the widths @format selects", () => {
        const { codec, type } = pair(`
      export interface M {
        text: string;
        /** @format int32 */
        count: number;
        ratio: number;
        /** @format float */
        approx: number;
        flag: boolean;
        /** @format int64 */
        big: bigint;
      }
    `);

        const value = { text: "hi", count: -7, ratio: 3.14, approx: 0.5, flag: true, big: 42n };
        const decoded = type.fromBuffer(Buffer.from(wizEncode(codec, value)));
        expect(decoded).toEqual(value);
    });

    test("negative and large integers", () => {
        const { codec, type } = pair(`
      export interface M {
        /** @format int32 */
        small: number;
        /** @format int64 */
        big: bigint;
      }
    `);

        for (const [small, big] of [
            [0, 0n],
            [-1, -1n],
            [2147483647, 9007199254740993n],
            [-2147483648, -9007199254740993n],
        ] as const) {
            const decoded = type.fromBuffer(Buffer.from(wizEncode(codec, { small, big })));
            expect(decoded.small).toBe(small);
            expect(String(decoded.big)).toBe(String(big));
        }
    });

    test("optional fields, which Avro spells as a null union", () => {
        const { codec, type } = pair(`
      export interface M {
        required: string;
        optional?: string;
        /** @format int32 */
        count?: number;
      }
    `);

        expect(type.fromBuffer(Buffer.from(wizEncode(codec, { required: "a", optional: "b", count: 1 })))).toEqual({
            required: "a",
            optional: "b",
            count: 1,
        });

        expect(type.fromBuffer(Buffer.from(wizEncode(codec, { required: "a" })))).toEqual({
            required: "a",
            optional: null,
            count: null,
        });
    });

    test("nested records", () => {
        const { codec, type } = pair(`
      export interface Inner {
        a: string;
        /** @format int32 */
        b: number;
      }
      export interface M {
        inner: Inner;
      }
    `);

        const value = { inner: { a: "hi", b: 3 } };
        expect(type.fromBuffer(Buffer.from(wizEncode(codec, value)))).toEqual(value);
    });

    test("arrays, including of records", () => {
        const { codec, type } = pair(`
      export interface Inner {
        a: string;
      }
      export interface M {
        /** @format int32 */
        nums: number[];
        items: Inner[];
        empty: string[];
      }
    `);

        const value = { nums: [1, 2, 300], items: [{ a: "x" }, { a: "y" }], empty: [] };
        expect(type.fromBuffer(Buffer.from(wizEncode(codec, value)))).toEqual(value);
    });

    test("maps", () => {
        const { codec, type } = pair(`
      export interface M {
        /** @format int32 */
        counts: Record<string, number>;
      }
    `);

        const value = { counts: { a: 1, b: 22 } };
        expect(type.fromBuffer(Buffer.from(wizEncode(codec, value)))).toEqual(value);
    });

    test("enums travel by symbol, not by name", () => {
        const { codec, type } = pair(`
      export enum Role {
        User = "user",
        Admin = "admin",
      }
      export interface M {
        role: Role;
      }
    `);

        const decoded = type.fromBuffer(Buffer.from(wizEncode(codec, { role: "admin" })));
        expect(decoded.role).toBe("admin");
    });

    test("bytes and instants", () => {
        const { codec, type } = pair(`
      export interface M {
        blob: Uint8Array;
        at: Date;
      }
    `);

        const at = new Date("2024-03-01T12:00:00.000Z");
        const decoded = type.fromBuffer(Buffer.from(wizEncode(codec, { blob: new Uint8Array([1, 2, 250]), at })));
        expect([...decoded.blob]).toEqual([1, 2, 250]);
        // Without a logical-type registry avsc hands back the underlying long.
        expect(Number(decoded.at)).toBe(at.getTime());
    });

    test("multi-byte text is measured in bytes, not code points", () => {
        const { codec, type } = pair(`
      export interface M {
        text: string;
      }
    `);

        const value = { text: "héllo — 日本語 🎉" };
        expect(type.fromBuffer(Buffer.from(wizEncode(codec, value)))).toEqual(value);
    });
});

describe("wiz reads what avsc writes", () => {
    const roundtrip = (source: string, value: Record<string, unknown>) => {
        const { codec, type } = pair(source);
        return codec.decodeAvro(new Uint8Array(type.toBuffer(value)));
    };

    test("primitives", () => {
        const decoded = roundtrip(
            `export interface M {
        text: string;
        /** @format int32 */
        count: number;
        ratio: number;
        /** @format float */
        approx: number;
        flag: boolean;
      }`,
            { text: "hi", count: -7, ratio: 3.14, approx: 0.5, flag: true },
        );
        expect(decoded).toEqual({ text: "hi", count: -7, ratio: 3.14, approx: 0.5, flag: true });
    });

    test("a present and an absent optional", () => {
        const source = `export interface M {
      required: string;
      optional?: string;
    }`;
        expect(roundtrip(source, { required: "a", optional: "b" })).toEqual({
            required: "a",
            optional: "b",
        });
        expect(roundtrip(source, { required: "a", optional: null })).toMatchObject({
            required: "a",
        });
    });

    test("nested records and arrays", () => {
        const decoded = roundtrip(
            `export interface Inner {
        a: string;
      }
      export interface M {
        inner: Inner;
        items: Inner[];
      }`,
            { inner: { a: "x" }, items: [{ a: "y" }, { a: "z" }] },
        );
        expect(decoded).toEqual({ inner: { a: "x" }, items: [{ a: "y" }, { a: "z" }] });
    });

    test("maps", () => {
        const decoded = roundtrip(
            `export interface M {
        /** @format int32 */
        counts: Record<string, number>;
      }`,
            { counts: { a: 1, b: 22 } },
        );
        expect(decoded).toEqual({ counts: { a: 1, b: 22 } });
    });

    test("a long array, which avsc may write as several blocks", () => {
        const nums = Array.from({ length: 500 }, (_, i) => i - 250);
        const decoded = roundtrip(
            `export interface M {
        /** @format int32 */
        nums: number[];
      }`,
            { nums },
        );
        expect(decoded.nums).toEqual(nums);
    });

    test("enums", () => {
        const decoded = roundtrip(
            `export enum Role {
        User = "user",
        Admin = "admin",
      }
      export interface M {
        role: Role;
      }`,
            { role: "admin" },
        );
        expect(decoded.role).toBe("admin");
    });

    test("bytes", () => {
        const decoded = roundtrip(
            `export interface M {
        blob: Uint8Array;
      }`,
            { blob: Buffer.from([1, 2, 250]) },
        );
        expect([...decoded.blob]).toEqual([1, 2, 250]);
    });
});

describe("named types repeated and recursive", () => {
    test("a type used twice is defined once and referenced by name", () => {
        const { schema, type } = pair(`
      export interface Inner {
        a: string;
      }
      export interface M {
        first: Inner;
        second: Inner;
        list: Inner[];
      }
    `);

        const fields = Object.fromEntries(
            (schema.fields as Array<{ name: string; type: unknown }>).map((f) => [f.name, f.type]),
        );
        expect((fields.first as { type: string }).type).toBe("record");
        // Avro defines a name once; later uses are the bare name.
        expect(fields.second).toBe("Inner");
        expect(fields.list).toEqual({ type: "array", items: "Inner" });

        expect(type.name).toBe("M");
    });

    test("a recursive type still generates, rather than looping forever", () => {
        // `ref` is the extractor's cycle-breaker; following it unguarded would
        // recurse in the generator instead of on the wire.
        const { schema } = pair(`
      export interface Node {
        label: string;
        children: Node[];
      }
      export interface M {
        root: Node;
      }
    `);

        const root = (schema.fields as Array<{ name: string; type: any }>).find((f) => f.name === "root")!;
        expect(root.type.name).toBe("Node");
        expect(root.type.fields.find((f: any) => f.name === "children").type).toEqual({
            type: "array",
            items: "Node",
        });
    });
});
