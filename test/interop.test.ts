// @wiz-ignore
import { describe, expect, test } from 'bun:test';
import protobuf from 'protobufjs';
import { generateProtobufCode, generateProtobufSchemaCode } from '../src/generators/protobuf.ts';
import { evalModule, getIRForSource } from './helpers.ts';

/**
 * Interop against protobuf.js.
 *
 * Round-tripping wiz against itself proves nothing about the wire format: a
 * codec that is wrong in both directions round-trips perfectly. These tests
 * make an independent implementation read what wiz writes, and vice versa.
 */

interface Codec {
  encodeProto: (v: unknown, b: Uint8Array, o?: number) => number;
  decodeProto: (b: Uint8Array, o?: number) => any;
}

/** wiz's codec, its `.proto` text, and protobuf.js's view of that text. */
function pair(source: string, root = 'M') {
  const ir = getIRForSource(source, root);
  const codec = evalModule<Codec>(generateProtobufCode(ir));
  const proto = evalModule<{ protobufSchema: (o?: any) => string }>(
    generateProtobufSchemaCode([{ name: root, ir }])
  ).protobufSchema();

  // Parsing is itself an assertion: protobuf.js rejects invalid proto3.
  const parsed = protobuf.parse(proto, { keepCase: true });
  return { codec, proto, type: parsed.root.lookupType(root) };
}

const wizEncode = (codec: Codec, value: unknown) => {
  const buf = new Uint8Array(4096);
  return buf.subarray(0, codec.encodeProto(value, buf));
};

/** protobuf.js hands back Long, Buffer and prototype noise; normalise it. */
const asPlain = (type: protobuf.Type, bytes: Uint8Array) =>
  type.toObject(type.decode(bytes), {
    longs: String,
    bytes: Array,
    defaults: false,
    arrays: false,
    objects: false,
  });

describe('protobuf.js reads what wiz writes', () => {
  test('scalars, with the widths @format selects', () => {
    const { codec, type } = pair(`
      export interface M {
        /** @fieldNumber 1 */
        text: string;
        /**
         * @fieldNumber 2
         * @format int32
         */
        count: number;
        /** @fieldNumber 3 */
        ratio: number;
        /**
         * @fieldNumber 4
         * @format float
         */
        approx: number;
        /** @fieldNumber 5 */
        flag: boolean;
      }
    `);

    const value = { text: 'hi', count: -7, ratio: 3.14, approx: 0.5, flag: true };
    expect(asPlain(type, wizEncode(codec, value))).toEqual(value);
  });

  test('optional fields, which used to travel as JSON text', () => {
    const { codec, type } = pair(`
      export interface M {
        /**
         * @fieldNumber 1
         * @format int32
         */
        n?: number;
        /** @fieldNumber 2 */
        s?: string;
      }
    `);

    expect(asPlain(type, wizEncode(codec, { n: 5, s: 'hi' }))).toEqual({ n: 5, s: 'hi' });
    expect(asPlain(type, wizEncode(codec, { n: 5 }))).toEqual({ n: 5 });
    expect(asPlain(type, wizEncode(codec, {}))).toEqual({});
  });

  test('64-bit integers keep their full range', () => {
    const { codec, type } = pair(`
      export interface M {
        /**
         * @fieldNumber 1
         * @format int64
         */
        big: bigint;
        /**
         * @fieldNumber 2
         * @format sint64
         */
        negative: bigint;
      }
    `);

    const value = { big: 9007199254740993n, negative: -9007199254740993n };
    expect(asPlain(type, wizEncode(codec, value))).toEqual({
      big: '9007199254740993',
      negative: '-9007199254740993',
    });
  });

  test('embedded messages, not JSON in a string field', () => {
    const { codec, type } = pair(`
      export interface Inner {
        /** @fieldNumber 1 */
        a: string;
        /**
         * @fieldNumber 2
         * @format int32
         */
        b: number;
      }
      export interface M {
        /** @fieldNumber 1 */
        inner: Inner;
      }
    `);

    const value = { inner: { a: 'hi', b: 3 } };
    expect(asPlain(type, wizEncode(codec, value))).toEqual(value);
  });

  test('repeated messages', () => {
    const { codec, type } = pair(`
      export interface Inner {
        /** @fieldNumber 1 */
        a: string;
      }
      export interface M {
        /** @fieldNumber 1 */
        items: Inner[];
      }
    `);

    const value = { items: [{ a: 'one' }, { a: 'two' }] };
    expect(asPlain(type, wizEncode(codec, value))).toEqual(value);
  });

  test('packed repeated scalars', () => {
    const { codec, type } = pair(`
      export interface M {
        /**
         * @fieldNumber 1
         * @format int32
         */
        nums: number[];
        /** @fieldNumber 2 */
        tags: string[];
      }
    `);

    const value = { nums: [1, 2, 300], tags: ['a', 'b'] };
    expect(asPlain(type, wizEncode(codec, value))).toEqual(value);
  });

  test('maps', () => {
    const { codec, type } = pair(`
      export interface M {
        /**
         * @fieldNumber 1
         * @format int32
         */
        counts: Record<string, number>;
      }
    `);

    const value = { counts: { a: 1, b: 22 } };
    expect(asPlain(type, wizEncode(codec, value))).toEqual(value);
  });

  test('bytes and instants', () => {
    const { codec, type } = pair(`
      export interface M {
        /** @fieldNumber 1 */
        blob: Uint8Array;
        /** @fieldNumber 2 */
        at: Date;
      }
    `);

    const at = new Date('2024-03-01T12:00:00.000Z');
    const decoded = asPlain(type, wizEncode(codec, { blob: new Uint8Array([1, 2, 250]), at }));
    expect(decoded.blob).toEqual([1, 2, 250]);
    expect(decoded.at).toBe(String(at.getTime()));
  });

  test('a oneof, with only the selected variant present', () => {
    const { codec, type } = pair(`
      type NumberedUnion<T extends Record<number, unknown>> = T[keyof T];
      export interface Circle {
        /** @fieldNumber 1 */
        kind: "circle";
        /**
         * @fieldNumber 2
         * @format int32
         */
        radius: number;
      }
      export interface Square {
        /** @fieldNumber 1 */
        kind: "square";
        /**
         * @fieldNumber 2
         * @format int32
         */
        side: number;
      }
      export type Shape = NumberedUnion<{ 3: Circle; 4: Square }>;
      export interface M {
        /** @fieldNumber 1 */
        title: string;
        shape: Shape;
      }
    `);

    const circle = asPlain(
      type,
      wizEncode(codec, {
        title: 'a',
        shape: { kind: 'circle', radius: 2 },
      })
    );
    expect(circle).toEqual({ title: 'a', circle: { kind: 'circle', radius: 2 } });
    // protobuf.js exposes which arm is set; it must be the circle.
    expect(type.oneofs?.shape).toBeDefined();

    const square = asPlain(
      type,
      wizEncode(codec, {
        title: 'b',
        shape: { kind: 'square', side: 5 },
      })
    );
    expect(square).toEqual({ title: 'b', square: { kind: 'square', side: 5 } });
  });
});

describe('wiz reads what protobuf.js writes', () => {
  const roundtrip = (source: string, value: Record<string, unknown>) => {
    const { codec, type } = pair(source);
    const bytes = type.encode(type.fromObject(value)).finish();
    return codec.decodeProto(new Uint8Array(bytes));
  };

  test('scalars', () => {
    const source = `
      export interface M {
        /** @fieldNumber 1 */
        text: string;
        /**
         * @fieldNumber 2
         * @format int32
         */
        count: number;
        /** @fieldNumber 3 */
        ratio: number;
        /** @fieldNumber 4 */
        flag: boolean;
      }
    `;
    expect(roundtrip(source, { text: 'hi', count: -7, ratio: 3.14, flag: true })).toEqual({
      text: 'hi',
      count: -7,
      ratio: 3.14,
      flag: true,
    });
  });

  test('nested and repeated messages', () => {
    const source = `
      export interface Inner {
        /** @fieldNumber 1 */
        a: string;
      }
      export interface M {
        /** @fieldNumber 1 */
        inner: Inner;
        /** @fieldNumber 2 */
        items: Inner[];
      }
    `;
    expect(roundtrip(source, { inner: { a: 'x' }, items: [{ a: 'y' }, { a: 'z' }] })).toEqual({
      inner: { a: 'x' },
      items: [{ a: 'y' }, { a: 'z' }],
    });
  });

  test('packed repeated scalars written by a conformant encoder', () => {
    const source = `
      export interface M {
        /**
         * @fieldNumber 1
         * @format int32
         */
        nums: number[];
      }
    `;
    expect(roundtrip(source, { nums: [1, 2, 300] })).toEqual({ nums: [1, 2, 300] });
  });

  test('maps', () => {
    const source = `
      export interface M {
        /**
         * @fieldNumber 1
         * @format int32
         */
        counts: Record<string, number>;
      }
    `;
    expect(roundtrip(source, { counts: { a: 1, b: 22 } })).toEqual({ counts: { a: 1, b: 22 } });
  });

  test('a oneof arm chosen by the other implementation', () => {
    const source = `
      type NumberedUnion<T extends Record<number, unknown>> = T[keyof T];
      export interface Circle {
        /** @fieldNumber 1 */
        kind: "circle";
        /**
         * @fieldNumber 2
         * @format int32
         */
        radius: number;
      }
      export interface Square {
        /** @fieldNumber 1 */
        kind: "square";
        /**
         * @fieldNumber 2
         * @format int32
         */
        side: number;
      }
      export type Shape = NumberedUnion<{ 3: Circle; 4: Square }>;
      export interface M {
        shape: Shape;
      }
    `;
    expect(roundtrip(source, { square: { kind: 'square', side: 5 } })).toEqual({
      shape: { kind: 'square', side: 5 },
    });
  });
});
