// @wiz-ignore
import { beforeAll, describe, expect, test } from 'bun:test';
import * as A from 'apache-arrow';
import { plugin } from 'bun';
import { generateArrowCode, generateArrowSchemaCode } from '../src/generators/arrow.ts';
import { silentLogger } from '../src/logger.ts';
import { wizPlugin } from '../src/plugin.ts';
import { evalModule, getIRForSource } from './helpers.ts';

plugin(wizPlugin({ logger: silentLogger }));

/**
 * Arrow support.
 *
 * Arrow is columnar, so the unit is a table of rows rather than one record, and
 * a stream is a schema message plus record batches. The interesting assertions
 * are against `apache-arrow` itself: it reads what wiz writes, and wiz reads
 * what it writes.
 */

interface Codec {
  encodeArrow: (rows: unknown[], buf: Uint8Array, offset?: number) => number;
  decodeArrow: (buf: Uint8Array, offset?: number) => any[];
}

const codecFor = (source: string, name = 'M') =>
  evalModule<Codec>(generateArrowCode(getIRForSource(source, name)));

const schemaFor = (source: string, name = 'M') =>
  JSON.parse(
    evalModule<{ arrowSchema: (o?: unknown) => string }>(
      generateArrowSchemaCode([{ name, ir: getIRForSource(source, name) }])
    ).arrowSchema()
  );

function writeRows(codec: Codec, rows: unknown[]) {
  const buf = new Uint8Array(1 << 16);
  return buf.subarray(0, codec.encodeArrow(rows, buf));
}

// The first codec pays for loading apache-arrow and building a TypeScript
// program, which alone exceeds the default per-test timeout. Paid once here so
// no individual test is timing a cold start.
beforeAll(() => {
  codecFor(`export interface M { name: string }`);
}, 60_000);

const SCALARS = `
  export interface M {
    /** @format int32 */
    id: number;
    name: string;
    ok: boolean;
    ratio: number;
    /** @format float */
    approx: number;
    big: bigint;
    at: Date;
    blob: Uint8Array;
  }
`;

describe('the schema describes the columns', () => {
  test('each TypeScript type maps to an arrow column type', () => {
    const schema = schemaFor(SCALARS);
    expect(schema.fields.map((f: any) => [f.name, f.type])).toEqual([
      ['id', 'Int32'],
      ['name', 'Utf8'],
      ['ok', 'Bool'],
      ['ratio', 'Float64'],
      ['approx', 'Float32'],
      ['big', 'Int64'],
      ['at', 'TimestampMillisecond'],
      ['blob', 'Binary'],
    ]);
  });

  test('optional properties are nullable columns', () => {
    const schema = schemaFor(`
      export interface M {
        a: string;
        b?: string;
      }
    `);
    expect(schema.fields.map((f: any) => [f.name, f.nullable])).toEqual([
      ['a', false],
      ['b', true],
    ]);
  });

  test('nested shapes describe as list, struct and map', () => {
    const schema = schemaFor(`
      export interface Inner { a: string }
      export interface M {
        tags: string[];
        inner: Inner;
        counts: Record<string, number>;
      }
    `);
    const byName = Object.fromEntries(schema.fields.map((f: any) => [f.name, f]));
    expect(byName.tags.type).toBe('list');
    expect(byName.tags.children[0].name).toBe('item');
    expect(byName.inner.type).toBe('struct');
    // Arrow models a map as a list of a non-nullable entries struct.
    expect(byName.counts.type).toBe('map');
    expect(byName.counts.children[0].name).toBe('entries');
    expect(byName.counts.children[0].children.map((c: any) => c.name)).toEqual(['key', 'value']);
  });

  test('an enum and a same-typed literal union are both strings', () => {
    const schema = schemaFor(`
      export enum Role { Admin = "admin", User = "user" }
      export interface M {
        role: Role;
        mode: "read" | "write";
      }
    `);
    expect(schema.fields.map((f: any) => f.type)).toEqual(['Utf8', 'Utf8']);
  });
});

describe('apache-arrow reads what wiz writes', () => {
  test('every scalar column, at the widths @format selects', () => {
    const codec = codecFor(SCALARS);
    const rows = [
      {
        id: 1,
        name: 'a',
        ok: true,
        ratio: 1.5,
        approx: 0.5,
        big: 9007199254740993n,
        at: new Date(1000),
        blob: new Uint8Array([1, 2]),
      },
      {
        id: -2147483648,
        name: 'bb',
        ok: false,
        ratio: -0.25,
        approx: -1.5,
        big: -9007199254740993n,
        at: new Date(2000),
        blob: new Uint8Array([3]),
      },
      {
        id: 2147483647,
        name: '',
        ok: true,
        ratio: 0,
        approx: 0,
        big: 0n,
        at: new Date(0),
        blob: new Uint8Array([]),
      },
    ];

    const table = A.tableFromIPC(writeRows(codec, rows));
    expect(table.numRows).toBe(3);
    expect(table.schema.fields.map((f) => f.name)).toEqual([
      'id',
      'name',
      'ok',
      'ratio',
      'approx',
      'big',
      'at',
      'blob',
    ]);

    const seen = table.toArray().map((row: any) => ({
      id: row.id,
      name: row.name,
      ok: row.ok,
      ratio: row.ratio,
      approx: row.approx,
      big: String(row.big),
      at: Number(row.at),
      blob: [...row.blob],
    }));
    expect(seen).toEqual(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        ok: r.ok,
        ratio: r.ratio,
        approx: r.approx,
        big: String(r.big),
        at: r.at.getTime(),
        blob: [...r.blob],
      }))
    );
  });

  test('nulls, which Arrow carries in a validity bitmap', () => {
    const codec = codecFor(`
      export interface M {
        /** @format int32 */
        id?: number;
        name?: string;
        ok?: boolean;
      }
    `);
    const rows = [
      { id: 1, name: 'a', ok: true },
      { id: undefined, name: 'bb', ok: false },
      { id: 3, name: undefined, ok: undefined },
    ];

    const table = A.tableFromIPC(writeRows(codec, rows));
    expect(table.toArray().map((r: any) => [r.id, r.name, r.ok])).toEqual([
      [1, 'a', true],
      [null, 'bb', false],
      [3, null, null],
    ]);
    expect(table.getChild('id')!.nullCount).toBe(1);
    expect(table.getChild('ok')!.nullCount).toBe(1);
  });

  test('a column with no nulls writes no validity buffer', () => {
    const codec = codecFor(`
      export interface M {
        /** @format int32 */
        id: number;
      }
    `);
    const table = A.tableFromIPC(writeRows(codec, [{ id: 1 }, { id: 2 }]));
    expect(table.getChild('id')!.nullCount).toBe(0);
    expect(table.toArray().map((r: any) => r.id)).toEqual([1, 2]);
  });

  test('an empty table is still a valid stream', () => {
    const codec = codecFor(SCALARS);
    const table = A.tableFromIPC(writeRows(codec, []));
    expect(table.numRows).toBe(0);
    expect(table.schema.fields).toHaveLength(8);
  });

  test('many rows, so buffers cross their padding boundaries', () => {
    const codec = codecFor(`
      export interface M {
        /** @format int32 */
        id: number;
        name: string;
      }
    `);
    const rows = Array.from({ length: 257 }, (_, i) => ({
      id: i - 128,
      name: 'x'.repeat(i % 11),
    }));
    const table = A.tableFromIPC(writeRows(codec, rows));
    expect(table.numRows).toBe(257);
    expect(table.toArray().map((r: any) => [r.id, r.name])).toEqual(
      rows.map((r) => [r.id, r.name])
    );
  });

  test('multi-byte text is measured in bytes', () => {
    const codec = codecFor(`export interface M { name: string }`);
    const rows = [{ name: 'héllo' }, { name: '日本語' }, { name: '🎉' }];
    const table = A.tableFromIPC(writeRows(codec, rows));
    expect(table.toArray().map((r: any) => r.name)).toEqual(rows.map((r) => r.name));
  });
});

describe('wiz reads what apache-arrow writes', () => {
  test("scalars, including arrow's own buffer padding", () => {
    const codec = codecFor(`
      export interface M {
        /** @format int32 */
        id: number;
        name: string;
        ok: boolean;
      }
    `);
    const table = new A.Table({
      id: A.vectorFromArray([7, 8, 9], new A.Int32()),
      name: A.vectorFromArray(['x', 'yy', 'zzz'], new A.Utf8()),
      ok: A.vectorFromArray([true, false, true], new A.Bool()),
    });

    // Arrow pads buffers to 64 bytes where wiz pads to 8, so this only works if
    // the reader trusts the declared offsets rather than assuming a stride.
    expect(codec.decodeArrow(A.tableToIPC(table, 'stream'))).toEqual([
      { id: 7, name: 'x', ok: true },
      { id: 8, name: 'yy', ok: false },
      { id: 9, name: 'zzz', ok: true },
    ]);
  });

  test('nulls arrow chose to encode', () => {
    const codec = codecFor(`
      export interface M {
        /** @format int32 */
        id?: number;
        name?: string;
      }
    `);
    const table = new A.Table({
      id: A.vectorFromArray([1, null, 3], new A.Int32()),
      name: A.vectorFromArray([null, 'b', 'c'], new A.Utf8()),
    });
    expect(codec.decodeArrow(A.tableToIPC(table, 'stream'))).toEqual([
      { id: 1, name: null },
      { id: null, name: 'b' },
      { id: 3, name: 'c' },
    ]);
  });

  test('64-bit values keep their full range', () => {
    const codec = codecFor(`
      export interface M {
        /** @format int64 */
        big: bigint;
      }
    `);
    const table = new A.Table({
      big: A.vectorFromArray([9007199254740993n, -9007199254740993n], new A.Int64()),
    });
    expect(codec.decodeArrow(A.tableToIPC(table, 'stream'))).toEqual([
      { big: 9007199254740993n },
      { big: -9007199254740993n },
    ]);
  });
});

describe('what Arrow cannot carry is refused', () => {
  test('a nested column is described but not encoded yet', () => {
    const source = `
      export interface Inner { a: string }
      export interface M { inner: Inner }
    `;
    // The schema is complete; only the codec is limited.
    expect(schemaFor(source).fields[0].type).toBe('struct');

    const codec = codecFor(source);
    expect(() => codec.encodeArrow([{ inner: { a: 'x' } }], new Uint8Array(64))).toThrow(
      'only generated for flat columns'
    );
  });

  test('an unnumbered union is refused with the field named', () => {
    const codec = codecFor(`
      export interface M {
        value: string | number;
      }
    `);
    expect(() => codec.encodeArrow([], new Uint8Array(64))).toThrow("'M.value' is a union");
  });

  test('a type with no properties has no columns', () => {
    const codec = codecFor(`export interface M {}`);
    expect(() => codec.encodeArrow([], new Uint8Array(64))).toThrow('no properties');
  });
});

describe('arrow end-to-end through the plugin', () => {
  let fixture: typeof import('./fixtures/arrowFixture.ts');

  beforeAll(async () => {
    fixture = await import('./fixtures/arrowFixture.ts');
  });

  test('arrowSchema resolves to the column description', () => {
    const schema = JSON.parse(fixture.readingSchema);
    expect(schema.name).toBe('Reading');
    expect(schema.fields.map((f: any) => [f.name, f.type, f.nullable])).toEqual([
      ['sensor', 'Int32', false],
      ['station', 'Utf8', false],
      ['at', 'TimestampMillisecond', false],
      ['celsius', 'Float64', false],
      ['humidity', 'Float32', false],
      ['ok', 'Bool', false],
      ['sequence', 'Int64', false],
      ['payload', 'Binary', false],
      ['note', 'Utf8', true],
    ]);
  });

  test('rows round-trip, and apache-arrow agrees on the result', () => {
    const rows: import('./fixtures/arrowFixture.ts').Reading[] = [
      {
        sensor: 1,
        station: 'north',
        at: new Date('2024-03-01T00:00:00.000Z'),
        celsius: 21.5,
        humidity: 0.5,
        ok: true,
        sequence: 9007199254740993n,
        payload: new Uint8Array([1, 2, 3]),
        note: 'first',
      },
      {
        sensor: 2,
        station: 'south',
        at: new Date('2024-03-02T00:00:00.000Z'),
        celsius: -3.25,
        humidity: 0.75,
        ok: false,
        sequence: 2n,
        payload: new Uint8Array([]),
      },
    ];

    const buf = new Uint8Array(1 << 16);
    const written = fixture.encodeReadings(rows, buf);
    const stream = buf.subarray(0, written);

    const back = fixture.decodeReadings(stream);
    expect(back.map((r) => r.station)).toEqual(['north', 'south']);
    expect(back[0]!.sequence).toBe(9007199254740993n);
    expect(back[0]!.at.toISOString()).toBe('2024-03-01T00:00:00.000Z');
    expect(back[1]!.note).toBeNull();

    const table = A.tableFromIPC(stream);
    expect(table.numRows).toBe(2);
    expect(table.toArray().map((r: any) => r.station)).toEqual(['north', 'south']);
  });
});
