// @wiz-ignore
import { describe, expect, test } from 'bun:test';
import {
  validateSpecDocument,
  validateSpecDocumentSync,
  assertValidSpecDocumentSync,
} from '../src/validators/jsonSchema.ts';

describe('JSON Schema Validator Utility for OpenAPI, OpenRPC, and AsyncAPI', () => {
  test('validates OpenAPI 3.0 document', async () => {
    const doc = {
      openapi: '3.0.3',
      info: { title: 'PetStore', version: '1.0.0' },
      paths: {
        '/pets': {
          get: { responses: { '200': { description: 'ok' } } },
        },
      },
    };

    const resSync = validateSpecDocumentSync(doc);
    expect(resSync.valid).toBe(true);

    const resAsync = await validateSpecDocument(doc);
    expect(resAsync.valid).toBe(true);

    expect(() => assertValidSpecDocumentSync(doc, 'OpenAPI')).not.toThrow();
  });

  test('validates OpenAPI 3.1 document', async () => {
    const doc = {
      openapi: '3.1.0',
      info: { title: 'PetStore 3.1', version: '1.0.0' },
      paths: {},
    };

    const resSync = validateSpecDocumentSync(doc);
    expect(resSync.valid).toBe(true);

    const resAsync = await validateSpecDocument(doc);
    expect(resAsync.valid).toBe(true);

    expect(() => assertValidSpecDocumentSync(doc, 'OpenAPI')).not.toThrow();
  });

  test('validates OpenRPC 1.3 document', () => {
    const doc = {
      openrpc: '1.3.0',
      info: { title: 'RPC API', version: '1.0.0' },
      methods: [],
    };

    const resSync = validateSpecDocumentSync(doc);
    expect(resSync.valid).toBe(true);
    expect(() => assertValidSpecDocumentSync(doc, 'OpenRPC')).not.toThrow();
  });

  test('validates AsyncAPI 2.6 and 3.0 documents', () => {
    const doc26 = {
      asyncapi: '2.6.0',
      info: { title: 'Async 2.6', version: '1.0.0' },
      channels: {},
    };
    expect(validateSpecDocumentSync(doc26).valid).toBe(true);

    const doc30 = {
      asyncapi: '3.0.0',
      info: { title: 'Async 3.0', version: '1.0.0' },
      channels: {},
    };
    expect(validateSpecDocumentSync(doc30).valid).toBe(true);
  });

  test('validates JSON Schema Draft 2020-12 and Draft 07 documents', () => {
    const schema2020 = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { name: { type: 'string' } },
    };
    expect(validateSpecDocumentSync(schema2020).valid).toBe(true);
    expect(() => assertValidSpecDocumentSync(schema2020, 'JSON Schema')).not.toThrow();

    const schema07 = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { name: { type: 'string' } },
    };
    expect(validateSpecDocumentSync(schema07).valid).toBe(true);
    expect(() => assertValidSpecDocumentSync(schema07, 'JSON Schema')).not.toThrow();
  });

  test('rejects invalid document shapes with helpful errors', () => {
    const invalidDoc = {
      openapi: '3.0.0',
      // missing info object
    };

    const res = validateSpecDocumentSync(invalidDoc);
    expect(res.valid).toBe(false);
    expect(res.errors?.length).toBeGreaterThan(0);
    expect(() => assertValidSpecDocumentSync(invalidDoc, 'OpenAPI')).toThrow(
      /Generated OpenAPI document is invalid/
    );
  });

  test('rejects corrupt OpenAPI, OpenRPC, AsyncAPI and JSON Schema documents', () => {
    // Invalid OpenAPI 3.0: missing response description / invalid paths structure
    const corruptOpenApi = {
      openapi: '3.0.3',
      info: { title: 'API', version: '1.0.0' },
      paths: {
        '/test': {
          get: {
            responses: {
              '200': { description: 123 }, // description must be string
            },
          },
        },
      },
    };
    expect(validateSpecDocumentSync(corruptOpenApi).valid).toBe(false);
    expect(() => assertValidSpecDocumentSync(corruptOpenApi, 'OpenAPI')).toThrow(
      /Generated OpenAPI document is invalid/
    );

    // Invalid JSON Schema: invalid type keyword value
    const corruptJsonSchema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'not-a-valid-type',
    };
    expect(validateSpecDocumentSync(corruptJsonSchema).valid).toBe(false);
    expect(() => assertValidSpecDocumentSync(corruptJsonSchema, 'JSON Schema')).toThrow(
      /Generated JSON Schema document is invalid/
    );

    // Unrecognised document
    const unrecognisedDoc = { randomKey: 'randomValue' };
    expect(validateSpecDocumentSync(unrecognisedDoc).valid).toBe(false);
    expect(() => assertValidSpecDocumentSync(unrecognisedDoc, 'Unknown')).toThrow(
      /Generated Unknown document is invalid: Unrecognised spec document/
    );
  });
});
