// @wiz-ignore
import { describe, expect, test } from 'bun:test';
import { generateOpenApiSchemaCode } from '../src/generators/openapi.ts';
import {
  normalizeServiceMethod,
  type HttpServiceMethodIR,
  type ServiceIR,
  type ServiceMethodIR,
} from '../src/ir/service.ts';
import type { TypeIR } from '../src/types.ts';
import { evalModule, getIRsForSource, params } from './helpers.ts';

const sourceCode = `
  export interface User { id: number; name: string }
  export interface NotFound { message: string }
  export interface ValidationError { field: string; reason: string }
  export interface NewUser { name: string }
  export type PathParams = { id: number };
`;

describe('ServiceIR shape', () => {
  test('a method reads as address / request / responses', () => {
    const irs = getIRsForSource(sourceCode, ['User', 'PathParams']);

    const method: ServiceMethodIR = {
      kind: 'serviceMethod',
      protocol: 'http',
      address: { protocol: 'http', method: 'GET', path: '/users/{id}' },
      request: {
        protocol: 'http',
        parameters: params(irs.PathParams.ir, 'path'),
      },
      responses: [
        {
          protocol: 'http',
          status: 200,
          body: [{ mimetype: 'application/json', content: irs.User.ir }],
        },
      ],
    };

    // The discriminators are what make a method narrowable on its own.
    expect(method.kind).toBe('serviceMethod');
    expect(method.address.protocol).toBe('http');
    expect(method.request.protocol).toBe('http');
    expect(method.responses[0]!.protocol).toBe('http');

    // Sub-IRs stay self-describing when passed around detached.
    const address = method.address;
    expect(address).toEqual({
      protocol: 'http',
      method: 'GET',
      path: '/users/{id}',
    });
  });
});

describe('capabilities the flat operation IR could not express', () => {
  test('several status codes on one method', () => {
    const irs = getIRsForSource(sourceCode, ['User', 'NotFound', 'ValidationError', 'PathParams']);

    const svc: ServiceIR = {
      kind: 'service',
      methods: [
        {
          kind: 'serviceMethod',
          protocol: 'http',
          address: { protocol: 'http', method: 'GET', path: '/users/{id}' },
          request: {
            protocol: 'http',
            parameters: params(irs.PathParams.ir, 'path'),
          },
          responses: [
            {
              protocol: 'http',
              status: 200,
              body: [{ mimetype: 'application/json', content: irs.User.ir }],
            },
            {
              protocol: 'http',
              status: 404,
              description: 'No such user',
              body: [{ mimetype: 'application/json', content: irs.NotFound.ir }],
            },
            {
              protocol: 'http',
              status: 'default',
              description: 'Unexpected error',
              body: [
                {
                  mimetype: 'application/json',
                  content: irs.ValidationError.ir,
                },
              ],
            },
          ],
        },
      ],
    };

    const doc = evalModule<{ openapiSchema: () => any }>(
      generateOpenApiSchemaCode([], '3.1', svc)
    ).openapiSchema();

    const responses = doc.paths['/users/{id}'].get.responses;
    expect(Object.keys(responses).sort()).toEqual(['200', '404', 'default']);
    expect(responses['404'].description).toBe('No such user');
    expect(responses['404'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/NotFound',
    });
    expect(responses.default.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/ValidationError',
    });

    // Every referenced type is hoisted, including error-only ones. Parameters
    // are a flat list of individual types, so the `PathParams` alias that used
    // to wrap them is no longer part of the IR and is not hoisted.
    expect(Object.keys(doc.components.schemas).sort()).toEqual([
      'NotFound',
      'User',
      'ValidationError',
    ]);
  });

  test('several media types on one payload', () => {
    const irs = getIRsForSource(sourceCode, ['User', 'NewUser']);

    const svc: ServiceIR = {
      kind: 'service',
      methods: [
        {
          kind: 'serviceMethod',
          protocol: 'http',
          address: { protocol: 'http', method: 'POST', path: '/users' },
          request: {
            protocol: 'http',
            body: [
              { mimetype: 'application/json', content: irs.NewUser.ir },
              { mimetype: 'application/x-www-form-urlencoded', content: irs.NewUser.ir },
            ],
          },
          responses: [
            {
              protocol: 'http',
              status: 201,
              body: [{ mimetype: 'application/json', content: irs.User.ir }],
            },
          ],
        },
      ],
    };

    const doc = evalModule<{ openapiSchema: () => any }>(
      generateOpenApiSchemaCode([], '3.1', svc)
    ).openapiSchema();

    const post = doc.paths['/users'].post;
    expect(Object.keys(post.requestBody.content).sort()).toEqual([
      'application/json',
      'application/x-www-form-urlencoded',
    ]);
    expect(Object.keys(post.responses)).toEqual(['201']);
  });

  test('header and cookie parameters', () => {
    const irs = getIRsForSource(
      `
      export type Headers = { "x-request-id": string };
      export type Cookies = { session?: string };
    `,
      ['Headers', 'Cookies']
    );

    const svc: ServiceIR = {
      kind: 'service',
      methods: [
        {
          kind: 'serviceMethod',
          protocol: 'http',
          address: { protocol: 'http', method: 'GET', path: '/ping' },
          request: {
            protocol: 'http',
            parameters: [...params(irs.Headers.ir, 'header'), ...params(irs.Cookies.ir, 'cookie')],
          },
          responses: [{ protocol: 'http', status: 204 }],
        },
      ],
    };

    const doc = evalModule<{ openapiSchema: () => any }>(
      generateOpenApiSchemaCode([], '3.1', svc)
    ).openapiSchema();

    expect(doc.paths['/ping'].get.parameters).toEqual([
      { name: 'x-request-id', in: 'header', required: true, schema: { type: 'string' } },
      { name: 'session', in: 'cookie', required: false, schema: { type: 'string' } },
    ]);
  });

  test('method level metadata reaches the operation object', () => {
    const irs = getIRsForSource(sourceCode, ['User']);

    const doc = evalModule<{ openapiSchema: () => any }>(
      generateOpenApiSchemaCode([], '3.1', {
        kind: 'service',
        methods: [
          {
            kind: 'serviceMethod',
            protocol: 'http',
            address: { protocol: 'http', method: 'GET', path: '/users' },
            request: { protocol: 'http' },
            responses: [
              {
                protocol: 'http',
                status: 200,
                body: [{ mimetype: 'application/json', content: irs.User.ir }],
              },
            ],
            operationId: 'listUsers',
            summary: 'List users',
            tags: ['User'],
            deprecated: true,
          },
        ],
      })
    ).openapiSchema();

    const get = doc.paths['/users'].get;
    expect(get.operationId).toBe('listUsers');
    expect(get.summary).toBe('List users');
    expect(get.tags).toEqual(['User']);
    expect(get.deprecated).toBe(true);
  });
});

/**
 * The registry keys virtual modules on this projection, so anything the
 * operation object renders has to separate two methods that differ in it.
 */
describe('service method key coverage', () => {
  const payload: TypeIR = { id: 's_1', kind: 'primitive', type: 'string' };
  const base: HttpServiceMethodIR = {
    kind: 'serviceMethod',
    protocol: 'http',
    address: { protocol: 'http', method: 'GET', path: '/users' },
    request: {
      protocol: 'http',
      parameters: [{ name: 'q', in: 'query', required: false, type: payload }],
      body: [{ mimetype: 'application/json', content: payload }],
    },
    responses: [
      {
        protocol: 'http',
        status: 200,
        body: [{ mimetype: 'application/json', content: payload }],
      },
    ],
  };

  const key = (over: Partial<HttpServiceMethodIR> = {}): string =>
    JSON.stringify(normalizeServiceMethod({ ...base, ...over }));
  const bare = key();

  test('operation metadata is part of the key', () => {
    expect(key({ operationId: 'listUsers' })).not.toBe(bare);
    expect(key({ summary: 'List users' })).not.toBe(bare);
    expect(key({ description: 'Lists every user' })).not.toBe(bare);
    expect(key({ tags: ['User'] })).not.toBe(bare);
    expect(key({ deprecated: true })).not.toBe(bare);
  });

  test('request and response detail is part of the key', () => {
    expect(key({ request: { ...base.request, bodyRequired: false } })).not.toBe(bare);
    expect(
      key({
        request: {
          ...base.request,
          parameters: [{ ...base.request.parameters![0]!, description: 'search' }],
        },
      })
    ).not.toBe(bare);
    expect(
      key({
        request: {
          ...base.request,
          parameters: [{ ...base.request.parameters![0]!, deprecated: true }],
        },
      })
    ).not.toBe(bare);
    expect(key({ responses: [{ ...base.responses[0]!, description: 'the users' }] })).not.toBe(
      bare
    );
  });

  test("a payload's component name is part of the key", () => {
    const named = (name: string): HttpServiceMethodIR => ({
      ...base,
      responses: [
        {
          protocol: 'http',
          status: 200,
          body: [
            {
              mimetype: 'application/json',
              content: { id: 'o_1', kind: 'object', name, properties: [] },
            },
          ],
        },
      ],
    });

    expect(JSON.stringify(normalizeServiceMethod(named('User')))).not.toBe(
      JSON.stringify(normalizeServiceMethod(named('Admin')))
    );
  });

  test('two methods describing the same call still share a key', () => {
    const twin: ServiceMethodIR = {
      kind: 'serviceMethod',
      protocol: 'http',
      address: { protocol: 'http', method: 'GET', path: '/users' },
      request: {
        protocol: 'http',
        parameters: [{ name: 'q', in: 'query', required: false, type: payload }],
        body: [{ mimetype: 'application/json', content: payload }],
      },
      responses: [
        {
          protocol: 'http',
          status: 200,
          body: [{ mimetype: 'application/json', content: payload }],
        },
      ],
    };

    expect(JSON.stringify(normalizeServiceMethod(twin))).toBe(bare);
  });
});
