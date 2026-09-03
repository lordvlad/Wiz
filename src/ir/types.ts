export interface ValidationError {
  path: string;
  message: string;
  constraint?: string;
  expected?: string;
  actual?: unknown;
}

/** What {@link validate} can be asked to do beyond collecting errors. */
export interface ValidateOptions {
  /**
   * Removes properties the type does not declare, in place: the object passed
   * in is the object that ends up pruned, as with Ajv's `removeAdditional`.
   *
   * A level whose schema allows additional properties is left alone - those
   * fields are declared, just not by name - so pruning never discards data the
   * type said to expect.
   */
  prune?: boolean;
  /** Prefix for every reported path, for validating a value in context. */
  path?: string;
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
  /**
   * Node identity within one extracted graph. It is not globally unique:
   * separate extractions may reuse the same counter values.
   */
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
  /**
   * Protobuf field numbers from `NumberedUnion`, positionally matching `types`.
   * Present only when the union was declared through that helper.
   */
  fieldNumbers?: number[];
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
    desc: node.description ?? undefined,
    dep: node.deprecated
      ? { d: node.deprecated.isDeprecated, n: node.deprecated.note ?? null }
      : undefined,
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
 *
 * `withNames` decides whether the name each node publishes is part of the
 * projection. A bare type module never emits one — its keys, JSON Schema,
 * validator and codecs are purely structural — so two identical shapes with
 * different names legitimately share it. A document or schema-text payload does
 * emit them, as `components.schemas` keys, `$ref` targets and message names, so
 * those keys ask for names and two trees differing only in a nested name stay
 * two modules.
 */
export function normalizeTypeIR(ir: TypeIR, withNames = false): unknown {
  // Annotations reach every generator, so they are keyed unconditionally; the
  // name only when the caller emits it.
  const self = withNames
    ? { nm: ir.name ?? undefined, ...normalizeAnnotations(ir) }
    : normalizeAnnotations(ir);
  const child = (node: TypeIR): unknown => normalizeTypeIR(node, withNames);

  switch (ir.kind) {
    case "primitive":
      return {
        k: "primitive",
        t: ir.type,
        ...self,
      };
    case "literal":
      return {
        k: "literal",
        v: typeof ir.value === "bigint" ? ir.value.toString() + "n" : ir.value,
        ...self,
      };
    case "object":
      return {
        k: "object",
        props: [...ir.properties]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((p) => ({
            n: p.name,
            t: child(p.type),
            o: p.optional,
            r: p.readonly,
            // A protobuf field number is the wire contract, not a comment.
            fn: p.fieldNumber ?? undefined,
            ...normalizeAnnotations(p),
          })),
        add: typeof ir.additionalProperties === "object"
          ? child(ir.additionalProperties)
          : ir.additionalProperties,
        ...self,
      };
    case "array":
      return {
        k: "array",
        e: child(ir.element),
        ...self,
      };
    case "tuple":
      return {
        k: "tuple",
        el: ir.elements.map((e) => ({
          t: child(e.type),
          o: e.optional,
          n: e.name,
        })),
        r: ir.rest ? child(ir.rest) : undefined,
        ...self,
      };
    case "union":
      return {
        k: "union",
        u: ir.types
          .map((t, i) => {
            const normalized = child(t);
            const fieldNumber = ir.fieldNumbers?.[i];
            // Pair before sorting, or the sort would scramble the numbering.
            return fieldNumber === undefined
              ? normalized
              : { n: fieldNumber, t: normalized };
          })
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        // A discriminated union emits `oneOf` + `discriminator`; a plain one
        // emits `anyOf`. Different output, so it cannot share a key.
        d: ir.discriminator ? { p: ir.discriminator.propertyName } : undefined,
        ...self,
      };
    case "intersection":
      return {
        k: "intersection",
        i: ir.types
          .map((t) => child(t))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        ...self,
      };
    case "enum":
      return {
        k: "enum",
        m: [...ir.members]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((m) => ({ n: m.name, v: m.value })),
        ...self,
      };
    case "record":
      return {
        k: "record",
        kt: child(ir.keyType),
        vt: child(ir.valueType),
        ...self,
      };
    case "ref":
      return {
        k: "ref",
        id: ir.targetId,
        ...self,
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
 *
 * Cycles are broken on node identity, not `id`: separate extractions may
 * legitimately mint the same id, and an id-keyed walk would skip a node from
 * a second graph when callers reuse one visited set.
 */
export function walkTypeIR(
  ir: TypeIR,
  visitor: (node: TypeIR) => void,
  visited = new Set<TypeIR>()
): void {
  if (visited.has(ir)) return;
  visited.add(ir);

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
      const existing = namedMap.get(node.name!);
      if (!existing || (existing.kind === "ref" && node.kind !== "ref")) {
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

/**
 * The value range each integer `@format` promises.
 *
 * One table so the validator, the JSON Schema bounds and every codec agree on
 * what a width means. Bounds are bigints because `int64` and `uint64` exceed
 * what a JS number can represent exactly, which is the whole reason a value
 * outside them cannot be trusted.
 *
 * The protobuf-specific spellings appear too: `sint`/`sfixed` differ from
 * `int` only in how they are written, not in what they can hold.
 */
export const INTEGER_FORMATS: Record<string, { min: bigint; max: bigint }> = {
  int8: { min: -128n, max: 127n },
  int16: { min: -32768n, max: 32767n },
  int32: { min: -2147483648n, max: 2147483647n },
  int64: { min: -(2n ** 63n), max: 2n ** 63n - 1n },
  uint8: { min: 0n, max: 255n },
  uint16: { min: 0n, max: 65535n },
  uint32: { min: 0n, max: 4294967295n },
  uint64: { min: 0n, max: 2n ** 64n - 1n },
  sint32: { min: -2147483648n, max: 2147483647n },
  sint64: { min: -(2n ** 63n), max: 2n ** 63n - 1n },
  sfixed32: { min: -2147483648n, max: 2147483647n },
  sfixed64: { min: -(2n ** 63n), max: 2n ** 63n - 1n },
  fixed32: { min: 0n, max: 4294967295n },
  fixed64: { min: 0n, max: 2n ** 64n - 1n },
  // Exactly the integers a double holds without loss, which is what the format
  // means, and also the practical limit for any 64-bit width carried by a
  // `number` rather than a `bigint`.
  "double-int": { min: -(2n ** 53n - 1n), max: 2n ** 53n - 1n },
  "sf-integer": { min: -999999999999999n, max: 999999999999999n },
  unixtime: { min: -(2n ** 63n), max: 2n ** 63n - 1n },
};

/**
 * String `@format` values that are *enforced*, as one table.
 *
 * One source so the validator and the zod schema cannot disagree: both read
 * `pattern` from here, so a value either back end rejects is rejected by the
 * other for the same reason. `label` is what the error reports.
 *
 * `pattern` is a regex source rather than a `RegExp` because both consumers
 * emit it into generated code as text.
 *
 * Deliberately absent: `date-time`, `date` and `binary` are *primitive*
 * formats - see `PRIMITIVE_FORMATS` in `openapiDialect.ts` - which change the
 * type a field carries rather than constraining a string. `regex` is here in
 * name only: "compiles as a regex" is not a pattern, so the validator checks
 * it by compiling, and {@link STRING_FORMAT_REGEX} marks it.
 */
export const STRING_FORMATS: Record<string, { pattern: string; label: string }> = {
  email: {
    // Deliberately loose, and unchanged from when it was the only format: a
    // full RFC 5322 address is not expressible in a readable regex, and a
    // stricter one rejects addresses that deliver.
    pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
    label: "email",
  },
  uuid: {
    pattern:
      "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
    label: "uuid",
  },
  // RFC 3986: a URI has a scheme, a reference need not.
  uri: {
    pattern: "^[A-Za-z][A-Za-z0-9+.-]*:[^\\s]*$",
    label: "uri",
  },
  "uri-reference": {
    pattern: "^(?:[A-Za-z][A-Za-z0-9+.-]*:)?[^\\s]*$",
    label: "uri-reference",
  },
  // RFC 6570: a reference that may carry `{...}` expressions. Braces are only
  // legal as balanced, non-nested pairs, which is what rules out `{a{b}`.
  "uri-template": {
    pattern: "^(?:[^\\s{}]|\\{[^{}\\s]*\\})*$",
    label: "uri-template",
  },
  // RFC 1123: labels of alphanumerics and inner hyphens, 63 bytes each, and a
  // 253-byte whole. Length is checked by the lookahead, not by counting twice.
  hostname: {
    pattern:
      "^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\\.?$",
    label: "hostname",
  },
  // Four octets, each 0-255: the alternation is what rejects `256` and `01`.
  ipv4: {
    pattern:
      "^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$",
    label: "ipv4",
  },
  /**
   * RFC 4291, including every legal `::` elision and the IPv4-mapped tail.
   * Written as an alternation over how many groups precede the elision, which
   * is the only way to keep "at most one `::`" expressible in one regex.
   */
  ipv6: {
    pattern:
      "^(?:" +
      "(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}" +
      "|(?:[0-9a-fA-F]{1,4}:){1,7}:" +
      "|(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}" +
      "|(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}" +
      "|(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}" +
      "|(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}" +
      "|(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}" +
      "|[0-9a-fA-F]{1,4}:(?::[0-9a-fA-F]{1,4}){1,6}" +
      "|:(?:(?::[0-9a-fA-F]{1,4}){1,7}|:)" +
      "|fe80:(?::[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]+" +
      "|::(?:ffff(?::0{1,4})?:)?(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])" +
      "|(?:[0-9a-fA-F]{1,4}:){1,4}:(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])" +
      ")$",
    label: "ipv6",
  },
  // RFC 6901: either empty, or `/`-prefixed tokens where `~` only ever
  // introduces `~0` or `~1`.
  "json-pointer": {
    pattern: "^(?:/(?:[^~/]|~[01])*)*$",
    label: "json-pointer",
  },
  // RFC 6901 relative form: a non-negative integer of upward steps, then
  // either a `#` or a JSON pointer.
  "relative-json-pointer": {
    pattern: "^(?:0|[1-9][0-9]*)(?:#|(?:/(?:[^~/]|~[01])*)*)$",
    label: "relative-json-pointer",
  },
};

/**
 * The one enforced format that is not a pattern.
 *
 * "Is a regular expression" can only be answered by compiling the string, so
 * the validator emits a `try`/`catch` for it rather than a `.test`.
 */
export const STRING_FORMAT_REGEX = "regex";

/** Integers a JS number holds exactly; beyond this a `number` is already wrong. */
export const SAFE_INTEGER = 9007199254740991n;
