import type { ObjectTypeIR, TypeIR, ValidationError } from "../types.ts";

/**
 * A parser for query strings, generated from the type they should produce.
 *
 * Everything in a query string is a string: `?limit=10&active=true` carries no
 * types, so a validator run straight over it rejects every non-string field
 * the type declares. This emitter closes that gap by coercing each declared
 * field to the type it was declared as, and then handing the result to the
 * generated {@link generateValidatorCode} `validate` - which stays the only
 * thing that decides whether a value is acceptable.
 *
 * That split is the whole design: coercion is best-effort and never reports
 * anything. A field it cannot convert is left exactly as it came in, so the
 * validator sees a string where a number belongs and produces the error. One
 * judge, one set of messages, and no way for the two to disagree.
 */

/** Values a query string can be handed as. */
const INPUT_TYPES = "string, URLSearchParams or object";

/**
 * The coercion a declared type needs, by helper name.
 *
 * `undefined` means "leave it alone": either the type is already what a query
 * string carries, or nothing about a string says how to become it.
 */
function coercerFor(ir: TypeIR): string | undefined {
  switch (ir.kind) {
    case "primitive":
      switch (ir.type) {
        case "number":
          return "__wizQueryNumber";
        case "bigint":
          return "__wizQueryBigInt";
        case "boolean":
          return "__wizQueryBoolean";
        case "date":
          return "__wizQueryDate";
        default:
          return undefined;
      }

    case "literal":
      // A literal's own type says what to coerce to, so `?page=2` reaches a
      // `2` literal rather than being compared as `"2"`.
      if (typeof ir.value === "number") return "__wizQueryNumber";
      if (typeof ir.value === "boolean") return "__wizQueryBoolean";
      if (typeof ir.value === "bigint") return "__wizQueryBigInt";
      return undefined;

    case "enum": {
      const numeric = ir.members.every((member) => typeof member.value === "number");
      return numeric ? "__wizQueryNumber" : undefined;
    }

    case "union": {
      // Only when every member wants the same thing. A union of a number and a
      // string has no single answer, and guessing would make `?q=7` a number
      // in a field that accepts both - a coercion the caller never asked for.
      const coercers = new Set(ir.types.map(coercerFor));
      return coercers.size === 1 ? [...coercers][0] : undefined;
    }

    default:
      return undefined;
  }
}

/** The expression that turns `access` into the value the type declares. */
function coerceExpression(ir: TypeIR, access: string): string {
  if (ir.kind === "array") {
    // A repeated key is how a query string spells a list, and a single
    // occurrence is a list of one - which is why this cannot just check
    // `Array.isArray`.
    const element = coerceExpression(ir.element, "item");
    return element === "item"
      ? `__wizQueryArray(${access})`
      : `__wizQueryArray(${access}).map((item) => ${element})`;
  }

  const coercer = coercerFor(ir);
  return coercer ? `${coercer}(${access})` : access;
}

/** Whether the schema declares fields beyond the ones it names. */
function isOpen(ir: ObjectTypeIR): boolean {
  return ir.additionalProperties !== undefined && ir.additionalProperties !== false;
}
export class QueryValidationError extends Error {
  readonly errors: ValidationError[];

  constructor(errors: ValidationError[]) {
    super(
      "Invalid query: " +
        errors
          .map((error) => (error.path ? error.path + ": " + error.message : error.message))
          .join("; ")
    );
    this.name = "QueryValidationError";
    this.errors = errors;
  }
}

const ERROR_CLASS = [
  `/** A query string that does not match the type it was parsed against. */`,
  `export class QueryValidationError extends Error {`,
  `  constructor(errors) {`,
  `    super(`,
  `      "Invalid query: " +`,
  `        errors`,
  `          .map((error) => (error.path ? error.path + ": " + error.message : error.message))`,
  `          .join("; ")`,
  `    );`,
  `    this.name = "QueryValidationError";`,
  `    this.errors = errors;`,
  `  }`,
  `}`,
].join("\n");

const RUNTIME = [
  `function __wizQuerySource(input) {`,
  `  let source = input;`,
  `  // A leading "?" is part of how a query string is written, not of its content.`,
  `  if (typeof source === "string") source = new URLSearchParams(source.replace(/^\\?/, ""));`,
  `  if (typeof URLSearchParams !== "undefined" && source instanceof URLSearchParams) {`,
  `    const out = {};`,
  `    for (const key of source.keys()) {`,
  `      if (out[key] !== undefined) continue;`,
  `      const all = source.getAll(key);`,
  `      // One occurrence is a scalar, several are a list: an array type turns a`,
  `      // scalar into a list of one, and a scalar type reports the list.`,
  `      out[key] = all.length > 1 ? all : all[0];`,
  `    }`,
  `    return out;`,
  `  }`,
  `  if (source === null || typeof source !== "object") {`,
  `    throw new QueryValidationError([`,
  `      { path: "", message: "Expected ${INPUT_TYPES}", expected: ${JSON.stringify(INPUT_TYPES)}, actual: source === null ? "null" : typeof source },`,
  `    ]);`,
  `  }`,
  `  return source;`,
  `}`,
  ``,
  `// Every coercion below returns its input unchanged when it cannot convert,`,
  `// leaving the verdict to validate() rather than reporting anything itself.`,
  `function __wizQueryNumber(value) {`,
  `  if (typeof value !== "string" || value.trim() === "") return value;`,
  `  const parsed = Number(value);`,
  `  return Number.isNaN(parsed) ? value : parsed;`,
  `}`,
  ``,
  `function __wizQueryBigInt(value) {`,
  `  if (typeof value !== "string") return value;`,
  `  try {`,
  `    return BigInt(value);`,
  `  } catch {`,
  `    return value;`,
  `  }`,
  `}`,
  ``,
  `function __wizQueryBoolean(value) {`,
  `  // The four spellings a query string uses for a flag. "on"/"off" are left`,
  `  // out on purpose: they are a form-encoding convention, not a boolean.`,
  `  if (value === "true" || value === "1") return true;`,
  `  if (value === "false" || value === "0") return false;`,
  `  return value;`,
  `}`,
  ``,
  `function __wizQueryDate(value) {`,
  `  if (typeof value !== "string") return value;`,
  `  const parsed = new Date(value);`,
  `  return Number.isNaN(parsed.getTime()) ? value : parsed;`,
  `}`,
  ``,
  `function __wizQueryArray(value) {`,
  `  if (value === undefined) return value;`,
  `  return Array.isArray(value) ? value : [value];`,
  `}`,
].join("\n");

/**
 * A `parseQuery` that coerces and then validates.
 *
 * Only an object type gets a real one: a query string is a set of named
 * fields, so there is nothing for a primitive or an array to parse into. The
 * rest get a throwing stub, the same way an unsupported operation does in the
 * client emitter, because the mistake is at the callsite and a stub says so.
 */
export function generateQueryParserCode(ir: TypeIR): string {
  if (ir.kind !== "object") {
    return [
      ERROR_CLASS,
      ``,
      `export function parseQuery() {`,
      `  throw new Error(`,
      `    "[wiz] parseQuery needs an object type: a query string is a set of named fields, and ${ir.kind} has none"`,
      `  );`,
      `}`,
    ].join("\n");
  }

  const lines: string[] = [
    ERROR_CLASS,
    ``,
    RUNTIME,
    ``,
    `/**`,
    ` * Parses a query string into the type it should produce.`,
    ` *`,
    ` * Accepts a ${INPUT_TYPES}. Declared fields are coerced to the types the`,
    ` * type declares; anything that cannot be converted is left as it arrived,`,
    ` * so validate() reports it. Throws QueryValidationError on any failure.`,
    ` */`,
    `export function parseQuery(input, options = {}) {`,
    `  const source = __wizQuerySource(input);`,
    // Open schemas keep what they did not name: those fields are declared, just
    // not individually, so dropping them would discard expected data.
    isOpen(ir) ? `  const out = { ...source };` : `  const out = {};`,
    ``,
  ];

  for (const property of ir.properties) {
    const key = JSON.stringify(property.name);
    lines.push(`  {`);
    lines.push(`    const value = source[${key}];`);
    lines.push(
      `    if (value !== undefined) out[${key}] = ${coerceExpression(property.type, "value")};`
    );
    lines.push(`  }`);
  }

  lines.push(``);
  lines.push(`  const errors = validate(out, options);`);
  lines.push(`  if (errors.length > 0) throw new QueryValidationError(errors);`);
  lines.push(`  return out;`);
  lines.push(`}`);

  return lines.join("\n");
}
