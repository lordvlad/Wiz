import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractApiIR } from '../src/extractors/openapi.ts';
import { generate } from '../src/generators/generator.ts';
import { tsClientGenerator } from '../src/generators/tsClient.ts';
import { silentLogger } from '../src/logger.ts';

describe('OpenAPI securitySchemes and Auth Providers in tsClient', () => {
  let tempDir: string;
  let apiPath: string;

  const SECURITY_DOC = JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'AuthPetStore', version: '1.0.0' },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
        apiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'x-api-key',
        },
        oauth2Auth: {
          type: 'oauth2',
          flows: {
            clientCredentials: {
              tokenUrl: 'https://auth.example.com/oauth/token',
              scopes: {
                'read:pets': 'Read pets',
                'write:pets': 'Write pets',
              },
            },
          },
        },
      },
      schemas: {
        Pet: {
          type: 'object',
          required: ['id', 'name'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
          },
        },
      },
    },
    paths: {
      '/pets/{petId}': {
        get: {
          operationId: 'getPet',
          parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'A pet',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
            },
          },
        },
      },
    },
  });

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'wiz-auth-test-'));
    const ir = extractApiIR(SECURITY_DOC, { format: 'json' });
    const files = generate(ir, tsClientGenerator, {}, silentLogger);
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(tempDir, name), content);
    }
    apiPath = join(tempDir, 'api.ts');
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('extractApiIR extracts components.securitySchemes into IR', () => {
    const ir = extractApiIR(SECURITY_DOC, { format: 'json' });
    expect(ir.components.securitySchemes.has('bearerAuth')).toBe(true);
    expect(ir.components.securitySchemes.has('apiKeyAuth')).toBe(true);
    expect(ir.components.securitySchemes.has('oauth2Auth')).toBe(true);

    const bearer = ir.components.securitySchemes.get('bearerAuth')!;
    expect(bearer.type).toBe('http');
    expect(bearer.scheme).toBe('bearer');

    const oauth2 = ir.components.securitySchemes.get('oauth2Auth')!;
    expect(oauth2.type).toBe('oauth2');
    expect(oauth2.flows?.clientCredentials?.tokenUrl).toBe('https://auth.example.com/oauth/token');
  });

  test('emits client with AuthConfig, setBearerToken, and setApiKey', () => {
    const ir = extractApiIR(SECURITY_DOC, { format: 'json' });
    const files = generate(ir, tsClientGenerator, {}, silentLogger);
    const apiSource = files['api.ts']!;

    expect(apiSource).toContain(
      'export type TokenProvider = string | (() => string | Promise<string>);'
    );
    expect(apiSource).toContain('export interface AuthConfig {');
    expect(apiSource).toContain('bearer?: TokenProvider;');
    expect(apiSource).toContain('apiKey?: TokenProvider;');
    expect(apiSource).toContain('setBearerToken(token: TokenProvider): void;');
    expect(apiSource).toContain('setApiKey(key: TokenProvider): void;');
    expect(apiSource).toContain('export function setBearerToken(token: TokenProvider): void {');
    expect(apiSource).toContain('export function setApiKey(key: TokenProvider): void {');
  });

  test('static Bearer token and dynamic TokenProvider inject Authorization headers at runtime', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const customFetch = async (url: string, init: any) => {
      calls.push({ url, headers: init.headers });
      return new Response(JSON.stringify({ id: 'p1', name: 'Ada' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const mod = await import(apiPath);

    // 1. Static Bearer token via config
    const clientStatic = mod.createClient({
      baseUrl: 'https://api.example.com',
      auth: { bearer: 'static-secret-token' },
      transport: customFetch,
    });

    await clientStatic.getPet({ petId: '1' });
    expect(calls[0]!.headers['authorization']).toBe('Bearer static-secret-token');

    // 2. Dynamic TokenProvider via setBearerToken
    const clientDynamic = mod.createClient({
      baseUrl: 'https://api.example.com',
      transport: customFetch,
    });

    let tokenCounter = 1;
    clientDynamic.setBearerToken(async () => `dynamic-jwt-${tokenCounter++}`);

    await clientDynamic.getPet({ petId: '2' });
    expect(calls[1]!.headers['authorization']).toBe('Bearer dynamic-jwt-1');

    await clientDynamic.getPet({ petId: '3' });
    expect(calls[2]!.headers['authorization']).toBe('Bearer dynamic-jwt-2');

    // 3. API Key via setApiKey
    const clientApiKey = mod.createClient({
      baseUrl: 'https://api.example.com',
      transport: customFetch,
    });
    clientApiKey.setApiKey('my-api-key-1234');
    await clientApiKey.getPet({ petId: '4' });
    expect(calls[3]!.headers['x-api-key']).toBe('my-api-key-1234');
  });

  test('createOAuth2ClientCredentialsProvider fetches and caches token', async () => {
    const mod = await import(apiPath);

    let tokenRequestCount = 0;
    const authFetch = async (_url: string, init: any) => {
      tokenRequestCount++;
      const body = new URLSearchParams(init.body);
      expect(body.get('grant_type')).toBe('client_credentials');
      expect(body.get('client_id')).toBe('test-client');
      expect(body.get('client_secret')).toBe('test-secret');

      return new Response(
        JSON.stringify({
          access_token: `oauth-token-${tokenRequestCount}`,
          token_type: 'Bearer',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };

    const provider = mod.createOAuth2ClientCredentialsProvider({
      tokenUrl: 'https://auth.example.com/oauth/token',
      clientId: 'test-client',
      clientSecret: 'test-secret',
      customFetch: authFetch,
    });

    const token1 = await provider();
    expect(token1).toBe('oauth-token-1');
    expect(tokenRequestCount).toBe(1);

    // Second call should return cached token
    const token2 = await provider();
    expect(token2).toBe('oauth-token-1');
    expect(tokenRequestCount).toBe(1);
  });

  test('createOAuth2AuthProvider refreshes token when needed', async () => {
    const mod = await import(apiPath);

    let refreshCount = 0;
    const authFetch = async (_url: string, init: any) => {
      refreshCount++;
      const body = new URLSearchParams(init.body);
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('refresh_token')).toBe('ref-123');

      return new Response(
        JSON.stringify({
          access_token: `new-access-token-${refreshCount}`,
          refresh_token: 'ref-123',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };

    const oauthAuth = mod.createOAuth2AuthProvider({
      tokenUrl: 'https://auth.example.com/oauth/token',
      clientId: 'test-client',
      refreshToken: 'ref-123',
      customFetch: authFetch,
    });

    const token = await oauthAuth.getToken();
    expect(token).toBe('new-access-token-1');
    expect(refreshCount).toBe(1);

    const refreshed = await oauthAuth.refreshToken();
    expect(refreshed).toBe('new-access-token-2');
    expect(refreshCount).toBe(2);
  });
});
