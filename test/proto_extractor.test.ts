// @wiz-ignore
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import protobuf from "protobufjs";
import { extractProtoIR, extractProtoIRFromFile } from "../src/extractors/proto.ts";
import { generateProtobufCodecCode } from "../src/generators/protobuf.ts";
import { isGrpcMethod } from "../src/ir/service.ts";
import type { TypeIR } from "../src/types.ts";

/** The scalar table, checked against protobufjs's own reading of the same file. */
const SCALARS = `
syntax = "proto3";
package widths;

message Every {
  double d = 1;
  float f = 2;
  int32 i32 = 3;
  int64 i64 = 4;
  uint32 u32 = 5;
  uint64 u64 = 6;
  sint32 s32 = 7;
  sint64 s64 = 8;
  fixed32 fx32 = 9;
  fixed64 fx64 = 10;
  sfixed32 sfx32 = 11;
  sfixed64 sfx64 = 12;
  bool flag = 13;
  string text = 14;
  bytes blob = 15;
}
`;

const propertyOf = (ir: TypeIR | undefined, name: string) => {
    if (ir?.kind !== "object") {
        throw new Error("expected an object type");
    }
    const property = ir.properties.find((candidate) => candidate.name === name);
    if (!property) {
        throw new Error(`no property '${name}'`);
    }
    return property;
};

describe("proto scalars", () => {
    const ir = extractProtoIR(SCALARS);
    const root = protobuf.parse(SCALARS).root;

    test("every scalar maps to a JS type plus the width it travels as", () => {
        const shape = (field: string) => {
            const type = propertyOf(ir.types.get("widths.Every"), field).type;
            if (type.kind !== "primitive") {
                throw new Error(`${field} is not primitive`);
            }
            return [type.type, type.constraints?.find((c) => c.kind === "format")?.value ?? null];
        };

        // A double needs no annotation: that is what a JS number already is.
        expect(shape("d")).toEqual(["number", null]);
        expect(shape("f")).toEqual(["number", "float"]);
        expect(shape("i32")).toEqual(["number", "int32"]);
        expect(shape("u32")).toEqual(["number", "uint32"]);
        expect(shape("s32")).toEqual(["number", "sint32"]);
        expect(shape("fx32")).toEqual(["number", "fixed32"]);
        expect(shape("sfx32")).toEqual(["number", "sfixed32"]);
        // 64-bit widths exceed what a number holds exactly, so they are bigints.
        expect(shape("i64")).toEqual(["bigint", "int64"]);
        expect(shape("u64")).toEqual(["bigint", "uint64"]);
        expect(shape("s64")).toEqual(["bigint", "sint64"]);
        expect(shape("fx64")).toEqual(["bigint", "fixed64"]);
        expect(shape("sfx64")).toEqual(["bigint", "sfixed64"]);
        expect(shape("flag")).toEqual(["boolean", null]);
        expect(shape("text")).toEqual(["string", null]);
        expect(shape("blob")).toEqual(["bytes", null]);
    });

    test("the field numbers are the ones protobufjs read", () => {
        const theirs = root.lookupType("widths.Every");
        const ours = ir.types.get("widths.Every");

        for (const [name, field] of Object.entries(theirs.fields)) {
            expect(propertyOf(ours, name).fieldNumber).toBe(field.id);
        }
    });
});

describe("constructs the IR cannot hold", () => {
    const diagnosticsOf = (text: string) => extractProtoIR(text).diagnostics.map((diagnostic) => diagnostic.keyword);

    test("proto2 presence and defaults are carried, not dropped", () => {
        const ir = extractProtoIR(`syntax = "proto2";
message M {
  required string a = 1;
  optional int32 b = 2 [default = 7];
  optional bool c = 3 [default = true];
  optional string d = 4 [default = "anon"];
}`);

        // Only the syntax itself is a diagnostic now: `required` is presence, which
        // the IR states as `optional: false`, and a default has its own slot.
        expect(ir.diagnostics.map((d) => d.keyword)).toEqual(["syntax"]);

        expect(propertyOf(ir.types.get("M"), "a").optional).toBe(false);
        expect(propertyOf(ir.types.get("M"), "b")).toMatchObject({
            optional: true,
            default: 7,
        });
        expect(propertyOf(ir.types.get("M"), "c").default).toBe(true);
        expect(propertyOf(ir.types.get("M"), "d").default).toBe("anon");
    });

    test("an unresolvable type is carried rather than thrown", () => {
        const ir = extractProtoIR(`syntax = "proto3";
message M {
  widget a = 1;
}`);

        expect(ir.diagnostics[0]).toMatchObject({ keyword: "type", pointer: "M.a" });
        expect(propertyOf(ir.types.get("M"), "a").type.kind).toBe("primitive");
    });

    test("extend and reserved are dropped with a reason", () => {
        expect(
            diagnosticsOf(`syntax = "proto3";
message M {
  reserved 2, 3;
  string a = 1;
}
extend M {
  string b = 9;
}`).sort(),
        ).toEqual(["extend", "reserved"]);
    });

    test("strict turns the first diagnostic into a throw", () => {
        expect(() =>
            extractProtoIR(`syntax = "proto3";\nmessage M { widget a = 1; }`, {
                strict: true,
            }),
        ).toThrow("unresolved type 'widget'");
    });
});

describe("well-known types and imports", () => {
    /**
     * A `Timestamp` is a message of `seconds` and `nanos`. It used to collapse to
     * the `date` primitive, which read nicely and wrote a bare varint that every
     * other implementation skipped as an unknown field - silently, since skipping
     * unknown fields is legal. The shape the spec gives it is declared instead.
     */
    test("a well-known type is declared as the message it is", () => {
        const ir = extractProtoIR(`syntax = "proto3";
import "google/protobuf/timestamp.proto";
message M {
  google.protobuf.Timestamp at = 1;
}`);

        expect(ir.diagnostics).toEqual([]);
        expect(ir.types.has("google.protobuf.Timestamp")).toBe(true);

        const at = propertyOf(ir.types.get("M"), "at").type;
        expect(at).toMatchObject({ kind: "object", name: "google.protobuf.Timestamp" });
        expect(propertyOf(ir.types.get("google.protobuf.Timestamp"), "seconds")).toMatchObject({
            fieldNumber: 1,
        });
        expect(propertyOf(ir.types.get("google.protobuf.Timestamp"), "nanos")).toMatchObject({
            fieldNumber: 2,
        });
    });

    test("a wrapper is declared with its single value field", () => {
        const ir = extractProtoIR(`syntax = "proto3";
import "google/protobuf/wrappers.proto";
message M {
  google.protobuf.StringValue note = 1;
}`);

        expect(ir.diagnostics).toEqual([]);
        expect(propertyOf(ir.types.get("google.protobuf.StringValue"), "value")).toMatchObject({
            fieldNumber: 1,
            type: { kind: "primitive", type: "string" },
        });
    });

    /**
     * The reason the mapping changed, stated as bytes: protobufjs holds the real
     * descriptor, so if our encoder agrees with it the field survives the trip.
     */
    test("a well-known field is on the wire where protobufjs expects it", async () => {
        const source = `syntax = "proto3";
import "google/protobuf/timestamp.proto";
message Event {
  string id = 1;
  google.protobuf.Timestamp at = 2;
}`;

        const ir = extractProtoIR(source);
        const directory = await mkdtemp(join(tmpdir(), "wiz-wkt-"));
        const path = join(directory, "codec.ts");
        await Bun.write(path, generateProtobufCodecCode([{ name: "Event", ir: ir.types.get("Event")! }]));

        const codec = (await import(path)) as unknown as {
            encodeEvent(value: unknown): Uint8Array;
        };
        const ours = codec.encodeEvent({
            id: "e1",
            at: { seconds: 1700000000n, nanos: 123000000 },
        });

        const root = new protobuf.Root();
        root.loadSync(join(import.meta.dir, "..", "node_modules/protobufjs/google/protobuf/timestamp.proto"));
        protobuf.parse(source, root, { keepCase: true });
        root.resolveAll();

        const theirs = root
            .lookupType("Event")
            .encode({ id: "e1", at: { seconds: 1700000000, nanos: 123000000 } })
            .finish();

        expect([...ours]).toEqual([...theirs]);
        expect(root.lookupType("Event").decode(ours).toJSON()).toEqual({
            id: "e1",
            at: { seconds: "1700000000", nanos: 123000000 },
        });

        await rm(directory, { recursive: true, force: true });
    });

    test("an unmapped well-known type is reported", () => {
        const ir = extractProtoIR(`syntax = "proto3";
import "google/protobuf/any.proto";
message M {
  google.protobuf.Any a = 1;
}`);

        expect(ir.diagnostics[0]?.message).toContain("google.protobuf.Any");
    });

    describe("across files", () => {
        let directory: string;

        beforeAll(async () => {
            directory = await mkdtemp(join(tmpdir(), "wiz-proto-"));
            await writeFile(
                join(directory, "common.proto"),
                `syntax = "proto3";
package common;
message Id {
  string value = 1;
}`,
            );
            await writeFile(
                join(directory, "service.proto"),
                `syntax = "proto3";
package api;
import "common.proto";
message Thing {
  common.Id id = 1;
}
service Things {
  rpc Get (Thing) returns (Thing);
}`,
            );
        });

        afterAll(async () => {
            await rm(directory, { recursive: true, force: true });
        });

        test("an import is followed and its messages become referable", async () => {
            const ir = await extractProtoIRFromFile(join(directory, "service.proto"));

            expect(ir.diagnostics).toEqual([]);
            expect([...ir.types.keys()].sort()).toEqual(["api.Thing", "common.Id"]);
            expect(propertyOf(ir.types.get("api.Thing"), "id").type).toMatchObject({
                name: "common.Id",
            });

            const method = ir.service.methods.filter(isGrpcMethod)[0]!;
            expect(method.address).toMatchObject({
                package: "api",
                service: "Things",
                method: "Get",
            });
        });

        test("a missing import is a diagnostic, not a failure", async () => {
            const path = join(directory, "broken.proto");
            await writeFile(path, `syntax = "proto3";\nimport "nowhere.proto";\nmessage M { string a = 1; }`);

            const ir = await extractProtoIRFromFile(path);
            expect(ir.diagnostics.map((d) => d.keyword)).toEqual(["import"]);
            expect(ir.types.has("M")).toBe(true);
        });
    });
});
