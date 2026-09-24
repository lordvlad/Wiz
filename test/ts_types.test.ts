// @wiz-ignore
import { describe, expect, test } from "bun:test";
import { docComment, tsDeclarations, typeIdentifiers, typeText } from "../src/generators/tsTypes.ts";
import type { TypeIR } from "../src/types.ts";

const NONE = new Map<string, string>();

const primitive = (type: Extract<TypeIR, { kind: "primitive" }>["type"]): TypeIR => ({
    id: "p",
    kind: "primitive",
    type,
});

describe("TypeIR as TypeScript", () => {
    test("primitives keep their TypeScript spelling, with the two opaque scalars named", () => {
        expect(typeText(primitive("string"), NONE)).toBe("string");
        expect(typeText(primitive("number"), NONE)).toBe("number");
        expect(typeText(primitive("bigint"), NONE)).toBe("bigint");
        expect(typeText(primitive("boolean"), NONE)).toBe("boolean");
        expect(typeText(primitive("null"), NONE)).toBe("null");
        expect(typeText(primitive("unknown"), NONE)).toBe("unknown");
        // `Uint8Array` and `Date` are scalars in the IR; in TypeScript they are
        // the classes again.
        expect(typeText(primitive("bytes"), NONE)).toBe("Uint8Array");
        expect(typeText(primitive("date"), NONE)).toBe("Date");
    });

    test("literals are emitted as literal types", () => {
        expect(typeText({ id: "l", kind: "literal", value: "draft" }, NONE)).toBe('"draft"');
        expect(typeText({ id: "l", kind: "literal", value: 7 }, NONE)).toBe("7");
        expect(typeText({ id: "l", kind: "literal", value: true }, NONE)).toBe("true");
        expect(typeText({ id: "l", kind: "literal", value: 9n }, NONE)).toBe("9n");
    });

    test("an object carries optionality, readonly and quoted keys", () => {
        const ir: TypeIR = {
            id: "o",
            kind: "object",
            properties: [
                {
                    name: "id",
                    type: primitive("string"),
                    optional: false,
                    readonly: true,
                    description: "Server assigned",
                },
                { name: "note", type: primitive("string"), optional: true, readonly: false },
                { name: "x-trace", type: primitive("string"), optional: false, readonly: false },
            ],
        };

        const text = typeText(ir, NONE);
        expect(text).toContain("/** Server assigned */");
        expect(text).toContain("readonly id: string;");
        expect(text).toContain("note?: string;");
        expect(text).toContain('"x-trace": string;');
    });

    test("an index signature becomes an intersection, and a bare object stays open", () => {
        const withIndex: TypeIR = {
            id: "o",
            kind: "object",
            properties: [{ name: "id", type: primitive("string"), optional: false, readonly: false }],
            additionalProperties: primitive("number"),
        };
        expect(typeText(withIndex, NONE)).toContain("} & Record<string, number>");

        const free: TypeIR = { id: "o", kind: "object", properties: [] };
        expect(typeText(free, NONE)).toBe("Record<string, unknown>");

        const closed: TypeIR = {
            id: "o",
            kind: "object",
            properties: [],
            additionalProperties: false,
        };
        expect(typeText(closed, NONE)).toBe("Record<string, never>");
    });

    test("compound types parenthesise where precedence demands it", () => {
        const union: TypeIR = {
            id: "u",
            kind: "union",
            types: [primitive("string"), primitive("number"), primitive("string")],
        };
        // The repeated member collapses rather than being emitted twice.
        expect(typeText(union, NONE)).toBe("string | number");

        const array: TypeIR = { id: "a", kind: "array", element: union };
        expect(typeText(array, NONE)).toBe("Array<string | number>");

        const tuple: TypeIR = {
            id: "t",
            kind: "tuple",
            elements: [
                { type: primitive("string"), optional: false },
                { type: primitive("number"), optional: true },
            ],
            rest: primitive("boolean"),
        };
        expect(typeText(tuple, NONE)).toBe("[string, number | undefined, ...boolean[]]");

        const record: TypeIR = {
            id: "r",
            kind: "record",
            keyType: primitive("string"),
            valueType: union,
        };
        expect(typeText(record, NONE)).toBe("Record<string, string | number>");
    });

    test("an enum is a union of its values, not a runtime enum", () => {
        const ir: TypeIR = {
            id: "e",
            kind: "enum",
            members: [
                { name: "Draft", value: "draft" },
                { name: "Live", value: 2 },
            ],
        };
        expect(typeText(ir, NONE)).toBe('"draft" | 2');
    });

    test("a named type is referenced once it is declared, and inlined otherwise", () => {
        const pet: TypeIR = {
            id: "o",
            kind: "object",
            name: "Pet",
            properties: [{ name: "id", type: primitive("string"), optional: false, readonly: false }],
        };

        expect(typeText(pet, new Map([["Pet", "Pet"]]))).toBe("Pet");
        expect(typeText(pet, NONE)).toContain("id: string;");
    });

    test("a ref points at its target's identifier, and at nothing without a name", () => {
        expect(typeText({ id: "r", kind: "ref", targetId: "o", name: "Pet" }, new Map([["Pet", "Pet"]]))).toBe("Pet");
        expect(typeText({ id: "r", kind: "ref", targetId: "o" }, NONE)).toBe("unknown");
    });
});

describe("declaration identifiers", () => {
    test("document names are sanitised, deduped and kept clear of keywords", () => {
        const identifiers = typeIdentifiers(["Pet", "error-response", "error.response", "2xx", "default"]);

        expect(identifiers.get("Pet")).toBe("Pet");
        expect(identifiers.get("error-response")).toBe("error_response");
        // The second name sanitises onto the first, so it is suffixed instead of
        // silently replacing it.
        expect(identifiers.get("error.response")).toBe("error_response2");
        expect(identifiers.get("2xx")).toBe("_2xx");
        expect(identifiers.get("default")).toBe("default_");
    });

    test("objects become interfaces and everything else a type alias", () => {
        const types: Array<readonly [string, TypeIR]> = [
            [
                "Pet",
                {
                    id: "o",
                    kind: "object",
                    name: "Pet",
                    properties: [{ name: "id", type: primitive("string"), optional: false, readonly: false }],
                },
            ],
            [
                "Status",
                {
                    id: "u",
                    kind: "union",
                    name: "Status",
                    types: [
                        { id: "l1", kind: "literal", value: "on" },
                        { id: "l2", kind: "literal", value: "off" },
                    ],
                },
            ],
        ];

        const source = tsDeclarations(types, typeIdentifiers(["Pet", "Status"]));
        expect(source).toContain("export interface Pet {");
        expect(source).toContain('export type Status = "on" | "off";');
    });
});

describe("doc comments", () => {
    test("descriptive annotations survive; constraints do not", () => {
        const comment = docComment(
            {
                description: "The account holder",
                deprecated: { isDeprecated: true, note: "Use owner" },
                examples: [{ id: 1 }],
                default: "anon",
                constraints: [{ kind: "minLength", value: 2 }],
            },
            "",
        );

        expect(comment).toContain("The account holder");
        expect(comment).toContain("@deprecated Use owner");
        expect(comment).toContain('@example {"id":1}');
        expect(comment).toContain('@default "anon"');
        // A constraint in a comment reads as enforced, and nothing here enforces it.
        expect(comment).not.toContain("minLength");
    });

    test("a node with nothing to say gets no comment", () => {
        expect(docComment({}, "")).toBe("");
    });
});
