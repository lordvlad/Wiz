// @wiz-ignore
import { describe, expect, test } from 'bun:test';
import { jsonSchemaToIR, type SchemaIdSource } from '../src/extractors/jsonSchema.ts';

describe('jsonSchema extractor', () => {
  const getCtx = (): SchemaIdSource => ({ ids: 0 });

  test('extracts oneOf and anyOf nested inside arrays', () => {
    const rawOneOf = {
      type: 'array',
      items: {
        oneOf: [{ type: 'string' }, { type: 'number' }],
      },
    };
    const irOneOf = jsonSchemaToIR(rawOneOf, getCtx(), '');
    expect(irOneOf.kind).toBe('array');
    if (irOneOf.kind === 'array') {
      expect(irOneOf.element.kind).toBe('union');
      if (irOneOf.element.kind === 'union') {
        expect(irOneOf.element.types.length).toBe(2);
        expect(irOneOf.element.types[0]!.kind).toBe('primitive');
        expect(irOneOf.element.types[1]!.kind).toBe('primitive');
      }
    }

    const rawAnyOf = {
      type: 'array',
      items: {
        anyOf: [{ type: 'boolean' }, { type: 'null' }],
      },
    };
    const irAnyOf = jsonSchemaToIR(rawAnyOf, getCtx(), '');
    expect(irAnyOf.kind).toBe('array');
    if (irAnyOf.kind === 'array') {
      expect(irAnyOf.element.kind).toBe('union');
      if (irAnyOf.element.kind === 'union') {
        expect(irAnyOf.element.types.length).toBe(2);
      }
    }
  });

  test('extracts single and mixed-type enums', () => {
    // Single-type enum -> literal
    const rawSingle = {
      enum: ['only_value'],
    };
    const irSingle = jsonSchemaToIR(rawSingle, getCtx(), '');
    expect(irSingle.kind).toBe('literal');
    if (irSingle.kind === 'literal') {
      expect(irSingle.value).toBe('only_value');
    }

    // Homogeneous enum (strings) -> enum
    const rawStrings = {
      enum: ['a', 'b', 'c'],
    };
    const irStrings = jsonSchemaToIR(rawStrings, getCtx(), '');
    expect(irStrings.kind).toBe('enum');
    if (irStrings.kind === 'enum') {
      expect(irStrings.members.length).toBe(3);
    }

    // Mixed-type enum -> union of literals
    const rawMixed = {
      enum: ['a', 1, true, null],
    };
    const irMixed = jsonSchemaToIR(rawMixed, getCtx(), '');
    expect(irMixed.kind).toBe('union');
    if (irMixed.kind === 'union') {
      expect(irMixed.types.length).toBe(4);
      expect(irMixed.types[0]!.kind).toBe('literal');
      expect(irMixed.types[1]!.kind).toBe('literal');
      expect(irMixed.types[2]!.kind).toBe('literal');
      expect(irMixed.types[3]!.kind).toBe('literal');
    }
  });
});
