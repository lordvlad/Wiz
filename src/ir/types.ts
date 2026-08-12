export interface ValidationError {
  path: string;
  message: string;
  constraint?: string;
  expected?: string;
  actual?: unknown;
}

/**
 * Constraints *validate*. Every kind here is enforced by the generated
 * validator and maps onto a JSON Schema assertion keyword. Purely descriptive
 * tags (`@example`, `@default`) are annotations instead — see {@link Annotated}.
 */
export type ConstraintKind =
  | "min"
  | "max"
  | "minimum"
  | "maximum"
  | "exclusiveMinimum"
  | "exclusiveMaximum"
  | "minLength"
  | "maxLength"
  | "pattern"
  | "format"
  | "multipleOf"
  | "minItems"
  | "maxItems"
  | "uniqueItems";

export interface Constraint {
  kind: ConstraintKind;
  value: unknown;
}

export interface DeprecatedInfo {
  isDeprecated: boolean;
  note?: string;
}

/**
 * Everything a JSDoc block can say about a type or property.
 *
 * `constraints` narrow the set of valid values; the rest only describe it.
 * `meta` is the catch-all for tags wiz does not model — `@since`, `@author`,
 * `@internal` and so on — so nothing in a doc comment is silently lost.
 * A bare tag records `true`; a tag with text records that text. Values are
 * always arrays: `@see` and friends legitimately repeat, and collapsing them
 * would discard everything but the last.
 */
export interface Annotated {
  description?: string;
  deprecated?: DeprecatedInfo;
  constraints?: Constraint[];
  /** `@example` values, JSON-parsed when possible. */
  examples?: unknown[];
  /** `@default` value, JSON-parsed when possible. */
  default?: unknown;
  /** Unrecognised JSDoc tags, verbatim, in source order. */
  meta?: Record<string, (string | true)[]>;
}

export interface BaseTypeIR extends Annotated {
  id: string;
  name?: string;
}
export interface PrimitiveTypeIR extends BaseTypeIR {
  kind: "primitive";
  type:
    | "string"
    | "number"
    | "boolean"
    | "bigint"
    | "null"
    | "undefined"
    | "symbol"
    | "unknown"
    | "any"
    | "void"
    | "never"
    /** `Uint8Array` and friends: opaque binary, not a struct of methods. */
    | "bytes"
    /** `Date`: an instant, not a struct of methods. */
    | "date";
}

export interface LiteralTypeIR extends BaseTypeIR {
  kind: "literal";
  value: string | number | boolean | bigint | null;
}

export interface PropertyIR extends Annotated {
  name: string;
  type: TypeIR;
  optional: boolean;
  readonly: boolean;
  fieldNumber?: number;
}

export interface ObjectTypeIR extends BaseTypeIR {
  kind: "object";
  properties: PropertyIR[];
  additionalProperties?: TypeIR | boolean;
}

export interface ArrayTypeIR extends BaseTypeIR {
  kind: "array";
  element: TypeIR;
}

export interface TupleElementIR {
  type: TypeIR;
  optional: boolean;
  name?: string;
}

export interface TupleTypeIR extends BaseTypeIR {
  kind: "tuple";
  elements: TupleElementIR[];
  rest?: TypeIR;
}

export interface UnionTypeIR extends BaseTypeIR {
  kind: "union";
  types: TypeIR[];
  discriminator?: { propertyName: string };
}

export interface IntersectionTypeIR extends BaseTypeIR {
  kind: "intersection";
  types: TypeIR[];
}

export interface EnumMemberIR {
  name: string;
  value: string | number;
}

export interface EnumTypeIR extends BaseTypeIR {
  kind: "enum";
  members: EnumMemberIR[];
}

export interface RecordTypeIR extends BaseTypeIR {
  kind: "record";
  keyType: TypeIR;
  valueType: TypeIR;
}

export interface RefTypeIR extends BaseTypeIR {
  kind: "ref";
  targetId: string;
}

export type TypeIR =
  | PrimitiveTypeIR
  | LiteralTypeIR
  | ObjectTypeIR
  | ArrayTypeIR
  | TupleTypeIR
  | UnionTypeIR
  | IntersectionTypeIR
  | EnumTypeIR
  | RecordTypeIR
  | RefTypeIR;

/**
 * Fast FNV-1a hash function producing an 8-character hex string.
 */
export function fnv1a(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Annotation slice of the structural key, so docs cannot be lost to dedupe. */
function normalizeAnnotations(node: Annotated): Record<string, unknown> {
  return {
    c: node.constraints ? normalizeConstraints(node.constraints) : undefined,
    ex: node.examples ?? undefined,
    def: node.default ?? undefined,
    meta: node.meta
      ? Object.entries(node.meta).sort(([a], [b]) => a.localeCompare(b))
      : undefined,
  };
}

/**
 * Computes a normalized, deterministic string representation of a TypeIR tree.
 */
export function normalizeTypeIR(ir: TypeIR): unknown {
  switch (ir.kind) {
    case "primitive":
      return {
        k: "primitive",
        t: ir.type,
        ...normalizeAnnotations(ir),
      };
    case "literal":
      return {
        k: "literal",
        v: typeof ir.value === "bigint" ? ir.value.toString() + "n" : ir.value,
        ...normalizeAnnotations(ir),
      };
    case "object":
      return {
        k: "object",
        props: [...ir.properties]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((p) => ({
            n: p.name,
            t: normalizeTypeIR(p.type),
            o: p.optional,
            r: p.readonly,
            desc: p.description ?? null,
            dep: p.deprecated ? { d: p.deprecated.isDeprecated, n: p.deprecated.note ?? null } : null,
            ...normalizeAnnotations(p),
          })),
        add: typeof ir.additionalProperties === "object"
          ? normalizeTypeIR(ir.additionalProperties)
          : ir.additionalProperties,
      };
    case "array":
      return {
        k: "array",
        e: normalizeTypeIR(ir.element),
        ...normalizeAnnotations(ir),
      };
    case "tuple":
      return {
        k: "tuple",
        el: ir.elements.map((e) => ({
          t: normalizeTypeIR(e.type),
          o: e.optional,
          n: e.name,
        })),
        r: ir.rest ? normalizeTypeIR(ir.rest) : undefined,
      };
    case "union":
      return {
        k: "union",
        u: ir.types
          .map((t) => normalizeTypeIR(t))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      };
    case "intersection":
      return {
        k: "intersection",
        i: ir.types
          .map((t) => normalizeTypeIR(t))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      };
    case "enum":
      return {
        k: "enum",
        m: [...ir.members]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((m) => ({ n: m.name, v: m.value })),
      };
    case "record":
      return {
        k: "record",
        kt: normalizeTypeIR(ir.keyType),
        vt: normalizeTypeIR(ir.valueType),
      };
    case "ref":
      return {
        k: "ref",
        id: ir.targetId,
      };
  }
}

function normalizeConstraints(constraints: Constraint[]): unknown[] {
  return [...constraints]
    .sort((a, b) => a.kind.localeCompare(b.kind) || String(a.value).localeCompare(String(b.value)))
    .map((c) => ({ k: c.kind, v: c.value }));
}

/**
 * Computes a structural hash key for a TypeIR node.
 */
export function computeTypeIRHash(ir: TypeIR): string {
  const normalized = normalizeTypeIR(ir);
  return fnv1a(JSON.stringify(normalized));
}
/**
 * Recursively traverses a TypeIR tree and invokes visitor on every node.
 * Prevents cycles using a visited set of node IDs.
 */
export function walkTypeIR(
  ir: TypeIR,
  visitor: (node: TypeIR) => void,
  visited = new Set<string>()
): void {
  if (visited.has(ir.id)) return;
  visited.add(ir.id);

  visitor(ir);

  switch (ir.kind) {
    case "object":
      for (const prop of ir.properties) {
        walkTypeIR(prop.type, visitor, visited);
      }
      if (typeof ir.additionalProperties === "object") {
        walkTypeIR(ir.additionalProperties, visitor, visited);
      }
      break;
    case "array":
      walkTypeIR(ir.element, visitor, visited);
      break;
    case "tuple":
      for (const elem of ir.elements) {
        walkTypeIR(elem.type, visitor, visited);
      }
      if (ir.rest) {
        walkTypeIR(ir.rest, visitor, visited);
      }
      break;
    case "union":
    case "intersection":
      for (const subType of ir.types) {
        walkTypeIR(subType, visitor, visited);
      }
      break;
    case "record":
      walkTypeIR(ir.keyType, visitor, visited);
      walkTypeIR(ir.valueType, visitor, visited);
      break;
    case "primitive":
    case "literal":
    case "enum":
      break;
  }
}

/**
 * Structural/utility type names that must never become domain component schemas.
 * `Partial<User>` and friends are mapped types: their expansion is the contract,
 * not the alias name, so they are inlined rather than emitted as a named schema.
 */
export const BUILTIN_TYPE_NAMES = new Set([
  "Array",
  "ReadonlyArray",
  "Record",
  "Promise",
  "Set",
  "Map",
  "Object",
  "Function",
  "Symbol",
  "Boolean",
  "Number",
  "String",
  "RegExp",
  "Error",
  "Partial",
  "Required",
  "Readonly",
  "Pick",
  "Omit",
  "Exclude",
  "Extract",
  "NonNullable",
  "Parameters",
  "ReturnType",
  "Awaited",
  // Modelled as opaque scalars elsewhere; their lib documentation describes the
  // class, not the field, so it must not reach a generated schema.
  "Uint8Array",
  "Uint8ClampedArray",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "Date",
]);

export function isUserNamedType(name: string | undefined): boolean {
  return Boolean(name && !name.startsWith("__") && !BUILTIN_TYPE_NAMES.has(name));
}
/**
 * Collects all transitively referenced named types from a TypeIR tree.
 */
export function collectNamedTypes(ir: TypeIR): Map<string, TypeIR> {
  const namedMap = new Map<string, TypeIR>();

  walkTypeIR(ir, (node) => {
    if (isUserNamedType(node.name)) {
      if (!namedMap.has(node.name!)) {
        namedMap.set(node.name!, node);
      }
    }
  });

  return namedMap;
}
/**
 * Collects the properties an object-ish type exposes, merging intersection
 * members so `A & B` behaves like the single object a caller sees.
 * Later members win, matching TypeScript's own intersection resolution.
 */
export function flattenObjectProperties(ir: TypeIR): PropertyIR[] {
  if (ir.kind === "object") {
    return ir.properties;
  }
  if (ir.kind === "intersection") {
    const merged = new Map<string, PropertyIR>();
    for (const member of ir.types) {
      for (const property of flattenObjectProperties(member)) {
        merged.set(property.name, property);
      }
    }
    return [...merged.values()];
  }
  return [];
}
/**
 * Reads `@format` from the first carrier that declares one.
 *
 * Numeric width is expressed with the OpenAPI Format Registry values —
 * `int32`, `int64`, `float`, `double` — rather than a per-backend tag, so one
 * annotation decides the JSON Schema output, the OpenAPI output and the binary
 * width chosen by the protobuf and avro codecs. Carriers are checked in order,
 * which lets a property override the type it refers to.
 */
export function declaredFormat(
  ...carriers: Array<Annotated | undefined>
): string | undefined {
  for (const carrier of carriers) {
    const format = carrier?.constraints?.find((c) => c.kind === "format");
    if (typeof format?.value === "string") return format.value;
  }
  return undefined;
}
