import asyncApi26Schema from '../../schemas/asyncapi-2.6.json';
import asyncApi30Schema from '../../schemas/asyncapi-3.0.json';
import mcpSchema from '../../schemas/mcp-2024-11-05.json';
import openApi30Schema from '../../schemas/openapi-3.0.json';
import openApi31Schema from '../../schemas/openapi-3.1.json';
import openRpc13Schema from '../../schemas/openrpc-1.3.json';
import { generateValidationBlock } from '../generators/validator.ts';
import type { TypeIR } from '../ir/types.ts';

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

function metaSchemaToTypeIR(rootSchema: Record<string, unknown>): TypeIR {
  const namedTypes = new Map<string, TypeIR>();
  let idSeq = 0;
  const nextId = (): string => `meta_${++idSeq}`;

  const defs: Record<string, unknown> = {
    ...(isObject(rootSchema.definitions) ? rootSchema.definitions : {}),
    ...(isObject(rootSchema.$defs) ? rootSchema.$defs : {}),
  };

  function parseNode(node: unknown, visited = new Set<unknown>()): TypeIR {
    if (node === undefined || node === true) {
      return { id: nextId(), kind: 'primitive', type: 'unknown' };
    }
    if (node === false) {
      return { id: nextId(), kind: 'primitive', type: 'never' };
    }
    if (!isObject(node)) {
      return { id: nextId(), kind: 'primitive', type: 'unknown' };
    }

    if (typeof node.$ref === 'string') {
      const refStr = String(node.$ref);
      let targetName: string | null = null;
      if (refStr.startsWith('#/definitions/')) {
        targetName = refStr.slice('#/definitions/'.length);
      } else if (refStr.startsWith('#/$defs/')) {
        targetName = refStr.slice('#/$defs/'.length);
      } else if (refStr.includes('/') && !refStr.startsWith('http')) {
        const parts = refStr.split('/');
        targetName = parts[parts.length - 1]!.replace('.json', '');
      }

      if (targetName) {
        if (!namedTypes.has(targetName)) {
          const targetDef = defs[targetName];
          if (targetDef) {
            const placeholder: TypeIR = {
              id: targetName,
              kind: 'ref',
              targetId: targetName,
              name: targetName,
            };
            namedTypes.set(targetName, placeholder);
            const parsedTarget = parseNode(targetDef, visited);
            namedTypes.set(targetName, parsedTarget);
          }
        }
        return { id: nextId(), kind: 'ref', targetId: targetName, name: targetName };
      }
      return { id: nextId(), kind: 'primitive', type: 'unknown' };
    }
    if (Array.isArray(node.enum) && node.enum.length > 0) {
      const values = node.enum as Array<string | number | boolean | null>;
      return {
        id: nextId(),
        kind: 'union',
        types: values.map((v) => ({ id: nextId(), kind: 'literal', value: v })),
      };
    }
    if (
      'const' in node &&
      (typeof node.const === 'string' ||
        typeof node.const === 'number' ||
        typeof node.const === 'boolean' ||
        node.const === null)
    ) {
      return {
        id: nextId(),
        kind: 'literal',
        value: node.const,
      };
    }

    if (Array.isArray(node.oneOf) && node.oneOf.length > 0) {
      return {
        id: nextId(),
        kind: 'union',
        types: node.oneOf.map((s) => parseNode(s, visited)),
      };
    }
    if (Array.isArray(node.anyOf) && node.anyOf.length > 0) {
      return {
        id: nextId(),
        kind: 'union',
        types: node.anyOf.map((s) => parseNode(s, visited)),
      };
    }

    if (node.type === 'string') {
      return { id: nextId(), kind: 'primitive', type: 'string' };
    }
    if (node.type === 'number' || node.type === 'integer') {
      return { id: nextId(), kind: 'primitive', type: 'number' };
    }
    if (node.type === 'boolean') {
      return { id: nextId(), kind: 'primitive', type: 'boolean' };
    }
    if (node.type === 'null') {
      return { id: nextId(), kind: 'primitive', type: 'null' };
    }

    if (node.type === 'array' || Array.isArray(node.items) || isObject(node.items)) {
      const itemNode = isObject(node.items) ? node.items : {};
      return {
        id: nextId(),
        kind: 'array',
        element: parseNode(itemNode, visited),
      };
    }

    if (
      node.type === 'object' ||
      isObject(node.properties) ||
      isObject(node.patternProperties) ||
      isObject(node.additionalProperties) ||
      Array.isArray(node.required)
    ) {
      const properties: Array<{
        name: string;
        optional: boolean;
        readonly: boolean;
        type: TypeIR;
      }> = [];
      const required = Array.isArray(node.required) ? node.required : [];
      if (isObject(node.properties)) {
        for (const [propName, propSchema] of Object.entries(node.properties)) {
          properties.push({
            name: propName,
            optional: !required.includes(propName),
            readonly: false,
            type: parseNode(propSchema, visited),
          });
        }
      }

      if (isObject(node.patternProperties)) {
        for (const [pat, patSchema] of Object.entries(node.patternProperties)) {
          if (pat.includes('get|put|post')) {
            for (const m of HTTP_METHODS) {
              properties.push({
                name: m,
                optional: true,
                readonly: false,
                type: parseNode(patSchema, visited),
              });
            }
          }
        }
      }

      let recordValueType: TypeIR | null = null;
      if (isObject(node.patternProperties)) {
        const patterns = Object.entries(node.patternProperties).filter(
          ([k]) => !k.startsWith('^x-') && !k.includes('get|put|post')
        );
        if (patterns.length > 0) {
          const first = patterns[0]![1];
          recordValueType = parseNode(first, visited);
        }
      } else if (isObject(node.additionalProperties)) {
        recordValueType = parseNode(node.additionalProperties, visited);
      }

      if (recordValueType && properties.length === 0) {
        return {
          id: nextId(),
          kind: 'record',
          keyType: { id: nextId(), kind: 'primitive', type: 'string' },
          valueType: recordValueType,
        };
      }

      if (recordValueType && properties.length > 0) {
        return {
          id: nextId(),
          kind: 'intersection',
          types: [
            {
              id: nextId(),
              kind: 'object',
              properties,
            },
            {
              id: nextId(),
              kind: 'record',
              keyType: { id: nextId(), kind: 'primitive', type: 'string' },
              valueType: recordValueType,
            },
          ],
        };
      }

      return {
        id: nextId(),
        kind: 'object',
        properties,
      };
    }

    return { id: nextId(), kind: 'primitive', type: 'unknown' };
  }

  for (const [defName, defSchema] of Object.entries(defs)) {
    if (!namedTypes.has(defName)) {
      namedTypes.set(defName, parseNode(defSchema));
    }
  }

  function inlineRefs(ir: TypeIR, inlining = new Set<string>()): TypeIR {
    if (ir.kind === 'ref' && ir.targetId && namedTypes.has(ir.targetId)) {
      if (inlining.has(ir.targetId)) {
        return { id: nextId(), kind: 'primitive', type: 'unknown' };
      }
      const nextInlining = new Set(inlining);
      nextInlining.add(ir.targetId);
      const target = namedTypes.get(ir.targetId)!;
      return inlineRefs(target, nextInlining);
    }
    if (ir.kind === 'object') {
      return {
        ...ir,
        properties: ir.properties.map((p) => ({
          ...p,
          type: inlineRefs(p.type, inlining),
        })),
      };
    }
    if (ir.kind === 'array') {
      return {
        ...ir,
        element: inlineRefs(ir.element, inlining),
      };
    }
    if (ir.kind === 'record') {
      return {
        ...ir,
        valueType: inlineRefs(ir.valueType, inlining),
      };
    }
    if (ir.kind === 'union' || ir.kind === 'intersection') {
      return {
        ...ir,
        types: ir.types.map((t) => inlineRefs(t, inlining)),
      };
    }
    return ir;
  }

  const rootIR = parseNode(rootSchema);
  return inlineRefs(rootIR);
}

function buildValidatorFunction(
  metaSchema: Record<string, unknown>
): (data: unknown) => Array<{ path: string; message: string }> {
  const ir = metaSchemaToTypeIR(metaSchema);
  const validationBody = generateValidationBlock(ir, 'arg', 'path', 0);
  const fn = new Function(
    'arg',
    `"use strict";
    const path = "";
    const __prune = false;
    const errors = [];
    ${validationBody}
    return errors;`
  ) as (data: unknown) => Array<{ path: string; message: string }>;
  return fn;
}

const validateOpenApi30 = buildValidatorFunction(
  openApi30Schema as unknown as Record<string, unknown>
);
const validateOpenApi31 = buildValidatorFunction(
  openApi31Schema as unknown as Record<string, unknown>
);
const validateOpenRpc13 = buildValidatorFunction(
  openRpc13Schema as unknown as Record<string, unknown>
);
const validateAsyncApi26 = buildValidatorFunction(
  asyncApi26Schema as unknown as Record<string, unknown>
);
const validateAsyncApi30 = buildValidatorFunction(
  asyncApi30Schema as unknown as Record<string, unknown>
);
const validateMcp = buildValidatorFunction({
  $ref: '#/definitions/ListToolsResult',
  definitions: (mcpSchema as unknown as Record<string, Record<string, unknown>>).definitions,
});

const JSON_SCHEMA_TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'];

const jsonSchemaMeta: Record<string, unknown> = {
  type: 'object',
  properties: {
    $schema: { type: 'string' },
    type: {
      oneOf: [
        { type: 'string', enum: JSON_SCHEMA_TYPES },
        { type: 'array', items: { type: 'string', enum: JSON_SCHEMA_TYPES } },
      ],
    },
    properties: { type: 'object' },
    required: { type: 'array', items: { type: 'string' } },
    items: {},
    prefixItems: { type: 'array' },
    $defs: { type: 'object' },
    definitions: { type: 'object' },
  },
};
const validateJsonSchema = buildValidatorFunction(jsonSchemaMeta);

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

function formatErrors(errs: Array<{ path: string; message: string }>): ValidationResult {
  if (errs.length === 0) {
    return { valid: true };
  }
  return {
    valid: false,
    errors: errs.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)),
  };
}

/**
 * Synchronously validates a spec document object against schema definitions.
 */
export function validateSpecDocumentSync(doc: unknown, schemaHint?: string): ValidationResult {
  if (!isObject(doc)) {
    return {
      valid: false,
      errors: ['Document is not an object'],
    };
  }

  if (schemaHint === 'mcp') {
    return formatErrors(validateMcp(doc));
  }

  // Schema sniffing heuristics...
  if ('openapi' in doc) {
    const ver = String(doc.openapi);
    if (ver.startsWith('3.1')) {
      return formatErrors(validateOpenApi31(doc));
    }
    return formatErrors(validateOpenApi30(doc));
  } else if ('openrpc' in doc) {
    return formatErrors(validateOpenRpc13(doc));
  } else if ('asyncapi' in doc) {
    const ver = String(doc.asyncapi);
    if (ver.startsWith('3.')) {
      return formatErrors(validateAsyncApi30(doc));
    }
    return formatErrors(validateAsyncApi26(doc));
  } else if ('$schema' in doc) {
    // It looks like a raw JSON Schema. We validate using a basic schema-for-schemas.
    return formatErrors(validateJsonSchema(doc));
  }

  return {
    valid: false,
    errors: ['Unrecognised spec document'],
  };
}

/**
 * Asynchronously validates a spec document against official JSON schema meta-schemas.
 */
export async function validateSpecDocument(
  doc: unknown,
  schemaHint?: string
): Promise<ValidationResult> {
  return validateSpecDocumentSync(doc, schemaHint);
}

/**
 * Synchronously asserts that a spec document is valid.
 */
export function assertValidSpecDocumentSync(
  doc: unknown,
  contextName = 'Spec',
  schemaHint?: string
): void {
  const result = validateSpecDocumentSync(doc, schemaHint);
  if (!result.valid) {
    throw new Error(
      `[wiz] Generated ${contextName} document is invalid: ${(result.errors ?? []).join('; ')}`
    );
  }
}

/**
 * Asynchronously asserts that a spec document is valid.
 */
export async function assertValidSpecDocument(
  doc: unknown,
  contextName = 'Spec',
  schemaHint?: string
): Promise<void> {
  assertValidSpecDocumentSync(doc, contextName, schemaHint);
}
