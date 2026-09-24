import { isUserNamedType, type Annotated, type TypeIR } from "../ir/types.ts";

/**
 * TypeIR rendered as TypeScript source.
 *
 * Every other generator in this directory targets a schema language, where a
 * type is data. Here it is code again, which changes two things: names matter,
 * because a reference is the only way to avoid inlining a schema ten times, and
 * constraints do not, because TypeScript cannot state them. The annotations
 * that survive become doc comments, so an editor still shows what the document
 * said.
 */

/** Words that cannot name a type, so a schema called `default` still compiles. */
const RESERVED: Record<string, true> = {
    any: true,
    boolean: true,
    break: true,
    case: true,
    catch: true,
    class: true,
    const: true,
    continue: true,
    debugger: true,
    declare: true,
    default: true,
    delete: true,
    do: true,
    else: true,
    enum: true,
    export: true,
    extends: true,
    false: true,
    finally: true,
    for: true,
    function: true,
    if: true,
    import: true,
    in: true,
    instanceof: true,
    never: true,
    new: true,
    null: true,
    number: true,
    object: true,
    return: true,
    string: true,
    super: true,
    switch: true,
    symbol: true,
    this: true,
    throw: true,
    true: true,
    try: true,
    typeof: true,
    undefined: true,
    unknown: true,
    var: true,
    void: true,
    while: true,
    with: true,
};

export const TS_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Maps declared schema names onto the identifiers the emitted code uses.
 *
 * `components.schemas` keys are free-form - `Pet.Dog`, `error-response`, `2xx`
 * are all legal - while a TypeScript declaration needs an identifier. The map
 * is built once and shared by the model and the client so a reference and its
 * declaration cannot drift apart.
 */
export function typeIdentifiers(names: Iterable<string>): Map<string, string> {
    const identifiers = new Map<string, string>();
    const taken: Record<string, true> = {};

    for (const name of names) {
        let candidate = name.replace(/[^A-Za-z0-9_$]/g, "_");
        if (!/^[A-Za-z_$]/.test(candidate)) {
            candidate = `_${candidate}`;
        }
        if (RESERVED[candidate]) {
            candidate = `${candidate}_`;
        }

        // Two schemas can sanitise onto one identifier; the second gets a suffix
        // rather than silently replacing the first.
        let unique = candidate;
        for (let index = 2; taken[unique]; index += 1) {
            unique = `${candidate}${index}`;
        }

        taken[unique] = true;
        identifiers.set(name, unique);
    }

    return identifiers;
}

/** A union or intersection needs parentheses before `[]` or inside an `&`. */
function parenthesized(text: string): string {
    return /[|&]/.test(text) && !text.startsWith("(") ? `(${text})` : text;
}

export function literalText(value: string | number | boolean | bigint | null): string {
    if (typeof value === "string") {
        return JSON.stringify(value);
    }
    if (typeof value === "bigint") {
        return `${value.toString()}n`;
    }
    return String(value);
}

/**
 * The doc comment for one node, or nothing when it has nothing to say.
 *
 * Constraints are deliberately absent: `@minLength` in a comment reads as if it
 * were enforced, and here nothing enforces it. Everything descriptive is kept.
 */
export function docComment(node: Annotated, indent: string): string {
    const lines: string[] = [];
    if (node.description) {
        lines.push(...node.description.split("\n"));
    }
    if (node.deprecated?.isDeprecated) {
        lines.push(`@deprecated${node.deprecated.note ? ` ${node.deprecated.note}` : ""}`);
    }
    for (const example of node.examples ?? []) {
        lines.push(`@example ${JSON.stringify(example)}`);
    }
    if (node.default !== undefined) {
        lines.push(`@default ${JSON.stringify(node.default)}`);
    }

    if (lines.length === 0) {
        return "";
    }
    if (lines.length === 1) {
        return `${indent}/** ${lines[0]} */\n`;
    }
    return `${indent}/**\n${lines.map((line) => `${indent} * ${line}`).join("\n")}\n${indent} */\n`;
}

function primitiveText(type: Extract<TypeIR, { kind: "primitive" }>["type"]): string {
    switch (type) {
        case "bytes":
            return "Uint8Array";
        case "date":
            return "Date";
        case "symbol":
            return "symbol";
        default:
            // Every remaining primitive already names a TypeScript type.
            return type;
    }
}

function objectText(
    ir: Extract<TypeIR, { kind: "object" }>,
    identifiers: ReadonlyMap<string, string>,
    indent: string,
): string {
    const inner = `${indent}  `;
    const members = ir.properties.map((property) => {
        const key = TS_IDENTIFIER.test(property.name) ? property.name : JSON.stringify(property.name);
        const optional = property.optional ? "?" : "";
        const readonly = property.readonly ? "readonly " : "";
        // A doc-commented enum body starts on its own line, so the usual space
        // after the colon would be trailing whitespace.
        const type = typeText(property.type, identifiers, inner);
        const gap = type.startsWith("\n") ? "" : " ";
        return `${docComment(property, inner)}${inner}${readonly}${key}${optional}:${gap}${type};`;
    });

    const index =
        ir.additionalProperties === undefined
            ? undefined
            : ir.additionalProperties === true
              ? "Record<string, unknown>"
              : ir.additionalProperties === false
                ? undefined
                : `Record<string, ${typeText(ir.additionalProperties, identifiers, indent)}>`;

    if (members.length === 0) {
        // A schema with no declared properties describes a free-form object; `{}`
        // would instead mean "anything but null", which is a different promise.
        return index ?? (ir.additionalProperties === false ? "Record<string, never>" : "Record<string, unknown>");
    }

    const body = `{\n${members.join("\n")}\n${indent}}`;
    return index ? `${body} & ${index}` : body;
}

/**
 * One type as a TypeScript type expression.
 *
 * A node that names a declared type is emitted as that name; anything else is
 * inlined. `tsDeclarations` is what breaks the recursion for the declarations
 * themselves, by rendering their bodies rather than their names.
 */
export function typeText(ir: TypeIR, identifiers: ReadonlyMap<string, string>, indent = ""): string {
    const declared = ir.name ? identifiers.get(ir.name) : undefined;
    if (declared && isUserNamedType(ir.name)) {
        return declared;
    }
    return typeBodyText(ir, identifiers, indent);
}

/** The structure of one type, ignoring any name it publishes. */
export function typeBodyText(ir: TypeIR, identifiers: ReadonlyMap<string, string>, indent = ""): string {
    switch (ir.kind) {
        case "primitive":
            return primitiveText(ir.type);
        case "literal":
            return literalText(ir.value);
        case "object":
            return objectText(ir, identifiers, indent);
        case "array": {
            const elemText = typeText(ir.element, identifiers, indent);
            if (ir.element.kind === "union" || ir.element.kind === "intersection" || ir.element.kind === "object") {
                return `Array<${elemText}>`;
            }
            return `${parenthesized(elemText)}[]`;
        }
        case "tuple": {
            const elements = ir.elements.map(
                (element) => `${typeText(element.type, identifiers, indent)}${element.optional ? " | undefined" : ""}`,
            );
            if (ir.rest) {
                elements.push(`...${parenthesized(typeText(ir.rest, identifiers, indent))}[]`);
            }
            return `[${elements.join(", ")}]`;
        }
        case "union": {
            const members: string[] = [];
            for (const member of ir.types) {
                const text = typeText(member, identifiers, indent);
                // The same member can arrive twice once names collapse to identifiers.
                if (!members.includes(text)) {
                    members.push(text);
                }
            }
            return members.length === 0 ? "never" : members.join(" | ");
        }
        case "intersection":
            return ir.types.map((member) => parenthesized(typeText(member, identifiers, indent))).join(" & ");
        case "enum": {
            if (ir.members.length === 0) {
                return "never";
            }
            if (!ir.members.some((member) => member.description)) {
                return ir.members.map((member) => literalText(member.value)).join(" | ");
            }
            const inner = `${indent}  `;
            return `\n${ir.members
                .map((member) => `${docComment(member, inner)}${inner}| ${literalText(member.value)}`)
                .join("\n")}`;
        }
        case "record":
            return `Record<${typeText(ir.keyType, identifiers, indent)}, ${typeText(ir.valueType, identifiers, indent)}>`;
        case "ref": {
            // A ref only names its target. Without a name there is nothing to point
            // at in TypeScript - the id is an extraction detail - so the shape is
            // left open rather than invented.
            const target = ir.name ? identifiers.get(ir.name) : undefined;
            return target ?? "unknown";
        }
    }
}

/**
 * Declarations for every named type, in the order they were declared.
 *
 * An object becomes an `interface` so a consumer can extend or merge it; every
 * other shape becomes a `type`, which is the only form that can hold a union,
 * a tuple or an intersection.
 */
export function tsDeclarations(
    types: Iterable<readonly [string, TypeIR]>,
    identifiers: ReadonlyMap<string, string>,
    override?: (name: string, ir: TypeIR, identifiers: ReadonlyMap<string, string>) => string | undefined,
): string {
    const blocks: string[] = [];

    for (const [name, ir] of types) {
        const replaced = override?.(name, ir, identifiers);
        if (replaced !== undefined) {
            blocks.push(replaced);
            continue;
        }

        const identifier = identifiers.get(name) ?? name;
        const doc = docComment(ir, "");

        if (ir.kind === "object" && ir.additionalProperties === undefined && ir.properties.length > 0) {
            blocks.push(`${doc}export interface ${identifier} ${objectText(ir, identifiers, "")}`);
            continue;
        }

        const body = typeBodyText(ir, identifiers, "");
        const gap = body.startsWith("\n") ? "" : " ";
        blocks.push(`${doc}export type ${identifier} =${gap}${body};`);
    }

    return blocks.join("\n\n");
}
