// @wiz-ignore
import { describe, expect, test } from 'bun:test';
import Ajv07 from 'ajv';
import addFormats from 'ajv-formats';
import Ajv2020 from 'ajv/dist/2020.js';
import { generateOpenApiSchemaCode } from '../src/generators/openapi.ts';
import { generateSchemaCode } from '../src/generators/schema.ts';
import { generateValidatorCode } from '../src/generators/validator.ts';
import { evalModule, getIRForSource, getIRsForSource } from './helpers.ts';

/**
 * Interop against Ajv.
 *
 * wiz emits a schema *and* a validator from one IR, and until now nothing
 * checked that they agree: the schema could describe a shape the validator
 * would reject, and every wiz-only test would still pass. Ajv is the second
 * opinion, and the strongest assertion here is that the two verdicts match.
 */

/** Numeric widths come from the OpenAPI registry; Ajv should not enforce them. */
const ANNOTATION_FORMATS = [
  'int32',
  'int64',
  'uint32',
  'uint64',
  'sint32',
  'sint64',
  'fixed32',
  'fixed64',
  'sfixed32',
  'sfixed64',
  'float',
  'double',
  'byte',
  'binary',
];

function ajvFor(draft: '2020' | '07') {
  // strict: unknown keywords are a defect, not something to shrug at.
  const ajv = draft === '2020' ? new Ajv2020({ strict: true }) : new Ajv07({ strict: true });
  addFormats(ajv as never);
  for (const format of ANNOTATION_FORMATS) {
    ajv.addFormat(format, true);
  }
  return ajv;
}

interface Validator {
  validate: (value: unknown) => Array<{ path: string; message: string }>;
  is: (value: unknown) => boolean;
}

function schemasFor(source: string, root: string) {
  const ir = getIRForSource(source, root);
  const schema = evalModule<{ schema_draft2020: any; schema_draft07: any }>(generateSchemaCode(ir));
  const validator = evalModule<Validator>(generateValidatorCode(ir));
  return { ...schema, validator };
}

const USER = `
  export enum Role {
    Admin = "admin",
    User = "user",
  }
  export interface Address {
    /** @minLength 1 */
    street: string;
    zip: string;
  }
  export interface User {
    /** @format uuid */
    id: string;
    /** @format email */
    mail: string;
    /**
     * @minLength 2
     * @maxLength 8
     */
    name: string;
    /**
     * @minimum 0
     * @maximum 150
     * @multipleOf 2
     */
    age?: number;
    /**
     * @exclusiveMinimum 0
     * @exclusiveMaximum 10
     */
    score: number;
    /** @pattern ^[a-z]+$ */
    slug: string;
    /**
     * @minItems 1
     * @maxItems 3
     * @uniqueItems true
     */
    tags: string[];
    active: boolean;
    role: Role;
    address: Address;
    meta: Record<string, string>;
  }
`;

const valid = () => ({
  id: '3f0c2e64-6c1f-4b2f-9a1a-7c2c9a5f1b21',
  mail: 'ada@example.com',
  name: 'Ada',
  age: 36,
  score: 5,
  slug: 'ada',
  tags: ['x'],
  active: true,
  role: 'admin',
  address: { street: 'Main St', zip: '12345' },
  meta: { k: 'v' },
});

/** Each case is a mutation of a valid user, and whether it should still pass. */
const corpus: Array<{ label: string; value: unknown; ok: boolean }> = [
  { label: 'a fully valid user', value: valid(), ok: true },
  {
    label: 'the optional field omitted',
    value: (() => {
      const u: any = valid();
      delete u.age;
      return u;
    })(),
    ok: true,
  },
  {
    label: 'a missing required field',
    value: (() => {
      const u: any = valid();
      delete u.name;
      return u;
    })(),
    ok: false,
  },
  { label: 'a wrong primitive type', value: { ...valid(), active: 'yes' }, ok: false },
  { label: 'a number where a string belongs', value: { ...valid(), slug: 3 }, ok: false },
  { label: 'minLength violated', value: { ...valid(), name: 'A' }, ok: false },
  { label: 'maxLength violated', value: { ...valid(), name: 'Aloysius' }, ok: true },
  { label: 'maxLength exceeded', value: { ...valid(), name: 'Aloysius!' }, ok: false },
  { label: 'minimum violated', value: { ...valid(), age: -1 }, ok: false },
  { label: 'maximum violated', value: { ...valid(), age: 151 }, ok: false },
  { label: 'the boundary value', value: { ...valid(), age: 150 }, ok: true },
  { label: 'multipleOf violated', value: { ...valid(), age: 37 }, ok: false },
  { label: 'a malformed uuid', value: { ...valid(), id: 'not-a-uuid' }, ok: false },
  { label: 'a malformed email', value: { ...valid(), mail: 'nope' }, ok: false },
  { label: 'exclusiveMinimum hit exactly', value: { ...valid(), score: 0 }, ok: false },
  { label: 'exclusiveMaximum hit exactly', value: { ...valid(), score: 10 }, ok: false },
  { label: 'inside the exclusive range', value: { ...valid(), score: 9.5 }, ok: true },
  { label: 'duplicate array items', value: { ...valid(), tags: ['a', 'a'] }, ok: false },
  { label: 'an unknown extra property', value: { ...valid(), extra: 1 }, ok: true },
  { label: 'an optional set to null', value: { ...valid(), age: null }, ok: false },
  { label: 'pattern violated', value: { ...valid(), slug: 'Ada' }, ok: false },
  { label: 'minItems violated', value: { ...valid(), tags: [] }, ok: false },
  { label: 'maxItems violated', value: { ...valid(), tags: ['a', 'b', 'c', 'd'] }, ok: false },
  { label: 'a wrong array element type', value: { ...valid(), tags: [1] }, ok: false },
  { label: 'an enum value outside the set', value: { ...valid(), role: 'root' }, ok: false },
  { label: 'a nested field missing', value: { ...valid(), address: { zip: '1' } }, ok: false },
  {
    label: 'a nested constraint violated',
    value: { ...valid(), address: { street: '', zip: '1' } },
    ok: false,
  },
  { label: 'a map value of the wrong type', value: { ...valid(), meta: { k: 1 } }, ok: false },
  { label: 'not an object at all', value: 'nope', ok: false },
  { label: 'null', value: null, ok: false },
];

describe('generated schemas compile and behave under Ajv', () => {
  for (const draft of ['2020', '07'] as const) {
    describe(`draft ${draft === '2020' ? '2020-12' : '07'}`, () => {
      test('the schema compiles, so it has no unknown keywords', () => {
        const { schema_draft2020, schema_draft07 } = schemasFor(USER, 'User');
        const schema = draft === '2020' ? schema_draft2020 : schema_draft07;
        expect(() => ajvFor(draft).compile(schema)).not.toThrow();
      });

      test('Ajv reaches the expected verdict on every case', () => {
        const { schema_draft2020, schema_draft07 } = schemasFor(USER, 'User');
        const schema = draft === '2020' ? schema_draft2020 : schema_draft07;
        const check = ajvFor(draft).compile(schema);

        const disagreements = corpus
          .filter((entry) => check(entry.value) !== entry.ok)
          .map((entry) => entry.label);
        expect(disagreements).toEqual([]);
      });
    });
  }
});

describe("wiz's validator and Ajv agree", () => {
  test('on every case in the corpus', () => {
    const { schema_draft2020, validator } = schemasFor(USER, 'User');
    const check = ajvFor('2020').compile(schema_draft2020);

    const disagreements = corpus
      .filter((entry) => check(entry.value) !== validator.is(entry.value))
      .map((entry) => ({
        case: entry.label,
        ajv: check(entry.value),
        wiz: validator.is(entry.value),
      }));

    expect(disagreements).toEqual([]);
  });

  test('and wiz names the offending path when it rejects', () => {
    const { validator } = schemasFor(USER, 'User');
    const errors = validator.validate({ ...valid(), name: 'A' });
    expect(errors.map((e) => e.path)).toContain('name');
  });
});

describe('the schema describes the JSON shape, the validator the JS value', () => {
  // These deliberately differ for bigint: JSON has no 64-bit integer, so the
  // schema says string, while the validator checks the value in memory.
  const source = `
    export interface M {
      /** @format int64 */
      amount: bigint;
    }
  `;

  test('Ajv accepts the JSON form and wiz accepts the runtime form', () => {
    const { schema_draft2020, validator } = schemasFor(source, 'M');
    const check = ajvFor('2020').compile(schema_draft2020);

    expect(check({ amount: '9007199254740993' })).toBe(true);
    expect(check({ amount: 'nope' })).toBe(false);

    expect(validator.is({ amount: 9007199254740993n })).toBe(true);
    expect(validator.is({ amount: '9007199254740993' })).toBe(false);
  });
});

describe('OpenAPI component schemas validate instances', () => {
  test("a 3.1 document's schemas are usable JSON Schema", () => {
    const irs = getIRsForSource(USER, ['User', 'Address', 'Role']);
    const doc = evalModule<{ openapiSchema: (b?: unknown) => any }>(
      generateOpenApiSchemaCode(
        [
          { name: 'User', ir: irs.User.ir },
          { name: 'Address', ir: irs.Address.ir },
          { name: 'Role', ir: irs.Role.ir },
        ],
        '3.1'
      )
    ).openapiSchema({ openapi: '3.1.0', info: { title: 't', version: '1' } });

    // 3.1 schemas are JSON Schema 2020-12, $refs and all.
    const ajv = ajvFor('2020');
    for (const [name, schema] of Object.entries(doc.components.schemas)) {
      ajv.addSchema(schema as object, `#/components/schemas/${name}`);
    }
    const check = ajv.getSchema('#/components/schemas/User')!;

    const disagreements = corpus
      .filter((entry) => Boolean(check(entry.value)) !== entry.ok)
      .map((entry) => entry.label);
    expect(disagreements).toEqual([]);
  });
});
