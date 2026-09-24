// @wiz-ignore
import { describe, expect, test } from 'bun:test';
import { generateErlangTextCode, generateErlangBinaryCode } from '../src/generators/erlang.ts';
import { silentLogger } from '../src/logger.ts';
import { transformSource } from '../src/plugin.ts';
import { getIRsForSource, evalModule } from './helpers.ts';

interface ErlangTextCodec {
  encodeErlangText(val: unknown, indent?: string | number): string;
  decodeErlangText(raw: string): unknown;
}

interface ErlangBinaryCodec {
  encodeErlangBinary(val: unknown): Uint8Array;
  decodeErlangBinary(raw: Uint8Array): unknown;
}

const irFor = (source: string, name: string) => getIRsForSource(source, [name])[name]!.ir;

describe('Erlang Text Codec (encodeErlangText / decodeErlangText)', () => {
  test('encodes and decodes primitive values and atoms', () => {
    const ir = irFor('export type T = unknown;', 'T');
    const code = generateErlangTextCode(ir);
    const mod = evalModule<ErlangTextCodec>(code);

    // Colon-prefixed strings become atoms
    expect(mod.encodeErlangText(':ok')).toBe('ok');
    expect(mod.encodeErlangText(':error')).toBe('error');
    expect(mod.encodeErlangText(':foo_bar')).toBe('foo_bar');
    expect(mod.encodeErlangText(':Foo Bar')).toBe("'Foo Bar'");

    // Plain strings become double-quoted Erlang strings
    expect(mod.encodeErlangText('hello')).toBe('"hello"');

    // Decoding atoms produces colon-prefixed strings
    expect(mod.decodeErlangText('ok')).toBe(':ok');
    expect(mod.decodeErlangText('error')).toBe(':error');
    expect(mod.decodeErlangText("'foo bar'")).toBe(':foo bar');

    // Decoding strings produces plain strings
    expect(mod.decodeErlangText('"hello"')).toBe('hello');

    // Booleans and nulls
    expect(mod.encodeErlangText(true)).toBe('true');
    expect(mod.encodeErlangText(false)).toBe('false');
    expect(mod.encodeErlangText(null)).toBe('nil');
    expect(mod.decodeErlangText('true')).toBe(true);
    expect(mod.decodeErlangText('false')).toBe(false);
    expect(mod.decodeErlangText('nil')).toBe(null);
    expect(mod.decodeErlangText('null')).toBe(null);
  });

  test('map key decoding rules: all-atom keys vs mixed keys', () => {
    const ir = irFor('export type T = unknown;', 'T');
    const code = generateErlangTextCode(ir);
    const mod = evalModule<ErlangTextCodec>(code);

    // Encoding JS object encodes keys as atoms
    const obj = { name: 'Alice', age: 30 };
    const text = mod.encodeErlangText(obj);
    expect(text).toBe('#{name => "Alice", age => 30}');

    // Decoding Erlang map with ALL atom keys produces plain un-prefixed keys
    const decodedAllAtom = mod.decodeErlangText('#{name => "Alice", age => 30}') as any;
    expect(decodedAllAtom).toEqual({ name: 'Alice', age: 30 });

    // Decoding Erlang map with NOT ALL atom keys prefixes atom keys with colon
    const decodedMixed = mod.decodeErlangText('#{name => "Alice", 1 => "one"}') as any;
    expect(decodedMixed).toEqual({ ':name': 'Alice', '1': 'one' });
  });

  test('formats Erlang text with indent parameter', () => {
    const ir = irFor('export type T = unknown;', 'T');
    const code = generateErlangTextCode(ir);
    const mod = evalModule<ErlangTextCodec>(code);

    const obj = { name: 'Alice', age: 30 };
    const formatted = mod.encodeErlangText(obj, 2);
    expect(formatted).toBe('#{\n  name => "Alice",\n  age => 30\n}');

    const compact = mod.encodeErlangText(obj);
    expect(compact).toBe('#{name => "Alice", age => 30}');
  });
});

describe('Erlang ETF 131 Binary Codec (encodeErlangBinary / decodeErlangBinary)', () => {
  test('encodes and decodes terms using ETF 131 binary format', () => {
    const ir = irFor('export type T = unknown;', 'T');
    const code = generateErlangBinaryCode(ir);
    const mod = evalModule<ErlangBinaryCodec>(code);

    // Check magic byte 131 (0x83)
    const binOk = mod.encodeErlangBinary(':ok');
    expect(binOk[0]).toBe(131);
    expect(mod.decodeErlangBinary(binOk)).toBe(':ok');

    const binNum = mod.encodeErlangBinary(12345);
    expect(binNum[0]).toBe(131);
    expect(mod.decodeErlangBinary(binNum)).toBe(12345);

    const binStr = mod.encodeErlangBinary('hello world');
    expect(binStr[0]).toBe(131);
    expect(mod.decodeErlangBinary(binStr)).toBe('hello world');

    const binBig = mod.encodeErlangBinary(9007199254740993n);
    expect(binBig[0]).toBe(131);
    expect(mod.decodeErlangBinary(binBig)).toBe(9007199254740993n);

    // Map encoding & decoding rules
    const obj = { name: 'Bob', count: 42 };
    const binObj = mod.encodeErlangBinary(obj);
    expect(binObj[0]).toBe(131);
    const decodedObj = mod.decodeErlangBinary(binObj);
    expect(decodedObj).toEqual({ name: 'Bob', count: 42 });
  });

  test('handles arrays and nested maps in ETF 131', () => {
    const ir = irFor('export type T = unknown;', 'T');
    const code = generateErlangBinaryCode(ir);
    const mod = evalModule<ErlangBinaryCodec>(code);

    const list = [1, ':foo', 'bar', true];
    const binList = mod.encodeErlangBinary(list);
    const decodedList = mod.decodeErlangBinary(binList);
    expect(decodedList).toEqual([1, ':foo', 'bar', true]);

    const nested = { user: { id: 1, roles: [':admin', ':user'] } };
    const binNested = mod.encodeErlangBinary(nested);
    const decodedNested = mod.decodeErlangBinary(binNested);
    expect(decodedNested).toEqual({ user: { id: 1, roles: [':admin', ':user'] } });
  });
});

describe('Plugin visitor rewrites for Erlang codecs', () => {
  test('rewrites encodeErlangText, decodeErlangText, encodeErlangBinary, decodeErlangBinary', () => {
    const source = `
      import { encodeErlangText, decodeErlangText, encodeErlangBinary, decodeErlangBinary } from "wiz";
      export interface Item { name: string }
      export const text = encodeErlangText<Item>({ name: "tool" }, 2);
      export const itemFromText = decodeErlangText<Item>(text);
      export const bin = encodeErlangBinary<Item>({ name: "tool" });
      export const itemFromBin = decodeErlangBinary<Item>(bin);
    `;

    const result = transformSource({ path: 'app.ts', contents: source, logger: silentLogger });
    expect(result.code).toContain('encodeErlangText as __wiz_encodeErlangText_');
    expect(result.code).toContain('decodeErlangText as __wiz_decodeErlangText_');
    expect(result.code).toContain('encodeErlangBinary as __wiz_encodeErlangBinary_');
    expect(result.code).toContain('decodeErlangBinary as __wiz_decodeErlangBinary_');
    expect(result.code).toContain('= __wiz_encodeErlangText_');
    expect(result.code).toContain('= __wiz_decodeErlangText_');
    expect(result.code).toContain('= __wiz_encodeErlangBinary_');
    expect(result.code).toContain('= __wiz_decodeErlangBinary_');
  });
});
