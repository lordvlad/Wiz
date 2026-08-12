// @wiz-ignore
import { describe, expect, test } from "bun:test";
import { generateProtobufCode, generateProtobufSchemaCode } from "../src/generators/protobuf.ts";
import { generateSchemaCode } from "../src/generators/schema.ts";
import { evalModule, getIRForSource } from "./helpers.ts";

/** The helper as callers import it; declared inline so the fixture is one file. */
const HELPER = `type NumberedUnion<T extends Record<number, unknown>> = T[keyof T];`;

const SHAPES = `
  ${HELPER}
  export interface Circle {
    /**
     * @fieldNumber 1
     */
    kind: "circle";
    /**
     * @fieldNumber 2
     */
    radius: number;
  }
  export interface Square {
    /**
     * @fieldNumber 1
     */
    kind: "square";
    /**
     * @fieldNumber 2
     */
    side: number;
  }
  export type Shape = NumberedUnion<{ 3: Circle; 4: Square }>;
`;

interface Proto {
  encodeProto: (v: unknown, b: Uint8Array, o?: number) => number;
  decodeProto: (b: Uint8Array, o?: number) => any;
}

const proto = (src: string, name = "M") =>
  evalModule<Proto>(generateProtobufCode(getIRForSource(src, name)));

const protoSchema = (src: string, name = "M") =>
  evalModule<{ protobufSchema: (o?: any) => string }>(
    generateProtobufSchemaCode([{ name, ir: getIRForSource(src, name) }])
  ).protobufSchema();

function trip(mod: Proto, value: unknown) {
  const buf = new Uint8Array(512);
  const n = mod.encodeProto(value, buf);
  return { decoded: mod.decodeProto(buf.subarray(0, n)), bytes: [...buf.subarray(0, n)] };
}

describe("optional fields are not unions on the wire", () => {
  // Absence in protobuf is field omission, so `T | undefined` travels as a `T`.
  const src = `
    export interface M {
      /**
       * @fieldNumber 1
       * @format int32
       */
      n?: number;
      /**
       * @fieldNumber 2
       */
      s?: string;
      /**
       * @fieldNumber 3
       */
      b?: boolean;
    }
  `;

  test("an optional number is a varint, not the digit as text", () => {
    const { bytes, decoded } = trip(proto(src), { n: 5 });
    expect(bytes).toEqual([0x08, 0x05]);
    expect(decoded).toEqual({ n: 5 });
  });

  test("an optional string carries no JSON quotes", () => {
    const { bytes, decoded } = trip(proto(src), { s: "hi" });
    expect(bytes).toEqual([0x12, 0x02, 0x68, 0x69]);
    expect(decoded).toEqual({ s: "hi" });
  });

  test("the schema states the real type", () => {
    const text = protoSchema(src);
    expect(text).toContain("int32 n = 1;");
    expect(text).toContain("string s = 2;");
    expect(text).toContain("bool b = 3;");
  });

  test("an absent field writes nothing", () => {
    expect(trip(proto(src), {}).bytes).toEqual([]);
  });

  test("an optional message still embeds as a sub-message", () => {
    const nestedSrc = `
      export interface Inner {
        /**
         * @fieldNumber 1
         */
        a: string;
      }
      export interface M {
        /**
         * @fieldNumber 1
         */
        inner?: Inner;
      }
    `;
    const { bytes, decoded } = trip(proto(nestedSrc), { inner: { a: "hi" } });
    expect(bytes).toEqual([0x0a, 0x04, 0x0a, 0x02, 0x68, 0x69]);
    expect(decoded).toEqual({ inner: { a: "hi" } });
  });
});

describe("NumberedUnion becomes a protobuf oneof", () => {
  const src = `
    ${SHAPES}
    export interface M {
      shape: Shape;
    }
  `;

  test("each variant is its own field in the enclosing number space", () => {
    const text = protoSchema(src);
    expect(text).toContain("oneof shape {");
    expect(text).toContain("Circle circle = 3;");
    expect(text).toContain("Square square = 4;");
  });

  test("the chosen variant is written under its own field number", () => {
    const mod = proto(src);
    const circle = trip(mod, { shape: { kind: "circle", radius: 2 } });
    // field 3, wire 2
    expect(circle.bytes[0]).toBe((3 << 3) | 2);
    expect(circle.decoded).toEqual({ shape: { kind: "circle", radius: 2 } });

    const square = trip(mod, { shape: { kind: "square", side: 5 } });
    expect(square.bytes[0]).toBe((4 << 3) | 2);
    expect(square.decoded).toEqual({ shape: { kind: "square", side: 5 } });
  });

  test("only the selected variant reaches the wire", () => {
    const { bytes } = trip(proto(src), { shape: { kind: "circle", radius: 2 } });
    expect(bytes.filter((b) => b === ((4 << 3) | 2))).toEqual([]);
  });

  test("scalar variants use their own wire types", () => {
    const scalarSrc = `
      ${HELPER}
      export type Value = NumberedUnion<{ 1: string; 2: boolean }>;
      export interface M {
        value: Value;
      }
    `;
    const mod = proto(scalarSrc);
    const asString = trip(mod, { value: "hi" });
    expect(asString.bytes).toEqual([(1 << 3) | 2, 0x02, 0x68, 0x69]);
    expect(asString.decoded).toEqual({ value: "hi" });

    const asBool = trip(mod, { value: true });
    expect(asBool.bytes).toEqual([(2 << 3) | 0, 0x01]);
    expect(asBool.decoded).toEqual({ value: true });

    expect(protoSchema(scalarSrc)).toContain("oneof value {");
  });

  test("an optional union keeps its numbering", () => {
    // `shape?: Shape` widens to `Circle | Square | undefined`, which drops the
    // alias, so the numbers come from the property's own annotation.
    const optionalSrc = `
      ${SHAPES}
      export interface M {
        shape?: Shape;
      }
    `;
    expect(protoSchema(optionalSrc)).toContain("oneof shape {");
    const { decoded } = trip(proto(optionalSrc), { shape: { kind: "square", side: 1 } });
    expect(decoded).toEqual({ shape: { kind: "square", side: 1 } });
  });

  test("an absent optional union writes nothing", () => {
    const optionalSrc = `
      ${SHAPES}
      export interface M {
        shape?: Shape;
      }
    `;
    expect(trip(proto(optionalSrc), {}).bytes).toEqual([]);
  });

  test("variant messages are hoisted into the schema", () => {
    const text = protoSchema(src);
    expect(text).toContain("message Circle {");
    expect(text).toContain("message Square {");
  });

  test("other generators still see an ordinary union", () => {
    const mod = evalModule<{ schema_draft2020: any }>(
      generateSchemaCode(getIRForSource(src, "M"))
    );
    // Discriminated, so JSON Schema picks oneOf; either way it stays a union.
    const shape = mod.schema_draft2020.properties.shape;
    expect(shape.oneOf ?? shape.anyOf).toHaveLength(2);
    expect(shape.discriminator).toEqual({ propertyName: "kind" });
  });
});

describe("unions protobuf cannot express are refused", () => {
  const message = (src: string, name = "M") => {
    const mod = proto(src, name);
    try {
      mod.encodeProto({}, new Uint8Array(64));
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };

  test("an unnumbered union names the helper to use", () => {
    const src = `
      export interface M {
        /**
         * @fieldNumber 1
         */
        value: string | number;
      }
    `;
    expect(message(src)).toContain("NumberedUnion<{ 1: A; 2: B }>");
    expect(message(src)).toContain("'value'");
  });

  test("the schema refuses it too, rather than inventing a type", () => {
    const src = `
      export interface M {
        /**
         * @fieldNumber 1
         */
        value: string | number;
      }
    `;
    expect(() => protoSchema(src)).toThrow("NumberedUnion");
  });

  test("a variant number colliding with a sibling field is reported", () => {
    const src = `
      ${SHAPES}
      export interface M {
        /**
         * @fieldNumber 3
         */
        name: string;
        shape: Shape;
      }
    `;
    const text = message(src);
    expect(text).toContain("Field number 3");
    expect(text).toContain("'name'");
    expect(text).toContain("shape variant 1");
  });

  test("a repeated key collapses in TypeScript before wiz sees it", () => {
    const src = `
      ${HELPER}
      export type Value = NumberedUnion<{ 1: string; 1: boolean }>;
      export interface M {
        value: Value;
      }
    `;
    // `{ 1: string; 1: boolean }` is one key, so the union never forms and the
    // property is an ordinary field again — which then wants its own number.
    expect(message(src)).toContain("missing required '@fieldNumber");
  });

  test("@fieldNumber alongside a NumberedUnion is refused as ambiguous", () => {
    const src = `
      ${SHAPES}
      export interface M {
        /**
         * @fieldNumber 9
         */
        shape: Shape;
      }
    `;
    expect(message(src)).toContain("already numbers each variant");
  });
});

describe("literal unions are not oneofs", () => {
  test("same-typed literals collapse to their primitive", () => {
    const src = `
      export interface M {
        /**
         * @fieldNumber 1
         */
        mode: "read" | "write";
      }
    `;
    expect(protoSchema(src)).toContain("string mode = 1;");
    const { bytes, decoded } = trip(proto(src), { mode: "read" });
    expect(bytes).toEqual([0x0a, 0x04, 0x72, 0x65, 0x61, 0x64]);
    expect(decoded).toEqual({ mode: "read" });
  });

  test("numeric literals collapse too", () => {
    const src = `
      export interface M {
        /**
         * @fieldNumber 1
         * @format int32
         */
        level: 1 | 2 | 3;
      }
    `;
    expect(protoSchema(src)).toContain("int32 level = 1;");
    expect(trip(proto(src), { level: 2 }).bytes).toEqual([0x08, 0x02]);
  });

  test("mixed literal types are still refused", () => {
    const src = `
      export interface M {
        /**
         * @fieldNumber 1
         */
        mixed: "a" | 1;
      }
    `;
    expect(() => protoSchema(src)).toThrow("NumberedUnion");
  });
});
