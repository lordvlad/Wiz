// @wiz-ignore
import { beforeAll, describe, expect, test } from 'bun:test';
import { plugin } from 'bun';
import { silentLogger } from '../src/logger.ts';
import { wizPlugin } from '../src/plugin.ts';

plugin(wizPlugin({ logger: silentLogger }));

/** The README's headline example, asserted so the docs cannot drift from it. */
describe('README', () => {
  let fixture: typeof import('./fixtures/readmeFixture.ts');

  beforeAll(async () => {
    fixture = await import('./fixtures/readmeFixture.ts');
  });

  test('keysOf returns the declared keys', () => {
    expect(fixture.userKeys).toEqual(['id', 'name']);
  });

  test('is performs a real structural check', () => {
    expect(fixture.goodUser).toBe(true);
    expect(fixture.badUser).toBe(false);
  });

  test('schema is a draft-2020-12 document', () => {
    expect(fixture.userSchema).toEqual({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' } },
      required: ['id', 'name'],
    });
  });

  test('validate reports a path per failure', () => {
    expect(fixture.errors.map((e) => e.path)).toEqual(['id', 'name']);
  });

  test('nameOf narrows unknown payloads', () => {
    expect(fixture.nameOf({ id: '1', name: 'Ada' })).toBe('Ada');
    expect(fixture.nameOf({ id: 1, name: 'Ada' })).toBe('anonymous');
    expect(fixture.nameOf({ id: '2' })).toBe('anonymous');
    expect(fixture.nameOf(null)).toBe('anonymous');
  });
});
