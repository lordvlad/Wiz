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
}

export interface AppliedPlugins {
  /** Clones, with every `type` hook applied. Only `model.ts` reads these. */
  types: Map<string, TypeIR>;
  /** Renders one declaration, or nothing when no plugin claims it. */
  declaration(
    name: string,
    ir: TypeIR,
    identifiers: ReadonlyMap<string, string>
  ): string | undefined;
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
  logger: WizLogger
): AppliedPlugins {
  if (plugins.length === 0) {
    return { types: new Map(declared), declaration: () => undefined };
  }

  // One call, so references shared between two named types stay shared -
  // cloning per root would fork them into unrelated copies.
  const types = structuredClone(new Map(declared));

  const claimed = new Set(plugins.flatMap((plugin) => plugin.extensions));
  const warned = new Set<string>();

  for (const [name, root] of types) {
    walkTypeIR(root, (node) => {
      const extensions = node.extensions;
      if (!extensions) return;
      for (const key of Object.keys(extensions)) {
        if (claimed.has(key) || warned.has(key)) continue;
        warned.add(key);
        logger.warn(`[wiz] no plugin handles vendor extension '${key}'; it is dropped`);
      }
      for (const plugin of plugins) {
        plugin.type?.({ node, name, extensions, logger });
      }
    });
  }

  return {
    types,
    declaration(name, ir, identifiers) {
      const extensions = ir.extensions;
      if (!extensions) return undefined;
      for (const plugin of plugins) {
        const rendered = plugin.declaration?.({
          ir,
          name,
          identifiers,
          extensions,
          logger,
        });
        if (rendered !== undefined) return rendered;
      }
      return undefined;
    },
  };
}

/**
 * The `x-*` value as a list, or nothing when the schema is not shaped as this
 * family of extensions is defined: one entry per enum value, in order.
 */
function positionalList(
  input: TsClientTypeInput,
  key: string
): unknown[] | undefined {
  const { node, name, logger } = input;
  const value = input.extensions[key];
  if (value === undefined) return undefined;
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
      `[wiz] ${key} on '${name}' lists ${value.length} entries for ${members} members; the extra ones are ignored`
    );
  } else if (value.length < members) {
    logger.warn(
      `[wiz] ${key} on '${name}' lists ${value.length} entries for ${members} members; the remaining members are undocumented`
    );
  }
  return value;
}

export const enumDescriptionsPlugin: TsClientPlugin = {
  name: "x-enum-descriptions",
  extensions: ["x-enum-descriptions"],
  type(input) {
    const list = positionalList(input, "x-enum-descriptions");
    if (!list || input.node.kind !== "enum") return;
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
    if (!list || input.node.kind !== "enum") return;

    const taken = new Set<string>();
    let repeated: string | undefined;
    input.node.members.forEach((member, index) => {
      const varname = list[index];
      const candidate =
        typeof varname === "string" && varname.length > 0 ? varname : member.name;
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
        `[wiz] x-enum-varnames on '${input.name}' repeats '${repeated}'; later members are suffixed`
      );
    }
  },
  declaration({ ir, name, identifiers, extensions }) {
    if (ir.kind !== "enum" || ir.members.length === 0) return undefined;
    // Only claim an enum this plugin actually renamed.
    if (!Array.isArray(extensions["x-enum-varnames"])) return undefined;

    const identifier = identifiers.get(name) ?? name;
    const entries = ir.members
      .map((member) => {
        const key = TS_IDENTIFIER.test(member.name)
          ? member.name
          : JSON.stringify(member.name);
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

/** Builtins, in the order they run. Varnames renders; descriptions supply text. */
export const BUILTIN_TS_CLIENT_PLUGINS: readonly TsClientPlugin[] = [
  enumVarnamesPlugin,
  enumDescriptionsPlugin,
];
