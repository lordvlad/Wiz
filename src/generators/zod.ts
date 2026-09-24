import type { Annotated, Constraint, TypeIR } from "../types.ts";
import { INTEGER_FORMATS, SAFE_INTEGER, STRING_FORMAT_REGEX, STRING_FORMATS } from "../types.ts";

/**
 * zod schemas, from the same IR every other back end reads.
 *
 * zod is an optional peer dependency, and a virtual module has no place on
 * disk to resolve one from, so this module never names zod at all: it exports
 * a function taking a loader, and the plugin passes `() => import("zod")` at
 * the callsite, inside the consumer's own file where the package resolves.
 * The import runs on the first call and never if there is not one, so a
 * program that asks for no zod schema neither loads zod nor needs it
 * installed. The promise is memoised, so every callsite for one type shares
 * a schema.
 *
 * What zod cannot express throws when the schema is built, rather than
 * validating loosely - the same choice the protobuf codec makes for a missing
 * `@fieldNumber`. A schema that quietly accepts what the type forbids is the
 * bug this repository keeps paying for.
 */

/** Which zod methods a constraint reaches for depends on what it constrains. */
type Family = "string" | "number" | "bigint" | "array";

/** Helpers the emitted schema needs, discovered while building it. */
interface Needs {
    unique: boolean;
}

export function generateZodSchemaCode(ir: TypeIR): string {
    const needs: Needs = { unique: false };
    const body = zodFor(ir, needs);

    // Structural equality by serialisation, which is weaker than the validator's
    // `__wizEqual` but needs no helper of its own inside a schema chain.
    const helpers = needs.unique
        ? [
              `    const __wizUnique = (items) => {`,
              `      const seen = new Set(items.map((item) => JSON.stringify(item)));`,
              `      return seen.size === items.length;`,
              `    };`,
          ]
        : [];

    return [
        `let __wizZodSchema;`,
        `// zod is loaded by the caller: the plugin writes the loader at the`,
        `// callsite, so the package resolves where that file lives, not in here.`,
        `export const zodSchema = (load) =>`,
        `  (__wizZodSchema ??= (async () => {`,
        `    const { z } = await load();`,
        ...helpers,
        `    return ${body};`,
        `  })());`,
    ].join("\n");
}

/** An expression that fails when the schema is built, naming what it cannot say. */
function inexpressible(what: string): string {
    return `(() => { throw new Error(${JSON.stringify(`[wiz] zod cannot express ${what}`)}); })()`;
}

function zodFor(ir: TypeIR, needs: Needs): string {
    return described(baseFor(ir, needs), ir);
}

function described(expr: string, node: Annotated): string {
    return node.description ? `${expr}.describe(${JSON.stringify(node.description)})` : expr;
}

/** The constraint family a node belongs to, or nothing when none applies. */
function familyOf(ir: TypeIR): Family | undefined {
    if (ir.kind === "array") {
        return "array";
    }
    if (ir.kind !== "primitive") {
        return undefined;
    }
    if (ir.type === "string" || ir.type === "number" || ir.type === "bigint") {
        return ir.type;
    }
    return undefined;
}

function baseFor(ir: TypeIR, needs: Needs): string {
    switch (ir.kind) {
        case "primitive":
            switch (ir.type) {
                case "string":
                    return constrain("z.string()", ir.constraints, "string", needs);
                case "number":
                    return constrain("z.number()", ir.constraints, "number", needs);
                case "bigint":
                    return constrain("z.bigint()", ir.constraints, "bigint", needs);
                case "boolean":
                    return "z.boolean()";
                case "null":
                    return "z.null()";
                case "undefined":
                    return "z.undefined()";
                case "void":
                    return "z.void()";
                case "never":
                    return "z.never()";
                case "unknown":
                    return "z.unknown()";
                case "any":
                    return "z.any()";
                case "bytes":
                    return "z.instanceof(Uint8Array)";
                case "date":
                    return "z.date()";
                case "symbol":
                    return inexpressible("a symbol: it has no value shape to check");
            }
            break;

        case "literal":
            return `z.literal(${literalValue(ir.value)})`;

        case "enum": {
            if (ir.members.length === 0) {
                return "z.never()";
            }
            if (ir.members.length === 1) {
                return `z.literal(${literalValue(ir.members[0]!.value)})`;
            }
            // `z.enum` takes string members only; a numeric enum is a union of the
            // literals it declares.
            if (ir.members.every((member) => typeof member.value === "string")) {
                return `z.enum([${ir.members.map((member) => JSON.stringify(member.value)).join(", ")}])`;
            }
            return `z.union([${ir.members.map((member) => `z.literal(${literalValue(member.value)})`).join(", ")}])`;
        }

        case "object":
            return objectFor(ir, needs);

        case "array":
            return constrain(`z.array(${zodFor(ir.element, needs)})`, ir.constraints, "array", needs);

        case "tuple": {
            // A zod tuple is fixed length: it has no way to say "and then more of
            // these", and no way to leave a member out.
            if (ir.rest) {
                return inexpressible("a tuple with a rest element");
            }
            if (ir.elements.some((element) => element.optional)) {
                return inexpressible("a tuple with optional elements");
            }
            return `z.tuple([${ir.elements.map((element) => zodFor(element.type, needs)).join(", ")}])`;
        }

        case "union": {
            // Unlike the JSON Schema back end, `undefined` members are kept: zod can
            // name that type, so dropping it would widen what the schema accepts.
            if (ir.types.length === 0) {
                return "z.never()";
            }
            if (ir.types.length === 1) {
                return zodFor(ir.types[0]!, needs);
            }
            return `z.union([${ir.types.map((member) => zodFor(member, needs)).join(", ")}])`;
        }

        case "intersection": {
            if (ir.types.length === 0) {
                return "z.unknown()";
            }
            return ir.types
                .map((member) => zodFor(member, needs))
                .reduce((left, right) => `z.intersection(${left}, ${right})`);
        }

        case "record":
            return `z.record(${zodFor(ir.keyType, needs)}, ${zodFor(ir.valueType, needs)})`;

        case "ref":
            // The generated validator answers `true` here for the same reason: a ref
            // is either a second sighting of a type already described at its own
            // site, or a cycle, which no finite inline schema can restate.
            return "z.any()";
    }

    return "z.any()";
}

function objectFor(ir: Extract<TypeIR, { kind: "object" }>, needs: Needs): string {
    const entries = ir.properties.map((prop) => {
        let value = baseFor(prop.type, needs);
        // A property's own constraints sit on top of its type's, exactly as the
        // JSON Schema back end applies them.
        value = constrain(value, prop.constraints, familyOf(prop.type), needs);
        value = described(value, prop.type);
        value = described(value, prop);
        if (prop.optional) {
            value += ".optional()";
        }
        return `${propertyKey(prop.name)}: ${value}`;
    });

    const shape = `z.object({ ${entries.join(", ")} })`;

    if (ir.additionalProperties === undefined) {
        return shape;
    }
    if (ir.additionalProperties === true) {
        return `${shape}.passthrough()`;
    }
    if (ir.additionalProperties === false) {
        return `${shape}.strict()`;
    }
    return `${shape}.catchall(${zodFor(ir.additionalProperties, needs)})`;
}

function constrain(
    expr: string,
    constraints: Constraint[] | undefined,
    family: Family | undefined,
    needs: Needs,
): string {
    if (!family || !constraints || constraints.length === 0) {
        return expr;
    }

    let out = expr;
    // `refine` turns the schema into a `ZodEffects`, which no longer carries the
    // per-family methods, so it has to come last.
    let refine = "";

    for (const c of constraints) {
        switch (c.kind) {
            case "min":
            case "minimum":
                if (family === "number" || family === "bigint") {
                    out += `.min(${scalar(c.value, family)})`;
                }
                break;
            case "max":
            case "maximum":
                if (family === "number" || family === "bigint") {
                    out += `.max(${scalar(c.value, family)})`;
                }
                break;
            case "exclusiveMinimum":
                if (family === "number" || family === "bigint") {
                    out += `.gt(${scalar(c.value, family)})`;
                }
                break;
            case "exclusiveMaximum":
                if (family === "number" || family === "bigint") {
                    out += `.lt(${scalar(c.value, family)})`;
                }
                break;
            case "multipleOf":
                if (family === "number") {
                    out += `.multipleOf(${Number(c.value)})`;
                }
                break;
            case "minLength":
                if (family === "string") {
                    out += `.min(${Number(c.value)})`;
                }
                break;
            case "maxLength":
                if (family === "string") {
                    out += `.max(${Number(c.value)})`;
                }
                break;
            case "pattern":
                if (family === "string") {
                    out += `.regex(new RegExp(${JSON.stringify(String(c.value))}))`;
                }
                break;
            case "minItems":
                if (family === "array") {
                    out += `.min(${Number(c.value)})`;
                }
                break;
            case "maxItems":
                if (family === "array") {
                    out += `.max(${Number(c.value)})`;
                }
                break;
            case "uniqueItems":
                // `@uniqueItems false` states no requirement, so it must not impose one.
                if (family === "array" && c.value !== false) {
                    needs.unique = true;
                    refine = `.refine(__wizUnique, { message: "Array items must be unique" })`;
                }
                break;
            case "format":
                out += formatFor(c.value, family);
                break;
        }
    }

    return out + refine;
}

/**
 * The formats the generated validator actually enforces, and no others: a
 * check nobody declared would reject data the type allows.
 *
 * Every string format past `email` and `uuid` is emitted as `.regex()` over
 * the *same* source {@link STRING_FORMATS} gives the validator, so the two
 * cannot disagree about a value. zod has natives for a few of them
 * (`.url()`, `.ip()`), but they are its own definitions rather than this
 * table's, and a schema that accepts what the validator rejects is worse than
 * a less idiomatic chain.
 */
function formatFor(value: unknown, family: Family): string {
    if (typeof value !== "string") {
        return "";
    }

    if (family === "string") {
        // Kept native, and the one place the two back ends can differ: zod's
        // `.email()` is its own definition, stricter than this table's
        // deliberately loose pattern, so it rejects `mailto:a@b.co` where the
        // validator accepts it. Left as it was rather than quietly loosening zod
        // or tightening a pattern chosen to accept addresses that deliver;
        // `test/formats.test.ts` pins the difference so it stays known.
        if (value === "email") {
            return ".email()";
        }
        if (value === "uuid") {
            return ".uuid()";
        }

        const format = STRING_FORMATS[value];
        if (format) {
            return `.regex(new RegExp(${JSON.stringify(format.pattern)}))`;
        }
        if (value === STRING_FORMAT_REGEX) {
            // Not a pattern: mirrors the validator's compile check.
            return `.refine((v) => { try { new RegExp(v); return true; } catch { return false; } })`;
        }
        return "";
    }

    const range = INTEGER_FORMATS[value];
    if (!range) {
        return "";
    }

    if (family === "bigint") {
        return `.min(${range.min}n).max(${range.max}n)`;
    }

    if (family === "number") {
        // A bound a `number` cannot hold exactly is left out rather than rounded:
        // rounded, it would reject values the width allows.
        let out = ".int()";
        if (range.min >= -SAFE_INTEGER) {
            out += `.min(${Number(range.min)})`;
        }
        if (range.max <= SAFE_INTEGER) {
            out += `.max(${Number(range.max)})`;
        }
        return out;
    }

    return "";
}

function scalar(value: unknown, family: "number" | "bigint"): string {
    if (family === "number") {
        return String(Number(value));
    }
    const asBigInt = typeof value === "bigint" ? value : BigInt(Math.trunc(Number(value)));
    return `${asBigInt}n`;
}

function literalValue(value: string | number | boolean | bigint | null): string {
    // `JSON.stringify` refuses a BigInt outright, and zod takes the literal.
    return typeof value === "bigint" ? `${value}n` : JSON.stringify(value);
}

function propertyKey(name: string): string {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}
