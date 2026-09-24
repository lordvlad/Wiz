// @wiz-ignore
import { describe, expect, test } from 'bun:test';
import { generateVirtualModuleCode } from '../src/generators/virtualGenerator.ts';
import type { TypeIR } from '../src/ir/types.ts';
import { evalModule } from './helpers.ts';

const queryIR: TypeIR = {
  id: 'query',
  kind: 'object',
  properties: [
    {
      name: 'page',
      optional: true,
      readonly: false,
      type: { id: 'p1', kind: 'primitive', type: 'number' },
    },
    {
      name: 'active',
      optional: true,
      readonly: false,
      type: { id: 'p2', kind: 'primitive', type: 'boolean' },
    },
    {
      name: 'count',
      optional: true,
      readonly: false,
      type: { id: 'p3', kind: 'primitive', type: 'bigint' },
    },
    {
      name: 'created',
      optional: true,
      readonly: false,
      type: { id: 'p4', kind: 'primitive', type: 'date' },
    },
    {
      name: 'tags',
      optional: true,
      readonly: false,
      type: {
        id: 'p5',
        kind: 'array',
        element: { id: 'e1', kind: 'primitive', type: 'string' },
      },
    },
    {
      name: 'scores',
      optional: true,
      readonly: false,
      type: {
        id: 'p6',
        kind: 'array',
        element: { id: 'e2', kind: 'primitive', type: 'number' },
      },
    },
  ],
};

describe('parseQuery query string parsing and coercion', () => {
  const code = generateVirtualModuleCode(queryIR, { only: ['parseQuery', 'validate'] });
  const mod = evalModule<{
    parseQuery: (input: unknown, options?: unknown) => Record<string, unknown>;
    QueryValidationError: new (errors: unknown[]) => Error & { errors: unknown[] };
  }>(code);

  test('parses and coerces string query inputs', () => {
    const result = mod.parseQuery('?page=2&active=true&count=100&tags=a&scores=1&scores=2');
    expect(result.page).toBe(2);
    expect(result.active).toBe(true);
    expect(result.count).toBe(100n);
    expect(result.tags).toEqual(['a']);
    expect(result.scores).toEqual([1, 2]);
  });

  test('parses URLSearchParams input', () => {
    const params = new URLSearchParams('page=5&active=false');
    const result = mod.parseQuery(params);
    expect(result.page).toBe(5);
    expect(result.active).toBe(false);
  });

  test('parses raw record input', () => {
    const result = mod.parseQuery({ page: '10', active: '1' });
    expect(result.page).toBe(10);
    expect(result.active).toBe(true);
  });

  test('throws QueryValidationError on validation failure', () => {
    expect(() => mod.parseQuery('?page=invalid_number')).toThrow(mod.QueryValidationError);
  });
});
