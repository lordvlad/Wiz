// @wiz-ignore
import { describe, expect, test } from 'bun:test';
import { silentLogger } from '../src/logger.ts';
import { transformSource } from '../src/plugin.ts';
import { evalModule } from './helpers.ts';

const TIMEOUT = 30_000;

interface SchemaModule {
  jsonSchema_draft2020: Record<string, any>;
  jsonSchema_draft07: Record<string, any>;
  jsonSchemas_draft2020: Record<string, any>;
  jsonSchemas_draft07: Record<string, any>;
}

function compile(source: string): SchemaModule {
  const result = transformSource({ path: 'app.ts', contents: source, logger: silentLogger });
  const emitted = Array.from(result.modules.values())[0]!;
  return evalModule<SchemaModule>(emitted.files['index.js']!);
}

describe('jsonSchema and jsonSchemas macros', () => {
  test(
    'jsonSchema generates draft 2020-12 and draft-07 single schemas',
    () => {
      const mod = compile(`
      import { jsonSchema } from "../../src/index.ts";
      export interface User {
        id: string;
        age?: number;
      }
      export const s1 = jsonSchema<User>();
      export const s2 = jsonSchema<User>("draft-07");
    `);

      expect(mod.jsonSchema_draft2020.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(mod.jsonSchema_draft2020.type).toBe('object');
      expect(mod.jsonSchema_draft2020.properties.id.type).toBe('string');

      expect(mod.jsonSchema_draft07.$schema).toBe('http://json-schema.org/draft-07/schema#');
      expect(mod.jsonSchema_draft07.type).toBe('object');
    },
    TIMEOUT
  );

  test(
    'jsonSchemas generates metaschema document with $defs for draft 2020-12',
    () => {
      const mod = compile(`
      import { jsonSchemas } from "../../src/index.ts";
      export interface User {
        id: string;
        name: string;
      }
      export interface Product {
        sku: string;
        price: number;
      }
      export const doc = jsonSchemas<[User, Product]>();
    `);

      const doc = mod.jsonSchemas_draft2020;
      expect(doc.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(doc.$defs).toBeDefined();
      expect(doc.$defs.User).toBeDefined();
      expect(doc.$defs.User.type).toBe('object');
      expect(doc.$defs.User.properties.id.type).toBe('string');
      expect(doc.$defs.Product).toBeDefined();
      expect(doc.$defs.Product.properties.sku.type).toBe('string');
    },
    TIMEOUT
  );

  test(
    'jsonSchemas generates metaschema document with definitions for draft-07',
    () => {
      const mod = compile(`
      import { jsonSchemas } from "../../src/index.ts";
      export interface User {
        id: string;
      }
      export interface Product {
        sku: string;
      }
      export const doc = jsonSchemas<[User, Product]>("draft-07");
    `);

      const doc = mod.jsonSchemas_draft07;
      expect(doc.$schema).toBe('http://json-schema.org/draft-07/schema#');
      expect(doc.definitions).toBeDefined();
      expect(doc.definitions.User).toBeDefined();
      expect(doc.definitions.Product).toBeDefined();
    },
    TIMEOUT
  );

  test(
    'jsonSchemas collects transitive referenced types into $defs',
    () => {
      const mod = compile(`
      import { jsonSchemas } from "../../src/index.ts";
      export interface Address {
        street: string;
      }
      export interface User {
        id: string;
        address: Address;
      }
      export const doc = jsonSchemas<[User]>();
    `);

      const doc = mod.jsonSchemas_draft2020;
      expect(doc.$defs.User).toBeDefined();
      expect(doc.$defs.Address).toBeDefined();
      expect(doc.$defs.User.properties.address.type).toBe('object');
    },
    TIMEOUT
  );
});
