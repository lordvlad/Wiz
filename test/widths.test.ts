// @wiz-ignore
import { beforeAll, describe, expect, test } from 'bun:test';
import * as A from 'apache-arrow';
import avro from 'avsc';
import protobuf from 'protobufjs';
import { generateArrowCode } from '../src/generators/arrow.ts';
import { generateAvroCode, generateAvroSchemaCode } from '../src/generators/avro.ts';
import { generateOpenApiSchemaCode } from '../src/generators/openapi.ts';
import { generateProtobufCode, generateProtobufSchemaCode } from '../src/generators/protobuf.ts';
import { generateSchemaCode } from '../src/generators/schema.ts';
import { generateValidatorCode } from '../src/generators/validator.ts';
import { INTEGER_FORMATS } from '../src/types.ts';
import { evalModule, getIRForSource } from './helpers.ts';

/**
 * Integer widths.
 *
 * A declared width is a promise about the range of a value, and every codec
 * narrows the value to fit it. So the promise has to be checked: unchecked, an
 * ordinary number silently becomes a different one on the wire.
 */

/** A one-field record carrying the format, with a protobuf field number. */
const sourceFor = (format: string, ts = 'number') => `
  export interface M {
    /**
     * @fieldNumber 1
     * @format ${format}
     */
    v: ${ts};
  }
`;

const validatorFor = (format: string, ts = 'number') =>
  evalModule<{ is: (v: unknown) => boolean; validate: (v: unknown) => any[] }>(
    generateValidatorCode(getIRForSource(sourceFor(format, ts), 'M'))
  );

beforeAll(() => {
  validatorFor('int32');
}, 60_000);

describe('a declared width is enforced', () => {
  test('the range of every integer format is rejected at both ends', () => {
    for (const [format, { min, max }] of Object.entries(INTEGER_FORMATS)) {
      // Wide formats are carried by a bigint, narrow ones by a number.
      const wide = max > 9007199254740991n;
      const validator = validatorFor(format, wide ? 'bigint' : 'number');
      const at = (v: bigint) => (wide ? v : Number(v));

      expect(validator.is({ v: at(min) })).toBe(true);
      expect(validator.is({ v: at(max) })).toBe(true);
      expect(validator.is({ v: at(min - 1n) })).toBe(false);
      expect(validator.is({ v: at(max + 1n) })).toBe(false);
    }
  });

  test('the value that used to wrap silently is refused', () => {
    // 3e9 exceeds int32 and is a perfectly ordinary JS number; before this it
    // reached the wire as -1294967296.
    const validator = validatorFor('int32');
    expect(validator.is({ v: 3_000_000_000 })).toBe(false);
    expect(validator.validate({ v: 3_000_000_000 })[0]).toMatchObject({
      path: 'v',
      constraint: 'format',
    });
  });

  test('a fractional value is not an integer, whatever the width', () => {
    expect(validatorFor('int32').is({ v: 1.5 })).toBe(false);
    expect(validatorFor('int8').is({ v: -0.5 })).toBe(false);
    expect(validatorFor('uint16').is({ v: 3.0 })).toBe(true);
  });

  test('a number beyond what a double states exactly is refused', () => {
    // int64 allows it, but a `number` cannot represent it, so the value is
    // already wrong before any codec sees it.
    expect(validatorFor('int64').is({ v: 9_007_199_254_740_993 })).toBe(false);
    // The same magnitude as a bigint is fine.
    expect(validatorFor('int64', 'bigint').is({ v: 9_007_199_254_740_993n })).toBe(true);
  });

  test('float and double stay unbounded, since they are not integers', () => {
    expect(validatorFor('double').is({ v: 1e300 })).toBe(true);
    expect(validatorFor('float').is({ v: 1.5 })).toBe(true);
  });
});

describe('the documents state the range too', () => {
  test('JSON Schema carries bounds beside the format', () => {
    const mod = evalModule<{ schema_draft2020: any }>(
      generateSchemaCode(getIRForSource(sourceFor('int8'), 'M'))
    );
    expect(mod.schema_draft2020.properties.v).toEqual({
      type: 'number',
      format: 'int8',
      minimum: -128,
      maximum: 127,
    });
  });

  test('a bound a JSON number cannot state exactly is left out', () => {
    const mod = evalModule<{ schema_draft2020: any }>(
      generateSchemaCode(getIRForSource(sourceFor('int64', 'bigint'), 'M'))
    );
    // Rounding 2^63 would admit or reject the wrong values, so neither bound is
    // claimed; the string form still pins the shape.
    expect(mod.schema_draft2020.properties.v.minimum).toBeUndefined();
    expect(mod.schema_draft2020.properties.v.maximum).toBeUndefined();
  });

  test('OpenAPI carries them as well', () => {
    const ir = getIRForSource(sourceFor('uint16'), 'M');
    const doc = evalModule<{ openapiSchema: (b?: unknown) => any }>(
      generateOpenApiSchemaCode([{ name: 'M', ir }], '3.1')
    ).openapiSchema({ openapi: '3.1.0', info: { title: 't', version: '1' }, paths: {} });

    expect(doc.components.schemas.M.properties.v).toMatchObject({
      format: 'uint16',
      minimum: 0,
      maximum: 65535,
    });
  });
});

describe('the widths the registry defines, on every wire', () => {
  const NARROW = ['int8', 'int16', 'uint8', 'uint16'] as const;

  test('protobuf carries narrow widths in the smallest type that holds them', () => {
    for (const format of NARROW) {
      const ir = getIRForSource(sourceFor(format), 'M');
      const text = evalModule<{ protobufSchema: (o?: any) => string }>(
        generateProtobufSchemaCode([{ name: 'M', ir }])
      ).protobufSchema();
      // protobuf has nothing narrower than 32 bits.
      expect(text).toContain(format.startsWith('u') ? 'uint32 v = 1;' : 'int32 v = 1;');
    }
  });

  test('protobuf.js reads every new width', () => {
    for (const [format, value] of [
      ['int8', -128],
      ['int16', -32768],
      ['uint8', 255],
      ['uint16', 65535],
      ['double-int', 9007199254740991],
      ['unixtime', 1_700_000_000],
      ['sf-integer', -999999999999999],
    ] as const) {
      const ir = getIRForSource(sourceFor(format), 'M');
      const codec = evalModule<any>(generateProtobufCode(ir));
      const proto = evalModule<any>(
        generateProtobufSchemaCode([{ name: 'M', ir }])
      ).protobufSchema();

      const buf = new Uint8Array(64);
      const n = codec.encodeProto({ v: value }, buf);
      const type = protobuf.parse(proto, { keepCase: true }).root.lookupType('M');
      const seen = type.toObject(type.decode(buf.subarray(0, n)), { longs: Number });
      expect(seen.v).toBe(value);
      // And wiz reads its own back as the same JS type.
      expect(codec.decodeProto(buf.subarray(0, n)).v).toBe(value);
    }
  });

  test('avsc reads every new width', () => {
    for (const [format, value] of [
      ['int8', -128],
      ['int16', 32767],
      ['uint8', 255],
      ['uint16', 65535],
      ['unixtime', 1_700_000_000],
      // avsc's long reader refuses 2^53-1 itself as "potential precision loss";
      // that boundary is covered by the validator, protobuf and arrow tests.
      ['double-int', 4503599627370496],
    ] as const) {
      const ir = getIRForSource(sourceFor(format), 'M');
      const codec = evalModule<any>(generateAvroCode(ir));
      const schemaText = evalModule<any>(generateAvroSchemaCode([{ name: 'M', ir }])).avroSchema();

      const buf = new Uint8Array(64);
      const n = codec.encodeAvro({ v: value }, buf);
      const type = avro.Type.forSchema(JSON.parse(schemaText));
      expect(type.fromBuffer(Buffer.from(buf.subarray(0, n)))).toEqual({ v: value });
      expect(codec.decodeAvro(buf.subarray(0, n))).toEqual({ v: value });
    }
  });

  test('arrow gets native narrow columns', () => {
    for (const [format, arrowType, value] of [
      ['int8', 'Int8', -128],
      ['int16', 'Int16', -32768],
      ['uint8', 'Uint8', 255],
      ['uint16', 'Uint16', 65535],
    ] as const) {
      const codec = evalModule<any>(generateArrowCode(getIRForSource(sourceFor(format), 'M')));
      const buf = new Uint8Array(1 << 15);
      const n = codec.encodeArrow([{ v: value }, { v: 0 }], buf);

      const table = A.tableFromIPC(buf.subarray(0, n));
      expect(String(table.schema.fields[0]!.type)).toBe(arrowType);
      expect(table.toArray().map((r: any) => r.v)).toEqual([value, 0]);
      expect(codec.decodeArrow(buf.subarray(0, n))).toEqual([{ v: value }, { v: 0 }]);
    }
  });

  test('a 64-bit width carried by a number stays a number', () => {
    // `double-int` is 64 bits on the wire and a `number` in JS; coming back as
    // a bigint would be a round-trip failure even with the right value.
    const codec = evalModule<any>(generateArrowCode(getIRForSource(sourceFor('double-int'), 'M')));
    const buf = new Uint8Array(1 << 15);
    const n = codec.encodeArrow([{ v: 9007199254740991 }], buf);

    const back = codec.decodeArrow(buf.subarray(0, n));
    expect(typeof back[0].v).toBe('number');
    expect(back[0].v).toBe(9007199254740991);

    const table = A.tableFromIPC(buf.subarray(0, n));
    expect(Number(table.toArray()[0].v)).toBe(9007199254740991);
  });

  test('a bigint width still comes back a bigint', () => {
    const codec = evalModule<any>(
      generateArrowCode(getIRForSource(sourceFor('int64', 'bigint'), 'M'))
    );
    const buf = new Uint8Array(1 << 15);
    const n = codec.encodeArrow([{ v: 9007199254740993n }], buf);
    const back = codec.decodeArrow(buf.subarray(0, n));
    expect(typeof back[0].v).toBe('bigint');
    expect(back[0].v).toBe(9007199254740993n);
  });
});
