import {
  INTEGER_FORMATS,
  SAFE_INTEGER,
  type Annotated,
  type Constraint,
  type ConstraintKind,
} from './types.ts';

/**
 * Where OpenAPI keyword knowledge lives, in both directions.
 *
 * `src/generators/openapi.ts` writes these keywords and
 * `src/extractors/openapi.ts` reads them back. Written twice they drift, and
 * a round-trip test only catches drift in the rows its fixture happens to
 * cover — so the pair is defined once, here, and each direction is the
 * other's inverse by construction.
 */
export type OpenApiVersion = '3.0' | '3.1';

/** Constraint kinds spelled identically in the IR and in a Schema Object. */
const PLAIN_CONSTRAINTS = [
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
] as const satisfies readonly ConstraintKind[];

/**
 * `type: string` formats that name a primitive instead of constraining one.
 *
 * The generator emits these *from* the primitive, so the extractor must not
 * also read them back as a `format` constraint or the keyword would arrive
 * from two sources at once.
 */
export const PRIMITIVE_FORMATS: Record<string, 'bigint' | 'bytes' | 'date'> = {
  int64: 'bigint',
  byte: 'bytes',
  'date-time': 'date',
};

/** The bound pairs, whose 3.0 spelling differs from their 3.1 one. */
const BOUNDS = [
  { inclusive: 'minimum', exclusive: 'exclusiveMinimum' },
  { inclusive: 'maximum', exclusive: 'exclusiveMaximum' },
] as const;

/**
 * The `minimum`/`maximum` an integer format implies, or undefined if the
 * format names no range. Stating the range makes a document enforceable
 * rather than merely descriptive; recording that it was *derived* is what
 * lets the extractor drop it again instead of reporting a constraint the
 * author never wrote.
 */
export function integerFormatRange(
  format: unknown
): { minimum?: number; maximum?: number } | undefined {
  if (typeof format !== 'string') {
    return undefined;
  }
  const range = INTEGER_FORMATS[format];
  if (!range) {
    return undefined;
  }
  return {
    ...(range.min >= -SAFE_INTEGER ? { minimum: Number(range.min) } : {}),
    ...(range.max <= SAFE_INTEGER ? { maximum: Number(range.max) } : {}),
  };
}

/**
 * IR constraints as Schema Object keywords.
 *
 * OpenAPI 3.0 predates JSON Schema's numeric exclusive bounds: there,
 * `exclusiveMinimum` is a *boolean* modifier on `minimum`. Emitting the
 * number in a 3.0 document produces something the official 3.0 schema
 * rejects, so the pair is rewritten rather than copied.
 */
export function constraintsToKeywords(
  constraints: Constraint[] | undefined,
  version: OpenApiVersion
): Record<string, unknown> {
  const keywords: Record<string, unknown> = {};
  if (!constraints) {
    return keywords;
  }

  const byKind = new Map(constraints.map((c) => [c.kind, c.value]));

  for (const { inclusive, exclusive } of BOUNDS) {
    const exclusiveValue = byKind.get(exclusive);
    const inclusiveValue = byKind.get(inclusive);

    if (exclusiveValue !== undefined) {
      if (version === '3.0') {
        keywords[inclusive] = exclusiveValue;
        keywords[exclusive] = true;
      } else {
        keywords[exclusive] = exclusiveValue;
      }
    }
    if (inclusiveValue !== undefined) {
      keywords[inclusive] = inclusiveValue;
    }
  }

  for (const kind of PLAIN_CONSTRAINTS) {
    const value = byKind.get(kind);
    if (value !== undefined) {
      keywords[kind] = value;
    }
  }

  const range = integerFormatRange(keywords.format);
  if (range) {
    Object.assign(keywords, range);
  }

  return keywords;
}

/**
 * Schema Object keywords as IR constraints: the inverse of
 * {@link constraintsToKeywords}.
 *
 * `consumedFormat` is set when the schema's `format` already picked the node's
 * primitive (see {@link PRIMITIVE_FORMATS}), in which case it is part of the
 * type rather than a constraint on it.
 */
export function keywordsToConstraints(
  schema: Record<string, unknown>,
  version: OpenApiVersion,
  consumedFormat: boolean
): Constraint[] {
  const constraints: Constraint[] = [];

  for (const { inclusive, exclusive } of BOUNDS) {
    const bound = schema[inclusive];
    const modifier = schema[exclusive];

    if (version === '3.0') {
      // Only the pair carries meaning here: a bare boolean bounds nothing.
      if (typeof bound === 'number') {
        constraints.push({
          kind: modifier === true ? exclusive : inclusive,
          value: bound,
        });
      }
    } else {
      if (typeof bound === 'number') {
        constraints.push({ kind: inclusive, value: bound });
      }
      if (typeof modifier === 'number') {
        constraints.push({ kind: exclusive, value: modifier });
      }
    }
  }

  for (const kind of PLAIN_CONSTRAINTS) {
    if (kind === 'format') {
      continue;
    }
    if (schema[kind] !== undefined) {
      constraints.push({ kind, value: schema[kind] });
    }
  }

  if (!consumedFormat && typeof schema.format === 'string') {
    constraints.push({ kind: 'format', value: schema.format });
  }

  // A range that exactly matches the one its integer format implies was
  // derived by the forward direction, not written by the author.
  const range = integerFormatRange(schema.format);
  if (range) {
    return constraints.filter(
      (c) =>
        !(
          (c.kind === 'minimum' && c.value === range.minimum) ||
          (c.kind === 'maximum' && c.value === range.maximum)
        )
    );
  }

  return constraints;
}

/**
 * Descriptive keywords.
 *
 * The dialects genuinely differ: a 3.0 Schema Object carries a single
 * `example`, while 3.1 follows JSON Schema 2020-12 and takes an `examples`
 * array. `meta` is not emitted — arbitrary JSDoc tags are not OpenAPI
 * keywords, and inventing `x-` extensions from them would be noise.
 */
export function annotationsToKeywords(
  node: Annotated,
  version: OpenApiVersion
): Record<string, unknown> {
  const keywords: Record<string, unknown> = {};
  if (node.default !== undefined) {
    keywords.default = node.default;
  }
  if (node.examples && node.examples.length > 0) {
    if (version === '3.0') {
      keywords.example = node.examples[0];
    } else {
      keywords.examples = node.examples;
    }
  }
  return keywords;
}

/**
 * The `x-*` keys of any OpenAPI object, verbatim, or nothing when it has none.
 *
 * Schemas funnel through {@link keywordsToAnnotations}; a Response Object has
 * no annotations to carry them, so it reads this directly.
 */
export function vendorExtensions(
  source: Record<string, unknown>
): Record<string, unknown> | undefined {
  let extensions: Record<string, unknown> | undefined;
  for (const key of Object.keys(source)) {
    if (!key.startsWith('x-')) {
      continue;
    }
    (extensions ??= {})[key] = source[key];
  }
  return extensions;
}

/** The inverse of {@link annotationsToKeywords}, plus the shared prose. */
export function keywordsToAnnotations(schema: Record<string, unknown>): Annotated {
  const annotated: Annotated = {};
  if (typeof schema.description === 'string') {
    annotated.description = schema.description;
  }
  if (schema.deprecated === true) {
    annotated.deprecated = { isDeprecated: true };
  }
  if (Array.isArray(schema.examples)) {
    annotated.examples = schema.examples;
  } else if (schema.example !== undefined) {
    annotated.examples = [schema.example];
  }
  if (schema.default !== undefined) {
    annotated.default = schema.default;
  }
  const extensions = vendorExtensions(schema);
  if (extensions) {
    annotated.extensions = extensions;
  }
  return annotated;
}
