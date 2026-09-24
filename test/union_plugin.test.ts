// @wiz-ignore
import { beforeAll, describe, expect, test } from 'bun:test';
import { plugin } from 'bun';
import { silentLogger } from '../src/logger.ts';
import { wizPlugin } from '../src/plugin.ts';

plugin(wizPlugin({ logger: silentLogger }));

describe('NumberedUnion end-to-end through the plugin', () => {
  let fixture: typeof import('./fixtures/unionFixture.ts');

  beforeAll(async () => {
    fixture = await import('./fixtures/unionFixture.ts');
  });

  test('the alias is followed across modules into a oneof', () => {
    // `Shape` is imported by name from another file, so recovering the
    // numbering means resolving the import to its declaration.
    expect(fixture.drawingProto).toContain('oneof shape {');
    expect(fixture.drawingProto).toContain('Circle circle = 2;');
    expect(fixture.drawingProto).toContain('Square square = 3;');
  });

  test('sibling fields keep their own numbers around the oneof', () => {
    expect(fixture.drawingProto).toContain('string title = 1;');
    expect(fixture.drawingProto).toContain('string note = 4;');
  });

  test('variant messages are declared alongside', () => {
    expect(fixture.drawingProto).toContain('message Circle {');
    expect(fixture.drawingProto).toContain('float radius = 2;');
  });

  test('each variant round-trips under its own field number', () => {
    const buf = new Uint8Array(256);
    const n = fixture.encodeDrawing({ title: 'a', shape: { kind: 'circle', radius: 1.5 } }, buf);
    // title, then the oneof's circle branch at field 2.
    expect(buf[0]).toBe((1 << 3) | 2);
    expect(buf.subarray(0, n)).toContain((2 << 3) | 2);
    expect(fixture.decodeDrawing(buf.subarray(0, n))).toEqual({
      title: 'a',
      shape: { kind: 'circle', radius: 1.5 },
    });

    const buf2 = new Uint8Array(256);
    const n2 = fixture.encodeDrawing({ title: 'b', shape: { kind: 'square', side: 2.5 } }, buf2);
    expect(fixture.decodeDrawing(buf2.subarray(0, n2))).toEqual({
      title: 'b',
      shape: { kind: 'square', side: 2.5 },
    });
  });

  test('an omitted optional field costs no bytes', () => {
    const buf = new Uint8Array(256);
    const withNote = fixture.encodeDrawing(
      { title: 'a', shape: { kind: 'circle', radius: 1 }, note: 'hi' },
      buf
    );
    const without = fixture.encodeDrawing(
      { title: 'a', shape: { kind: 'circle', radius: 1 } },
      new Uint8Array(256)
    );
    expect(withNote - without).toBe(4);
  });

  test('JSON Schema still describes it as an ordinary union', () => {
    const shape = (fixture.drawingJsonSchema as any).properties.shape;
    expect(shape.oneOf ?? shape.anyOf).toHaveLength(2);
    expect((fixture.drawingJsonSchema as any).required).toEqual(['title', 'shape']);
  });
});
