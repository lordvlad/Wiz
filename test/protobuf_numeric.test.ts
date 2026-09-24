// @wiz-ignore
import { describe, expect, test } from 'bun:test';
import { generateProtobufCode, generateProtobufSchemaCode } from '../src/generators/protobuf.ts';
import { evalModule, getIRForSource } from './helpers.ts';

interface Codec {
  encodeProto: (val: unknown, buf: Uint8Array, offset?: number) => number;
  decodeProto: (buf: Uint8Array, offset?: number) => any;
}

/** Builds a one-field message whose single field carries `tags`. */
function oneField(tags: string[], tsType = 'number'): string {
  return `
    export interface M {
      /**
${tags.map((t) => `       * ${t}`).join('\n')}
       */
      v: ${tsType};
    }
  `;
}

const codec = (source: string) =>
  evalModule<Codec>(generateProtobufCode(getIRForSource(source, 'M')));

function roundtrip(mod: Codec, value: unknown, size = 128) {
  const buf = new Uint8Array(size);
  const written = mod.encodeProto(value, buf);
  return mod.decodeProto(buf.subarray(0, written));
}

describe('protobuf numeric widths', () => {
  test('a plain number keeps its fractional part', () => {
    // Previously `number` mapped to int32 and the varint truncated 3.14 to 3,
    // because the bytes are written into a Uint8Array.
    const mod = codec(oneField(['@fieldNumber 1']));
    for (const v of [3.14, -0.5, 1e-7, 12345.6789]) {
      expect(roundtrip(mod, { v }).v).toBe(v);
    }
  });

  test('@format selects int32, int64, float and double', () => {
    const source = `
      export interface Widths {
        /**
         * @fieldNumber 1
         * @format int32
         */
        small: number;
        /**
         * @fieldNumber 2
         * @format int64
         */
        big: number;
        /**
         * @fieldNumber 3
         * @format float
         */
        approx: number;
        /**
         * @fieldNumber 4
         * @format double
         */
        exact: number;
        /**
         * @fieldNumber 5
         */
        plain: number;
        /**
         * @fieldNumber 6
         */
        huge: bigint;
      }
    `;
    const text = evalModule<{ protobufSchema: (o?: any) => string }>(
      generateProtobufSchemaCode([{ name: 'Widths', ir: getIRForSource(source, 'Widths') }])
    ).protobufSchema();

    expect(text).toContain('int32 small = 1;');
    expect(text).toContain('int64 big = 2;');
    expect(text).toContain('float approx = 3;');
    expect(text).toContain('double exact = 4;');
    // No @format, so the honest mapping for a JS number.
    expect(text).toContain('double plain = 5;');
    expect(text).toContain('int64 huge = 6;');
  });

  test('each width uses the protobuf wire type it is supposed to', () => {
    const tagOf = (tags: string[]) => {
      const buf = new Uint8Array(32);
      codec(oneField(tags)).encodeProto({ v: 1 }, buf);
      return buf[0]! & 7; // low three bits of the tag byte
    };

    expect(tagOf(['@fieldNumber 1', '@format int32'])).toBe(0); // varint
    expect(tagOf(['@fieldNumber 1', '@format int64'])).toBe(0); // varint
    expect(tagOf(['@fieldNumber 1', '@format double'])).toBe(1); // 64-bit
    expect(tagOf(['@fieldNumber 1', '@format float'])).toBe(5); // 32-bit
  });

  test('fixed-width fields occupy their declared byte count', () => {
    const size = (tags: string[]) => {
      const buf = new Uint8Array(32);
      return codec(oneField(tags)).encodeProto({ v: 1.5 }, buf);
    };
    // one tag byte plus the payload
    expect(size(['@fieldNumber 1', '@format float'])).toBe(5);
    expect(size(['@fieldNumber 1', '@format double'])).toBe(9);
  });

  test('float round-trips at single precision, double at full', () => {
    const f = codec(oneField(['@fieldNumber 1', '@format float']));
    const d = codec(oneField(['@fieldNumber 1', '@format double']));

    expect(roundtrip(f, { v: 1.5 }).v).toBe(1.5);
    // 0.1 has no exact float32 representation, so it returns approximate.
    expect(roundtrip(f, { v: 0.1 }).v).toBeCloseTo(0.1, 6);
    expect(roundtrip(d, { v: 0.1 }).v).toBe(0.1);
  });

  test('int32 still round-trips integers as a compact varint', () => {
    const mod = codec(oneField(['@fieldNumber 1', '@format int32']));
    for (const v of [0, 1, 127, 128, 300, 2147483647]) {
      expect(roundtrip(mod, { v }).v).toBe(v);
    }
  });

  test('bigint is unaffected and still exact past 2^53', () => {
    const mod = codec(oneField(['@fieldNumber 1'], 'bigint'));
    const v = 9223372036854775807n;
    expect(roundtrip(mod, { v }).v).toBe(v);
  });

  test('repeated numbers follow the same width rules', () => {
    const mod = codec(oneField(['@fieldNumber 1'], 'number[]'));
    const value = { v: [1.5, -2.25, 0.125] };
    expect(roundtrip(mod, value)).toEqual(value);
  });
});
