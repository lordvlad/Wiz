// @wiz-ignore
import { describe, expect, test } from 'bun:test';
import { generateAvroCode, generateAvroSchemaCode } from '../src/generators/avro.ts';
import { generateOpenApiSchemaCode } from '../src/generators/openapi.ts';
import { generateProtobufCode, generateProtobufSchemaCode } from '../src/generators/protobuf.ts';
import { generateSchemaCode } from '../src/generators/schema.ts';
import { generateValidatorCode } from '../src/generators/validator.ts';
import { evalModule, getIRForSource } from './helpers.ts';

interface Proto {
  encodeProto: (v: unknown, b: Uint8Array, o?: number) => number;
  decodeProto: (b: Uint8Array, o?: number) => any;
}
interface Avro {
  encodeAvro: (v: unknown, b: Uint8Array, o?: number) => number;
  decodeAvro: (b: Uint8Array, o?: number) => any;
}

const proto = (src: string, name = 'M') =>
  evalModule<Proto>(generateProtobufCode(getIRForSource(src, name)));
const avro = (src: string, name = 'M') =>
  evalModule<Avro>(generateAvroCode(getIRForSource(src, name)));

function protoTrip(mod: Proto, value: unknown, size = 512) {
  const buf = new Uint8Array(size);
  const n = mod.encodeProto(value, buf);
  return { decoded: mod.decodeProto(buf.subarray(0, n)), bytes: [...buf.subarray(0, n)] };
}

describe('Uint8Array and Date are opaque scalars', () => {
  const src = `
    export interface M {
      /**
       * @fieldNumber 1
       */
      blob: Uint8Array;
      /**
       * @fieldNumber 2
       */
      at: Date;
    }
  `;

  test('no longer explode into their own methods', () => {
    const doc = evalModule<{ openapiSchema: () => any }>(
      generateOpenApiSchemaCode([{ name: 'M', ir: getIRForSource(src, 'M') }], '3.1')
    ).openapiSchema();

    // Previously a single Uint8Array field produced 45 component schemas.
    expect(Object.keys(doc.components.schemas)).toEqual(['M']);
    expect(doc.components.schemas.M.properties.blob).toEqual({
      type: 'string',
      contentEncoding: 'base64',
    });
    expect(doc.components.schemas.M.properties.at).toEqual({
      type: 'string',
      format: 'date-time',
    });
  });

  test('JSON Schema uses base64 and date-time', () => {
    const mod = evalModule<{ schema_draft2020: any; schema_draft07: any }>(
      generateSchemaCode(getIRForSource(src, 'M'))
    );
    expect(mod.schema_draft2020.properties.blob.contentEncoding).toBe('base64');
    expect(mod.schema_draft07.properties.blob.format).toBe('byte');
    expect(mod.schema_draft2020.properties.at.format).toBe('date-time');
  });

  test('protobuf uses bytes and an int64 instant', () => {
    const text = evalModule<{ protobufSchema: (o?: any) => string }>(
      generateProtobufSchemaCode([{ name: 'M', ir: getIRForSource(src, 'M') }])
    ).protobufSchema();
    expect(text).toContain('bytes blob = 1;');
    expect(text).toContain('int64 at = 2;');
  });

  test('avro uses bytes and a timestamp-millis logical type', () => {
    const schema = JSON.parse(
      evalModule<{ avroSchema: (o?: any) => string }>(
        generateAvroSchemaCode([{ name: 'M', ir: getIRForSource(src, 'M') }])
      ).avroSchema()
    );
    expect(schema.fields[0].type).toBe('bytes');
    expect(schema.fields[1].type).toEqual({
      type: 'long',
      logicalType: 'timestamp-millis',
    });
  });

  test('both round-trip through each codec', () => {
    const value = {
      blob: new Uint8Array([1, 2, 250]),
      at: new Date('2024-03-01T12:00:00.000Z'),
    };

    const p = protoTrip(proto(src), value).decoded;
    expect([...p.blob]).toEqual([1, 2, 250]);
    expect(p.at.toISOString()).toBe('2024-03-01T12:00:00.000Z');

    const abuf = new Uint8Array(256);
    const amod = avro(src);
    const an = amod.encodeAvro(value, abuf);
    const a = amod.decodeAvro(abuf.subarray(0, an));
    expect([...a.blob]).toEqual([1, 2, 250]);
    expect(a.at.toISOString()).toBe('2024-03-01T12:00:00.000Z');
  });

  test('the validator checks the real runtime classes', () => {
    const mod = evalModule<{ is: (v: unknown) => boolean }>(
      generateValidatorCode(getIRForSource(src, 'M'))
    );
    expect(mod.is({ blob: new Uint8Array([1]), at: new Date() })).toBe(true);
    expect(mod.is({ blob: [1], at: new Date() })).toBe(false);
    expect(mod.is({ blob: new Uint8Array([1]), at: '2024-01-01' })).toBe(false);
    expect(mod.is({ blob: new Uint8Array([1]), at: new Date('nope') })).toBe(false);
  });
});

describe('protobuf embedded messages', () => {
  const src = `
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
      inner: Inner;
    }
  `;

  test('encode as a length-delimited sub-message, not JSON text', () => {
    const { bytes, decoded } = protoTrip(proto(src), { inner: { a: 'hi' } });
    // tag 0x0a (field 1, wire 2), length 4, then the sub-message: 0x0a len 'h' 'i'
    expect(bytes).toEqual([0x0a, 0x04, 0x0a, 0x02, 0x68, 0x69]);
    // Previously this was 0x0a 0x0a followed by the text {"a":"hi"}.
    expect(String.fromCharCode(...bytes)).not.toContain('{');
    expect(decoded).toEqual({ inner: { a: 'hi' } });
  });

  test('multi-byte lengths shift the payload correctly', () => {
    const long = 'x'.repeat(200);
    const { decoded } = protoTrip(proto(src), { inner: { a: long } });
    expect(decoded.inner.a).toBe(long);
  });

  test('repeated messages each get their own record', () => {
    const listSrc = `
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
        items: Inner[];
      }
    `;
    const value = { items: [{ a: 'one' }, { a: 'two' }] };
    expect(protoTrip(proto(listSrc), value).decoded).toEqual(value);
  });

  test('a nested message missing @fieldNumber is reported, not silently dropped', () => {
    const badSrc = `
      export interface Inner { a: string }
      export interface M {
        /**
         * @fieldNumber 1
         */
        inner: Inner;
      }
    `;
    const mod = proto(badSrc);
    expect(() => mod.encodeProto({ inner: { a: 'x' } }, new Uint8Array(32))).toThrow(
      "Property 'a' on type 'Inner' is missing required '@fieldNumber"
    );
  });
});

describe('protobuf packed repeated', () => {
  const src = `
    export interface M {
      /**
       * @fieldNumber 1
       * @format int32
       */
      nums: number[];
    }
  `;

  test('scalars pack into one length-delimited run', () => {
    const { bytes, decoded } = protoTrip(proto(src), { nums: [1, 2, 3] });
    // One tag (wire 2), one length, then the three varints.
    expect(bytes).toEqual([0x0a, 0x03, 0x01, 0x02, 0x03]);
    expect(decoded).toEqual({ nums: [1, 2, 3] });
  });

  test('the decoder still accepts the unpacked framing', () => {
    // Hand-built unpacked form: tag(wire 0) + value, repeated.
    const unpacked = new Uint8Array([0x08, 0x01, 0x08, 0x02, 0x08, 0x03]);
    expect(proto(src).decodeProto(unpacked)).toEqual({ nums: [1, 2, 3] });
  });

  test('strings stay unpacked, since they carry their own length', () => {
    const strSrc = `
      export interface M {
        /**
         * @fieldNumber 1
         */
        tags: string[];
      }
    `;
    const { bytes, decoded } = protoTrip(proto(strSrc), { tags: ['a', 'b'] });
    expect(bytes).toEqual([0x0a, 0x01, 0x61, 0x0a, 0x01, 0x62]);
    expect(decoded).toEqual({ tags: ['a', 'b'] });
  });
});

describe('protobuf maps', () => {
  const src = `
    export interface M {
      /**
       * @fieldNumber 1
       * @format int32
       */
      counts: Record<string, number>;
    }
  `;

  test('encode as repeated key/value entry messages', () => {
    const { bytes, decoded } = protoTrip(proto(src), { counts: { a: 1 } });
    // entry tag, entry length 5, key tag+len+'a', value tag+1
    expect(bytes).toEqual([0x0a, 0x05, 0x0a, 0x01, 0x61, 0x10, 0x01]);
    expect(decoded).toEqual({ counts: { a: 1 } });
  });

  test('round-trip several entries', () => {
    const value = { counts: { a: 1, b: 22, c: 333 } };
    expect(protoTrip(proto(src), value).decoded).toEqual(value);
  });

  test('the .proto schema still describes the field', () => {
    const text = evalModule<{ protobufSchema: (o?: any) => string }>(
      generateProtobufSchemaCode([{ name: 'M', ir: getIRForSource(src, 'M') }])
    ).protobufSchema();
    expect(text).toContain('counts = 1;');
  });
});

describe('extra integer widths', () => {
  const widths = (format: string, tsType = 'number') => `
    export interface M {
      /**
       * @fieldNumber 1
       * @format ${format}
       */
      v: ${tsType};
    }
  `;

  test('unsigned, zigzag and fixed widths reach the .proto output', () => {
    for (const format of [
      'uint32',
      'uint64',
      'sint32',
      'sint64',
      'fixed32',
      'sfixed32',
      'fixed64',
      'sfixed64',
    ]) {
      const text = evalModule<{ protobufSchema: (o?: any) => string }>(
        generateProtobufSchemaCode([{ name: 'M', ir: getIRForSource(widths(format), 'M') }])
      ).protobufSchema();
      expect(text).toContain(`${format} v = 1;`);
    }
  });

  test('zigzag makes small negatives cheap', () => {
    const { bytes, decoded } = protoTrip(proto(widths('sint32')), { v: -1 });
    // sint32(-1) zig-zags to 1: a single payload byte.
    expect(bytes).toEqual([0x08, 0x01]);
    expect(decoded.v).toBe(-1);
  });

  test('fixed widths occupy their fixed size', () => {
    const buf = new Uint8Array(32);
    expect(proto(widths('fixed32')).encodeProto({ v: 7 }, buf)).toBe(5);
    expect(proto(widths('fixed64', 'bigint')).encodeProto({ v: 7n }, buf)).toBe(9);
  });

  test('64-bit widths round-trip past 2^53', () => {
    const v = 9007199254740993n;
    expect(protoTrip(proto(widths('sfixed64', 'bigint')), { v }).decoded.v).toBe(v);
    expect(protoTrip(proto(widths('sint64', 'bigint')), { v: -v }).decoded.v).toBe(-v);
  });

  test('avro widens unsigned types to a signed type that fits', () => {
    const schema = JSON.parse(
      evalModule<{ avroSchema: (o?: any) => string }>(
        generateAvroSchemaCode([{ name: 'M', ir: getIRForSource(widths('uint32'), 'M') }])
      ).avroSchema()
    );
    expect(schema.fields[0].type).toBe('long');
  });
});

describe('avro logical types', () => {
  test('@format uuid, date and time annotate their primitive', () => {
    const src = `
      export interface M {
        /**
         * @format uuid
         */
        id: string;
        /**
         * @format date
         */
        day: string;
        /**
         * @format time
         */
        clock: string;
      }
    `;
    const schema = JSON.parse(
      evalModule<{ avroSchema: (o?: any) => string }>(
        generateAvroSchemaCode([{ name: 'M', ir: getIRForSource(src, 'M') }])
      ).avroSchema()
    );
    expect(schema.fields.map((f: any) => f.type)).toEqual([
      { type: 'string', logicalType: 'uuid' },
      { type: 'int', logicalType: 'date' },
      { type: 'int', logicalType: 'time-millis' },
    ]);
  });

  test('@format binary makes a string opaque bytes', () => {
    const src = `
      export interface M {
        /**
         * @format binary
         */
        blob: string;
      }
    `;
    const schema = JSON.parse(
      evalModule<{ avroSchema: (o?: any) => string }>(
        generateAvroSchemaCode([{ name: 'M', ir: getIRForSource(src, 'M') }])
      ).avroSchema()
    );
    expect(schema.fields[0].type).toBe('bytes');
  });
});
