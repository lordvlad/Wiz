// @wiz-ignore
import { describe, expect, test } from 'bun:test';
import { generateOpenApiSchemaCode } from '../src/generators/openapi.ts';
import { generateSchemaCode } from '../src/generators/schema.ts';
import { generateValidatorCode } from '../src/generators/validator.ts';
import { computeTypeIRHash } from '../src/types.ts';
import { evalModule, getIRForSource } from './helpers.ts';

const annotated = `
  export interface Account {
    /**
     * Contact address
     * @format email
     * @example "ada@example.com"
     * @example "grace@example.com"
     */
    email: string;

    /**
     * @default 7
     * @minimum 0
     */
    retries: number;

    /**
     * @default "anon"
     */
    label: string;

    /**
     * @example { "street": "Main St", "zip": "12345" }
     */
    address: { street: string; zip: string };

    /**
     * @since 1.4.0
     * @author Ada
     * @author Grace
     * @internal
     */
    secret: string;
  }
`;

describe('annotation extraction', () => {
  const ir = getIRForSource(annotated, 'Account');
  const prop = (name: string) => {
    if (ir.kind !== 'object') {
      throw new Error('expected object');
    }
    return ir.properties.find((p) => p.name === name)!;
  };

  test('@example collects every occurrence, JSON-parsed', () => {
    expect(prop('email').examples).toEqual(['ada@example.com', 'grace@example.com']);
    // Object literals survive as objects, not as text.
    expect(prop('address').examples).toEqual([{ street: 'Main St', zip: '12345' }]);
  });

  test('@default is an annotation, not a constraint', () => {
    expect(prop('retries').default).toBe(7);
    expect(prop('label').default).toBe('anon');
    // Only the validating tag remains in constraints.
    expect(prop('retries').constraints).toEqual([{ kind: 'minimum', value: 0 }]);
    expect(prop('label').constraints).toBeUndefined();
  });

  test('@format stays a constraint because it is enforced', () => {
    expect(prop('email').constraints).toEqual([{ kind: 'format', value: 'email' }]);
    expect(prop('email').description).toBe('Contact address');
  });
  test('unmodelled tags are preserved in meta, repeats included', () => {
    expect(prop('secret').meta).toEqual({
      since: ['1.4.0'],
      author: ['Ada', 'Grace'],
      internal: [true],
    });
  });

  test('consumed tags never leak into meta', () => {
    expect(prop('email').meta).toBeUndefined();
    expect(prop('retries').meta).toBeUndefined();
  });

  test('annotations participate in the structural hash', () => {
    const bare = getIRForSource(`export interface A { x: string }`, 'A');
    const withExample = getIRForSource(
      `export interface A {
        /** @example "hi" */
        x: string
      }`,
      'A'
    );
    // Otherwise two types differing only by docs would share a virtual module
    // and one set of examples would be silently lost.
    expect(computeTypeIRHash(bare)).not.toBe(computeTypeIRHash(withExample));
  });
});

describe('annotation emission', () => {
  const ir = getIRForSource(annotated, 'Account');

  test('JSON Schema emits default and an examples array in both drafts', () => {
    const mod = evalModule<{
      schema_draft2020: any;
      schema_draft07: any;
    }>(generateSchemaCode(ir));

    for (const schema of [mod.schema_draft2020, mod.schema_draft07]) {
      expect(schema.properties.retries.default).toBe(7);
      expect(schema.properties.email.examples).toEqual(['ada@example.com', 'grace@example.com']);
      expect(schema.properties.email.format).toBe('email');
      // meta is not a JSON Schema keyword and must not be emitted.
      expect(schema.properties.secret.since).toBeUndefined();
      expect(schema.properties.secret.meta).toBeUndefined();
    }
  });

  test('OpenAPI 3.0 uses singular example, 3.1 uses the examples array', () => {
    const doc30 = evalModule<{ openapiSchema: () => any }>(
      generateOpenApiSchemaCode([{ name: 'Account', ir }], '3.0')
    ).openapiSchema();
    const doc31 = evalModule<{ openapiSchema: () => any }>(
      generateOpenApiSchemaCode([{ name: 'Account', ir }], '3.1')
    ).openapiSchema();

    const p30 = doc30.components.schemas.Account.properties;
    const p31 = doc31.components.schemas.Account.properties;

    // OAS 3.0 Schema Objects carry `example`; 3.1 follows JSON Schema 2020-12.
    expect(p30.email.example).toBe('ada@example.com');
    expect(p30.email.examples).toBeUndefined();
    expect(p31.email.examples).toEqual(['ada@example.com', 'grace@example.com']);
    expect(p31.email.example).toBeUndefined();

    // default and format reach both dialects unchanged.
    for (const props of [p30, p31]) {
      expect(props.retries.default).toBe(7);
      expect(props.email.format).toBe('email');
    }
  });

  test('annotations do not become validation rules', () => {
    const mod = evalModule<{ is: (arg: unknown) => boolean }>(generateValidatorCode(ir));

    // `retries` has a default but is still required, and a value that differs
    // from the default is still valid.
    expect(
      mod.is({
        email: 'ada@example.com',
        retries: 99,
        label: 'x',
        address: { street: 'a', zip: 'b' },
        secret: 's',
      })
    ).toBe(true);

    // @format is enforced, unlike the annotations.
    expect(
      mod.is({
        email: 'not-an-email',
        retries: 1,
        label: 'x',
        address: { street: 'a', zip: 'b' },
        secret: 's',
      })
    ).toBe(false);
  });
});

describe('type level annotations', () => {
  test('a named type carries its own examples and meta', () => {
    const ir = getIRForSource(
      `
      /**
       * A user record
       * @example { "id": 1 }
       * @since 2.0.0
       */
      export interface User { id: number }
    `,
      'User'
    );

    expect(ir.examples).toEqual([{ id: 1 }]);
    expect(ir.meta).toEqual({ since: ['2.0.0'] });
    expect(ir.description).toBe('A user record');

    const doc = evalModule<{ openapiSchema: () => any }>(
      generateOpenApiSchemaCode([{ name: 'User', ir }], '3.1')
    ).openapiSchema();

    expect(doc.components.schemas.User.examples).toEqual([{ id: 1 }]);
    expect(doc.components.schemas.User.description).toBe('A user record');
  });
});
