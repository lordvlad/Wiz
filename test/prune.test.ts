// @wiz-ignore
import { describe, expect, test } from 'bun:test';
import { generateValidatorCode } from '../src/generators/validator.ts';
import type { TypeIR } from '../src/ir/types.ts';
import { evalModule } from './helpers.ts';

const str = (id: string): TypeIR => ({ id, kind: 'primitive', type: 'string' });

const ir: TypeIR = {
  id: 'root',
  kind: 'object',
  properties: [
    { name: 'id', optional: false, readonly: false, type: str('p1') },
    {
      name: 'nested',
      optional: true,
      readonly: false,
      type: {
        id: 'n',
        kind: 'object',
        properties: [{ name: 'keep', optional: false, readonly: false, type: str('p2') }],
      },
    },
    {
      name: 'open',
      optional: true,
      readonly: false,
      type: {
        id: 'o',
        kind: 'object',
        properties: [{ name: 'declared', optional: false, readonly: false, type: str('p3') }],
        additionalProperties: str('p4'),
      },
    },
  ],
};

describe('in-place pruning of undeclared fields in validate', () => {
  const makeInput = () => ({
    id: 'x',
    extra: 1,
    alsoExtra: 'y',
    nested: { keep: 'k', junk: true },
    open: { declared: 'd', allowed: 'a' },
  });

  test('without prune: true, undeclared fields remain', () => {
    const { validate } = evalModule<{ validate: (v: unknown, o?: unknown) => unknown[] }>(
      generateValidatorCode(ir)
    );
    const input = makeInput();
    expect(validate(input)).toEqual([]);
    expect(Object.keys(input)).toEqual(['id', 'extra', 'alsoExtra', 'nested', 'open']);
  });

  test('with prune: true, undeclared fields are removed in place for closed schemas', () => {
    const { validate } = evalModule<{ validate: (v: unknown, o?: unknown) => unknown[] }>(
      generateValidatorCode(ir)
    );
    const input = makeInput();
    expect(validate(input, { prune: true })).toEqual([]);
    expect(Object.keys(input)).toEqual(['id', 'nested', 'open']);
    expect(Object.keys(input.nested)).toEqual(['keep']);
    // open schema allows additionalProperties, so 'allowed' is retained
    expect(Object.keys(input.open)).toEqual(['declared', 'allowed']);
  });

  test('options.path is still supported alongside prune', () => {
    const { validate } = evalModule<{ validate: (v: unknown, o?: unknown) => unknown[] }>(
      generateValidatorCode(ir)
    );
    const errors = validate({}, { path: 'root', prune: true }) as { path: string }[];
    expect(errors[0]!.path).toBe('root.id');
  });

  test('legacy string second argument for path is still supported', () => {
    const { validate } = evalModule<{ validate: (v: unknown, o?: unknown) => unknown[] }>(
      generateValidatorCode(ir)
    );
    const errors = validate({}, 'legacy') as { path: string }[];
    expect(errors[0]!.path).toBe('legacy.id');
  });
});
