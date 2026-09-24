import type { TypeIR } from "../ir/types.ts";

/**
 * The JSON Schema subset that AsyncAPI and OpenRPC both embed, as `TypeIR`.
 *
 * OpenAPI has its own reader (`src/extractors/openapi.ts`): it carries
 * constraints, annotations, `allOf`, nullability and diagnostics that only a
 * document with `components.parameters` and media types needs. AsyncAPI and
 * OpenRPC embed plain schemas, and they used to embed a copy of this function
 * each - which is how `anyOf` of `const` came back as `unknown` in one of them
 * and a union of literals in the other.
 */
export interface SchemaIdSource {
    /** Monotonic counter for node ids, owned by the calling extractor. */
    ids: number;
}

const SCHEMAS_REF = "#/components/schemas/";

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function token(part: string): string {
    return part.replace(/~/g, "~0").replace(/\//g, "~1");
}

type LiteralValue = string | number | boolean | null;

export function jsonSchemaToIR(raw: unknown, ctx: SchemaIdSource, pointer: string): TypeIR {
    const nextId = (): string => `o_${++ctx.ids}`;

    if (raw === undefined || raw === true) {
        return { id: nextId(), kind: "primitive", type: "unknown" };
    }
    if (raw === false) {
        return { id: nextId(), kind: "primitive", type: "never" };
    }
    if (!isObject(raw)) {
        return { id: nextId(), kind: "primitive", type: "unknown" };
    }

    if (typeof raw.$ref === "string") {
        const ref = raw.$ref;
        if (ref.startsWith(SCHEMAS_REF) && ref.length > SCHEMAS_REF.length) {
            const name = ref.slice(SCHEMAS_REF.length);
            return { id: nextId(), kind: "ref", targetId: name, name };
        }
        return { id: nextId(), kind: "primitive", type: "unknown" };
    }

    // A fixed value is a literal whatever `type` says, and a list of them is an
    // enum. `wiz` spells a string union as `anyOf` of `const`, so a reader
    // without these turns a union of words back into `unknown`.
    if ("const" in raw) {
        return { id: nextId(), kind: "literal", value: raw.const as LiteralValue };
    }
    if (Array.isArray(raw.enum) && raw.enum.length > 0) {
        const values = raw.enum as LiteralValue[];
        if (values.length === 1) {
            return { id: nextId(), kind: "literal", value: values[0]! };
        }
        if (values.every((value) => typeof value === "string") || values.every((value) => typeof value === "number")) {
            return {
                id: nextId(),
                kind: "enum",
                members: values.map((value) => ({
                    name: String(value),
                    value: value as string | number,
                })),
            };
        }
        // A mixed-type enum is a union of literals, which is what it means.
        return {
            id: nextId(),
            kind: "union",
            types: values.map((value) => ({
                id: nextId(),
                kind: "literal" as const,
                value,
            })),
        };
    }

    const declared = raw.type;
    const typeName = typeof declared === "string" ? declared : undefined;

    if (typeName === "string") {
        return { id: nextId(), kind: "primitive", type: "string" };
    }
    if (typeName === "integer" || typeName === "number") {
        return { id: nextId(), kind: "primitive", type: "number" };
    }
    if (typeName === "boolean") {
        return { id: nextId(), kind: "primitive", type: "boolean" };
    }
    if (typeName === "null") {
        return { id: nextId(), kind: "primitive", type: "null" };
    }

    if (typeName === "array" || Array.isArray(raw.items)) {
        const itemSchema = isObject(raw.items) ? raw.items : {};
        return {
            id: nextId(),
            kind: "array",
            element: jsonSchemaToIR(itemSchema, ctx, `${pointer}/items`),
        };
    }

    if (typeName === "object" || isObject(raw.properties)) {
        const propsObj = isObject(raw.properties) ? raw.properties : {};
        const requiredList = Array.isArray(raw.required)
            ? raw.required.filter((name): name is string => typeof name === "string")
            : [];

        return {
            id: nextId(),
            kind: "object",
            properties: Object.entries(propsObj).map(([propName, propRaw]) => ({
                name: propName,
                type: jsonSchemaToIR(propRaw, ctx, `${pointer}/properties/${token(propName)}`),
                optional: !requiredList.includes(propName),
                // Same source the OpenAPI extractor reads it from.
                readonly: isObject(propRaw) && propRaw.readOnly === true,
                description:
                    isObject(propRaw) && typeof propRaw.description === "string" ? propRaw.description : undefined,
            })),
        };
    }

    if (Array.isArray(raw.oneOf) || Array.isArray(raw.anyOf)) {
        const members = (raw.oneOf ?? raw.anyOf) as unknown[];
        const key = Array.isArray(raw.oneOf) ? "oneOf" : "anyOf";
        return {
            id: nextId(),
            kind: "union",
            types: members.map((member, index) => jsonSchemaToIR(member, ctx, `${pointer}/${key}/${index}`)),
        };
    }

    return { id: nextId(), kind: "primitive", type: "unknown" };
}
