import { walkTypeIR, type TypeIR } from "../ir/types.ts";
import type { WizLogger } from "../logger.ts";
import { docComment, literalText, TS_IDENTIFIER } from "./tsTypes.ts";

/**
 * The seam through which OpenAPI vendor extensions shape the emitted client.
 *
 * An `x-*` keyword is by definition something the spec does not model, so the
 * generator cannot honour it structurally; a plugin says what one means here.
 * Two hooks, because the two builtins need different reach: a description is
 * *data* the ordinary renderer can honour, while `x-enum-varnames` needs a
 * different declaration *shape*.
 */

export interface TsClientPluginContext {
    logger: WizLogger;
    /** The name the type is declared under in `model.ts`, before identifier mapping. */
    name: string;
    /** `x-*` keywords on the node being visited, verbatim. */
    extensions: Readonly<Record<string, unknown>>;
}

export interface TsClientTypeInput extends TsClientPluginContext {
    /**
     * A generator-local clone. Mutating it is the supported way to transform;
     * the extracted IR the codecs and validators read is untouched.
     */
    node: TypeIR;
}

export interface TsClientDeclarationInput extends TsClientPluginContext {
    /** The whole declared type, after every plugin's `type` hook has run. */
    ir: TypeIR;
    identifiers: ReadonlyMap<string, string>;
}

export interface TsClientResponseInput extends TsClientPluginContext {
    /**
     * The emitted expression holding the decoded response body, to be wrapped
     * or replaced. It is TypeScript source, not a value: this runs at
     * generation time.
     */
    body: string;
}

export interface TsClientPlugin {
    /** Used in diagnostics. */
    name: string;
    /** The `x-*` keys this plugin consumes, so an unclaimed one can be reported. */
    extensions: readonly string[];
    /** Rewrites one IR node in place, before any declaration is rendered. */
    type?(input: TsClientTypeInput): void;
    /**
     * Renders the entire `export ...` block for one declared type. The first
     * plugin to return a string wins; later plugins are skipped for that type.
     */
    declaration?(input: TsClientDeclarationInput): string | undefined;
    /**
     * Rewrites the expression a response body is read from, before it is cast
     * to the declared type. The first plugin to return a string wins.
     */
    responseBody?(input: TsClientResponseInput): string | undefined;
}

export interface AppliedPlugins {
    /** Clones, with every `type` hook applied. Only `model.ts` reads these. */
    types: Map<string, TypeIR>;
    /** Renders one declaration, or nothing when no plugin claims it. */
    declaration(name: string, ir: TypeIR, identifiers: ReadonlyMap<string, string>): string | undefined;
    /**
     * The expression one operation's response body is read from, wrapped by
     * whichever plugin claims the response's extensions.
     */
    responseBody(name: string, extensions: Record<string, unknown> | undefined, body: string): string;
}

/**
 * Clones the declared types, runs every `type` hook over the clones, and hands
 * back a declaration renderer.
 *
 * The clone is what keeps this safe: codecs, validators and `api.ts` read the
 * extracted IR, so a plugin renaming an enum member here cannot change a
 * protobuf entry name or a registry hash.
 */
export function applyPlugins(
    declared: ReadonlyMap<string, TypeIR>,
    plugins: readonly TsClientPlugin[],
    logger: WizLogger,
): AppliedPlugins {
    if (plugins.length === 0) {
        return {
            types: new Map(declared),
            declaration: () => undefined,
            responseBody: (_name, _extensions, body) => body,
        };
    }

    // One call, so references shared between two named types stay shared -
    // cloning per root would fork them into unrelated copies.
    const types = structuredClone(new Map(declared));

    const claimed = new Set(plugins.flatMap((plugin) => plugin.extensions));
    const warned = new Set<string>();

    const warnUnclaimed = (extensions: Readonly<Record<string, unknown>>) => {
        for (const key of Object.keys(extensions)) {
            if (claimed.has(key) || warned.has(key)) {
                continue;
            }
            warned.add(key);
            logger.warn(`[wiz] no plugin handles vendor extension '${key}'; it is dropped`);
        }
    };

    for (const [name, root] of types) {
        walkTypeIR(root, (node) => {
            const extensions = node.extensions;
            if (!extensions) {
                return;
            }
            warnUnclaimed(extensions);
            for (const plugin of plugins) {
                plugin.type?.({ node, name, extensions, logger });
            }
        });
    }

    return {
        types,
        declaration(name, ir, identifiers) {
            const extensions = ir.extensions;
            if (!extensions) {
                return undefined;
            }
            for (const plugin of plugins) {
                const rendered = plugin.declaration?.({
                    ir,
                    name,
                    identifiers,
                    extensions,
                    logger,
                });
                if (rendered !== undefined) {
                    return rendered;
                }
            }
            return undefined;
        },
        responseBody(name, extensions, body) {
            if (!extensions) {
                return body;
            }
            warnUnclaimed(extensions);
            for (const plugin of plugins) {
                const rewritten = plugin.responseBody?.({ name, extensions, body, logger });
                if (rewritten !== undefined) {
                    return rewritten;
                }
            }
            return body;
        },
    };
}

/**
 * The `x-*` value as a list, or nothing when the schema is not shaped as this
 * family of extensions is defined: one entry per enum value, in order.
 */
function positionalList(input: TsClientTypeInput, key: string): unknown[] | undefined {
    const { node, name, logger } = input;
    const value = input.extensions[key];
    if (value === undefined) {
        return undefined;
    }
    if (node.kind !== "enum") {
        logger.warn(`[wiz] ${key} on '${name}' is ignored; the schema is not an enum`);
        return undefined;
    }
    if (!Array.isArray(value)) {
        logger.warn(`[wiz] ${key} on '${name}' is ignored; expected an array of strings`);
        return undefined;
    }
    const members = node.members.length;
    if (value.length > members) {
        logger.warn(
            `[wiz] ${key} on '${name}' lists ${value.length} entries for ${members} members; the extra ones are ignored`,
        );
    } else if (value.length < members) {
        logger.warn(
            `[wiz] ${key} on '${name}' lists ${value.length} entries for ${members} members; the remaining members are undocumented`,
        );
    }
    return value;
}

export const enumDescriptionsPlugin: TsClientPlugin = {
    name: "x-enum-descriptions",
    extensions: ["x-enum-descriptions"],
    type(input) {
        const list = positionalList(input, "x-enum-descriptions");
        if (!list || input.node.kind !== "enum") {
            return;
        }
        input.node.members.forEach((member, index) => {
            const description = list[index];
            if (typeof description === "string" && description.length > 0) {
                member.description = description;
            }
        });
    },
};

export const enumVarnamesPlugin: TsClientPlugin = {
    name: "x-enum-varnames",
    extensions: ["x-enum-varnames"],
    type(input) {
        const list = positionalList(input, "x-enum-varnames");
        if (!list || input.node.kind !== "enum") {
            return;
        }

        const taken = new Set<string>();
        let repeated: string | undefined;
        input.node.members.forEach((member, index) => {
            const varname = list[index];
            const candidate = typeof varname === "string" && varname.length > 0 ? varname : member.name;
            // A repeated key is a duplicate property in the emitted const object,
            // which TypeScript rejects outright, so the later one is suffixed.
            let unique = candidate;
            for (let suffix = 2; taken.has(unique); suffix += 1) {
                repeated ??= candidate;
                unique = `${candidate}_${suffix}`;
            }
            taken.add(unique);
            member.name = unique;
        });

        if (repeated !== undefined) {
            input.logger.warn(
                `[wiz] x-enum-varnames on '${input.name}' repeats '${repeated}'; later members are suffixed`,
            );
        }
    },
    declaration({ ir, name, identifiers, extensions }) {
        if (ir.kind !== "enum" || ir.members.length === 0) {
            return undefined;
        }
        // Only claim an enum this plugin actually renamed.
        if (!Array.isArray(extensions["x-enum-varnames"])) {
            return undefined;
        }

        const identifier = identifiers.get(name) ?? name;
        const entries = ir.members
            .map((member) => {
                const key = TS_IDENTIFIER.test(member.name) ? member.name : JSON.stringify(member.name);
                return `${docComment(member, "  ")}  ${key}: ${literalText(member.value)},`;
            })
            .join("\n");

        // A const object plus a union alias, not a TypeScript `enum`: the union
        // keeps a bare `"active"` assignable wherever the type is expected, so no
        // emitted signature gets stricter than it was. The schema's own doc goes
        // on the const alone, so hover text is not shown twice.
        return `${docComment(ir, "")}export const ${identifier} = {\n${entries}\n} as const;\nexport type ${identifier} = (typeof ${identifier})[keyof typeof ${identifier}];`;
    },
};

/**
 * A dotted/indexed JSONPath rewritten as an optional-chained access, or
 * nothing when the selector uses anything outside that subset.
 *
 * The subset - `$.a`, `$["a"]`, `$[0]` and chains of them - is the part of
 * JSONPath that is also a TypeScript expression, so it needs no evaluator.
 * Optional chaining is deliberate: a wrapper the server omitted yields
 * `undefined`, which response validation reports, instead of a `TypeError`
 * thrown from inside the generated client.
 */
function jsonPathAccess(selector: string): string | undefined {
    if (!selector.startsWith("$")) {
        return undefined;
    }
    const segment = /\.([A-Za-z_$][A-Za-z0-9_$]*)|\[(\d+)\]|\["([^"\\]*)"\]|\['([^'\\]*)'\]/y;
    segment.lastIndex = 1;
    let access = "$";
    while (segment.lastIndex < selector.length) {
        const match = segment.exec(selector);
        if (!match) {
            return undefined;
        }
        const [, property, index, doubleQuoted, singleQuoted] = match;
        if (property !== undefined) {
            access += `?.${property}`;
        } else if (index !== undefined) {
            access += `?.[${index}]`;
        } else {
            access += `?.[${JSON.stringify(doubleQuoted ?? singleQuoted)}]`;
        }
    }
    return access;
}

/** Whether an expression parses, so a bad selector cannot break `api.ts`. */
function parses(expression: string): boolean {
    const source = `const __wizSelect = ($: any) => (${expression});`;
    try {
        if (typeof Bun === "undefined") {
            new Function("$", `return (${expression});`);
        } else {
            new Bun.Transpiler({ loader: "ts" }).transformSync(source);
        }
        return true;
    } catch {
        return false;
    }
}

/**
 * `x-select` on a Response Object: what to pull out of the payload before it
 * is cast to the declared type.
 *
 * It exists for the document that cannot describe the wire exactly - a schema
 * written against `data` while the server wraps it in `{ data, meta }`. The
 * selector is inlined into `api.ts` at generation time rather than compiled
 * with `new Function` at runtime: an emitted `new Function` would need
 * `unsafe-eval` in every browser consuming the client, would be invisible to
 * bundlers and type checking, and would move a spec author's code into the
 * consumer's runtime unreviewed. Inlined, it is ordinary source a human reads
 * in the diff.
 *
 * That is still a spec document contributing code, so anything beyond a plain
 * path is warned about.
 */
export const selectPlugin: TsClientPlugin = {
    name: "x-select",
    extensions: ["x-select"],
    responseBody({ extensions, name, body, logger }) {
        const selector = extensions["x-select"];
        if (selector === undefined) {
            return undefined;
        }
        if (typeof selector !== "string" || selector.trim() === "") {
            logger.warn(`[wiz] x-select on '${name}' is ignored; expected a non-empty string`);
            return undefined;
        }

        const expression = selector.trim();
        const path = jsonPathAccess(expression);
        if (path === "$") {
            return body;
        }
        if (path === undefined) {
            if (!parses(expression)) {
                logger.warn(
                    `[wiz] x-select on '${name}' is ignored; '${expression}' is neither a JSONPath nor an expression that parses`,
                );
                return undefined;
            }
            logger.warn(
                `[wiz] x-select on '${name}' is not a plain JSONPath; '${expression}' is inlined into the generated client and runs on every response - review it before shipping`,
            );
        }
        return `((($: any) => (${path ?? expression}))(${body}))`;
    },
};

/** Builtins, in the order they run. Varnames renders; descriptions supply text. */
export const BUILTIN_TS_CLIENT_PLUGINS: readonly TsClientPlugin[] = [
    enumVarnamesPlugin,
    enumDescriptionsPlugin,
    selectPlugin,
];
