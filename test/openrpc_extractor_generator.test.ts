import { describe, expect, test } from 'bun:test';
import { extractOpenRpcIR } from '../src/extractors/openrpc.ts';
import { generateOpenRpcSchemaCode } from '../src/generators/openrpc.ts';
import { isOpenRpcMethod } from '../src/ir/service.ts';
import type { TypeIR } from '../src/ir/types.ts';
import { silentLogger } from '../src/logger.ts';
import { transformSource } from '../src/plugin.ts';
import { evalModule } from './helpers.ts';
describe('OpenRPC Extractor & Generator', () => {
  test('extractOpenRpcIR extracts ApiIR from OpenRPC document', () => {
    const doc = JSON.stringify({
      openrpc: '1.3.0',
      info: {
        title: 'User Service',
        version: '1.0.0',
        description: 'API for managing users',
      },
      methods: [
        {
          name: 'UserService.getUser',
          summary: 'Get a user by ID',
          params: [
            {
              name: 'id',
              required: true,
              schema: { type: 'string' },
            },
          ],
          result: {
            name: 'result',
            schema: { $ref: '#/components/schemas/User' },
          },
          paramStructure: 'by-name',
        },
      ],
      components: {
        schemas: {
          User: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
            },
            required: ['id', 'name'],
          },
        },
      },
    });

    const apiIR = extractOpenRpcIR(doc);
    expect(apiIR.kind).toBe('api');
    expect(apiIR.version).toBe('openrpc-1.3');
    expect(apiIR.service.name).toBe('User Service');
    expect(apiIR.service.version).toBe('1.0.0');
    expect(apiIR.types.has('User')).toBe(true);

    expect(apiIR.service.methods.length).toBe(1);
    const method = apiIR.service.methods[0]!;
    // The guard is the seam the IR provides for this: address, request and
    // responses all follow from `protocol`, so narrow once and read them.
    if (!isOpenRpcMethod(method)) {
      throw new Error('expected an OpenRPC method');
    }

    expect(method.protocol).toBe('openrpc');
    expect(method.address.service).toBe('UserService');
    expect(method.address.method).toBe('getUser');
    expect(method.request.protocol).toBe('openrpc');
    expect(method.request.params.length).toBe(1);
    expect(method.request.params[0]!.name).toBe('id');
    expect(method.request.paramsByName).toBe(true);
  });

  test('generateOpenRpcSchemaCode produces code building OpenRPC 1.3 spec', () => {
    const userTypeIR: TypeIR = {
      id: 'User1',
      kind: 'object',
      name: 'User',
      properties: [
        {
          name: 'id',
          type: { id: 'p1', kind: 'primitive', type: 'string' },
          optional: false,
          readonly: false,
        },
        {
          name: 'name',
          type: { id: 'p2', kind: 'primitive', type: 'string' },
          optional: false,
          readonly: false,
        },
      ],
    };

    const code = generateOpenRpcSchemaCode([{ name: 'User', ir: userTypeIR }], {
      kind: 'service',
      name: 'Test API',
      version: '2.0.0',
      methods: [],
    });

    expect(code).toContain('export function openRPCSchema');
    expect(code).toContain('openrpc: "1.3.0"');
    expect(code).toContain('rpc.discover');

    // Evaluate code function to test buildOpenRpcDocument output
    const fn = new Function(
      `${code.replace(/export function/g, 'function')}; return openRPCSchema();`
    );
    const result = fn() as Record<string, unknown>;

    expect(result.openrpc).toBe('1.3.0');
    const info = result.info as Record<string, string>;
    expect(info.title).toBe('Test API');
    expect(info.version).toBe('2.0.0');

    const components = result.components as Record<string, Record<string, unknown>>;
    expect(components.schemas?.User).toBeDefined();
  });
  test('transforms openRPCSchema with function signature types', () => {
    const source = `
      import { openRPCSchema } from "./src/index.ts";

      /**
       * Get user by ID
       * @rpc
       * @name get_user_op
       */
      function getUser(id: string): Promise<{ id: string; name: string }> {
        return Promise.resolve({ id, name: "Alice" });
      }

      export const schema = openRPCSchema<[typeof getUser]>();
    `;

    const res = transformSource({ path: 'test.ts', contents: source, logger: silentLogger });
    expect(res.code).toContain('openRPCSchema as __wiz_openRPCSchema_');

    const virtualModule = Array.from(res.modules.values())[0]!;
    const code = virtualModule.files['index.js']!;
    const mod = evalModule<{ openRPCSchema: (base?: any) => any }>(code);
    const doc = mod.openRPCSchema();

    expect(doc).toBeDefined();
    expect(doc.methods).toBeDefined();
    const m = doc.methods.find((m: any) => m.name === 'get_user_op');
    expect(m).toBeDefined();
    expect(m.params.length).toBe(1);
    expect(m.params[0].name).toBe('id');
  });

  test('transforms openRPCSchema with service object types and namespacing', () => {
    const source = `
      import { openRPCSchema } from "./src/index.ts";

      interface UserService {
        /** @rpc */
        getUser(id: string): Promise<{ id: string }>;
        /**
         * @rpc
         * @name search_users_override
         */
        searchUsers(query: string): Promise<Array<{ id: string }>>;
      }

      export const schema = openRPCSchema<[UserService]>();
    `;

    const res = transformSource({ path: 'test.ts', contents: source, logger: silentLogger });
    const virtualModule = Array.from(res.modules.values())[0]!;
    const code = virtualModule.files['index.js']!;
    const mod = evalModule<{ openRPCSchema: (base?: any) => any }>(code);
    const doc = mod.openRPCSchema();

    expect(doc.methods).toBeDefined();
    expect(doc.methods.some((m: any) => m.name === 'UserService.getUser')).toBe(true);
    expect(doc.methods.some((m: any) => m.name === 'search_users_override')).toBe(true);
  });

  test('emits compiler warning when object type with 0 methods is passed to openRPCSchema', () => {
    const source = `
      import { openRPCSchema } from "./src/index.ts";

      interface EmptyService {
        name: string;
      }

      export const schema = openRPCSchema<[EmptyService]>();
    `;
    const warnings: string[] = [];
    const testLogger = {
      warn: (msg: string) => warnings.push(msg),
      error: () => {},
      info: () => {},
      debug: () => {},
      trace: () => {},
    };

    transformSource({ path: 'test.ts', contents: source, logger: testLogger });
    expect(
      warnings.some((w) =>
        w.includes("no methods found on object type 'EmptyService' for openRPCSchema")
      )
    ).toBe(true);
  });
});
