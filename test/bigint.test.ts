// @wiz-ignore
import { describe, expect, test } from 'bun:test';
import { generateOpenApiSchemaCode } from '../src/generators/openapi.ts';
import { generateProtobufCode, generateProtobufSchemaCode } from '../src/generators/protobuf.ts';
import { generateSchemaCode } from '../src/generators/schema.ts';
import { generateValidatorCode } from '../src/generators/validator.ts';
import { evalModule, getIRForSource } from './helpers.ts';

const src = `
  export interface Ledger {
    /** @fieldNumber 1 */
    id: number;
    /** @fieldNumber 2 */
    amount: bigint;
  }
  export type Fixed = 9007199254740993n;
`;

const ledger = getIRForSource(src, 'Ledger');
const fixed = getIRForSource(src, 'Fixed');

describe('bigint extraction', () => {
  test('bigint is a primitive, bigint literals keep full precision', () => {
    if (ledger.kind !== 'object') {
      throw new Error('expected object');
    }
    const amount = ledger.properties.find((p) => p.name === 'amount')!;
    expect(amount.type).toMatchObject({ kind: 'primitive', type: 'bigint' });

    expect(fixed.kind).toBe('literal');
    if (fixed.kind === 'literal') {
      // Beyond Number.MAX_SAFE_INTEGER; a double would round this to ...992.
      expect(fixed.value).toBe(9007199254740993n);
    }
  });
});

describe('bigint documentation', () => {
  test('JSON Schema describes it as a numeric string, not a number', () => {
    const mod = evalModule<{ schema_draft2020: any; schema_draft07: any }>(
      generateSchemaCode(ledger)
    );
    for (const schema of [mod.schema_draft2020, mod.schema_draft07]) {
      // JSON numbers are doubles and JSON.stringify refuses BigInt outright,
      // so `type: integer` would describe a value that cannot be produced.
      expect(schema.properties.amount).toEqual({
        type: 'string',
        format: 'int64',
        pattern: '^-?\\d+$',
      });
    }
  });

  test('OpenAPI 3.0 and 3.1 agree on the string representation', () => {
    for (const version of ['3.0', '3.1'] as const) {
      const doc = evalModule<{ openapiSchema: () => any }>(
        generateOpenApiSchemaCode([{ name: 'Ledger', ir: ledger }], version)
      ).openapiSchema();
      expect(doc.components.schemas.Ledger.properties.amount).toEqual({
        type: 'string',
        format: 'int64',
        pattern: '^-?\\d+$',
      });
    }
  });

  test("a bigint literal's type and its constant value agree", () => {
    const js = evalModule<{ schema_draft2020: any }>(generateSchemaCode(fixed));
    // Previously `type: integer` with a string const — an unsatisfiable schema.
    expect(js.schema_draft2020.type).toBe('string');
    expect(js.schema_draft2020.const).toBe('9007199254740993');
    expect(typeof js.schema_draft2020.const).toBe('string');

    const oa = evalModule<{ openapiSchema: () => any }>(
      generateOpenApiSchemaCode([{ name: 'Fixed', ir: fixed }], '3.1')
    ).openapiSchema();
    expect(oa.components.schemas.Fixed.type).toBe('string');
    expect(oa.components.schemas.Fixed.enum).toEqual(['9007199254740993']);
  });

  test('the .proto schema keeps the native 64-bit type', () => {
    const proto = evalModule<{ protobufSchema: (o?: any) => string }>(
      generateProtobufSchemaCode([{ name: 'Ledger', ir: ledger }])
    ).protobufSchema();
    // protobuf has a real int64 on the wire, unlike JSON.
    expect(proto).toContain('int64 amount = 2;');
  });
});

describe('bigint validation', () => {
  const mod = evalModule<{ is: (a: unknown) => boolean }>(generateValidatorCode(ledger));

  test('validates the in-memory JS value, not the JSON shape', () => {
    expect(mod.is({ id: 1, amount: 5n })).toBe(true);
    // A number is not a bigint, even though both document as int64.
    expect(mod.is({ id: 1, amount: 5 })).toBe(false);
    expect(mod.is({ id: 1, amount: '5' })).toBe(false);
  });
});

describe('bigint protobuf wire format', () => {
  const mod = evalModule<{
    encodeProto: (v: any, b: Uint8Array) => number;
    decodeProto: (b: Uint8Array) => any;
  }>(generateProtobufCode(ledger));

  const roundtrip = (amount: bigint) => {
    const buf = new Uint8Array(64);
    const written = mod.encodeProto({ id: 1, amount }, buf);
    return mod.decodeProto(buf.subarray(0, written)).amount;
  };

  test('round-trips values beyond Number.MAX_SAFE_INTEGER exactly', () => {
    for (const value of [
      9007199254740993n, // 2^53 + 1: a double rounds this down
      9223372036854775807n, // int64 max
      1234567890123456789n,
    ]) {
      expect(roundtrip(value)).toBe(value);
    }
  });

  test('round-trips across the 2^31 boundary where bitwise ops truncate', () => {
    for (const value of [2147483647n, 2147483648n, 4294967296n, 68719476736n]) {
      expect(roundtrip(value)).toBe(value);
    }
  });

  test("round-trips negatives as two's complement", () => {
    for (const value of [-1n, -42n, -9223372036854775808n]) {
      expect(roundtrip(value)).toBe(value);
    }
  });

  test('decodes back to bigint, not number', () => {
    expect(typeof roundtrip(7n)).toBe('bigint');
  });

  test('plain number fields still decode as numbers', () => {
    const buf = new Uint8Array(64);
    const written = mod.encodeProto({ id: 4294967296, amount: 1n }, buf);
    const decoded = mod.decodeProto(buf.subarray(0, written));
    // Large int32-tagged values must survive too: `& 0x7f` used to truncate.
    expect(decoded.id).toBe(4294967296);
    expect(typeof decoded.id).toBe('number');
  });
});
