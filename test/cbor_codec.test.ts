// @wiz-ignore
import { describe, expect, test } from 'bun:test';
import { generateCborCode } from '../src/generators/cbor.ts';
import { silentLogger } from '../src/logger.ts';
import { transformSource } from '../src/plugin.ts';
import { getIRsForSource, evalModule } from './helpers.ts';

interface CborCodec {
  encodeCbor(val: unknown): Uint8Array;
  decodeCbor(raw: Uint8Array): unknown;
}

const irFor = (source: string, name: string) => getIRsForSource(source, [name])[name]!.ir;

const mod = evalModule<CborCodec>(generateCborCode(irFor('export type T = unknown;', 'T')));

const hex = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) =>
  new Uint8Array((s.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

describe('CBOR codec (encodeCbor / decodeCbor)', () => {
  test('encodes RFC 8949 Appendix A vectors byte-for-byte', () => {
    const cases: Array<[unknown, string]> = [
      [0, '00'],
      [23, '17'],
      [24, '1818'],
      [1000, '1903e8'],
      [1000000, '1a000f4240'],
      [-1, '20'],
      [-1000, '3903e7'],
      [1.5, 'fb3ff8000000000000'],
      [false, 'f4'],
      [true, 'f5'],
      [null, 'f6'],
      [undefined, 'f7'],
      ['', '60'],
      ['a', '6161'],
      ['IETF', '6449455446'],
      [new Uint8Array([1, 2, 3, 4]), '4401020304'],
      [[], '80'],
      [[1, 2, 3], '83010203'],
      [{}, 'a0'],
      [{ a: 1, b: [2, 3] }, 'a26161016162820203'],
      [18446744073709551616n, 'c249010000000000000000'],
      [-18446744073709551617n, 'c349010000000000000000'],
      [
        new Date('2013-03-21T20:04:00.000Z'),
        'c07818323031332d30332d32315432303a30343a30302e3030305a',
      ],
    ];

    for (const [input, expected] of cases) {
      expect(hex(mod.encodeCbor(input))).toBe(expected);
    }
  });

  test('decodes encodings the encoder never produces', () => {
    expect(mod.decodeCbor(unhex('f93e00'))).toBe(1.5);
    expect(mod.decodeCbor(unhex('5f42010243030405ff'))).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    expect(mod.decodeCbor(unhex('9f018202039f0405ffff'))).toEqual([1, [2, 3], [4, 5]]);

    const date = mod.decodeCbor(unhex('c074323031332d30332d32315432303a30343a30305a'));
    expect(date).toBeInstanceOf(Date);
    expect((date as Date).toISOString()).toBe('2013-03-21T20:04:00.000Z');
  });

  test('round-trips objects with dates, bigints and byte strings', () => {
    const value = {
      name: 'Bob',
      count: 42,
      at: new Date('2026-09-01T12:00:00.000Z'),
      big: 9007199254740993n,
      blob: new Uint8Array([9, 8, 7]),
    };

    const decoded = mod.decodeCbor(mod.encodeCbor(value)) as typeof value;
    expect(decoded).toEqual(value);
    expect(decoded.at).toBeInstanceOf(Date);
    expect(decoded.big).toBe(9007199254740993n);
    expect(decoded.blob).toBeInstanceOf(Uint8Array);
  });

  test('round-trips a Map with non-string keys as a Map', () => {
    const map = new Map<unknown, unknown>([
      [1, 'one'],
      ['k', 2],
    ]);

    const decoded = mod.decodeCbor(mod.encodeCbor(map));
    expect(decoded).toBeInstanceOf(Map);
    expect([...(decoded as Map<unknown, unknown>).entries()]).toEqual([...map.entries()]);
  });

  test('throws on values CBOR cannot represent', () => {
    expect(() => mod.encodeCbor(() => {})).toThrow(TypeError);
  });
});

describe('Plugin visitor rewrites for the CBOR codec', () => {
  test('rewrites encodeCbor and decodeCbor', () => {
    const source = `
      import { encodeCbor, decodeCbor } from "wiz";
      export interface Item { name: string }
      export const bin = encodeCbor<Item>({ name: "tool" });
      export const item = decodeCbor<Item>(bin);
    `;

    const result = transformSource({ path: 'app.ts', contents: source, logger: silentLogger });
    expect(result.code).toContain('encodeCbor as __wiz_encodeCbor_');
    expect(result.code).toContain('decodeCbor as __wiz_decodeCbor_');
    expect(result.code).toContain('= __wiz_encodeCbor_');
    expect(result.code).toContain('= __wiz_decodeCbor_');
  });
});
