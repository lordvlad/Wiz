import { dirname, resolve as resolvePath } from "node:path";
import {
  emptyApiComponents,
  type ApiDiagnostic,
  type ApiIR,
} from "../ir/api.ts";
import type {
  EnumMemberIR,
  PrimitiveTypeIR,
  PropertyIR,
  TypeIR,
  UnionTypeIR,
} from "../ir/types.ts";
import type { GrpcServiceMethodIR, ServiceIR } from "../ir/service.ts";

/**
 * `.proto` in, `ApiIR` out: the gRPC counterpart of the OpenAPI extractor.
 *
 * The tokenizer and parser below are hand-written rather than delegated to
 * protobufjs. This runs inside a build-time plugin, so a reflection library
 * would be a runtime dependency of every consumer, and the IR only cares about
 * a fraction of the grammar - descriptors, extensions, options and services'
 * custom annotations all end as diagnostics. protobufjs stays what it is best
 * at here: an independent oracle in the tests.
 */
export interface ExtractProtoOptions {
  /** Throw on the first diagnostic instead of collecting them. Default false. */
  strict?: boolean;
}

/* --------------------------------------------------------------- tokenizer */

interface Token {
  kind: "ident" | "number" | "string" | "punct";
  value: string;
  /**
   * The comment block that sat on its own line(s) directly above, cleaned of
   * its markers. A comment trailing a field on the same line documents that
   * field, not the next one, so it is dropped rather than misattributed.
   */
  comment?: string;
  line: number;
}

const PUNCTUATION = "{}()[]<>=;,:";

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isIdentStart(code: number): boolean {
  return (
    (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95
  );
}

function isIdentPart(code: number): boolean {
  return isIdentStart(code) || isDigit(code);
}

/** Strips `//`, `/*` and per-line `*` decoration without touching the prose. */
function cleanComment(lines: string[]): string {
  return lines
    .map((line) => line.replace(/^\s*(?:\/\/+|\*+|\/\*+|\*+\/)\s?/, "").trimEnd())
    .join("\n")
    .trim();
}

function tokenize(text: string, path: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  let pending: string[] = [];
  // Whether anything other than whitespace has appeared on the current line.
  // Drives both comment attachment and the blank-line rule that cuts a pending
  // comment loose from a declaration it is no longer adjacent to.
  let sawContent = false;

  const fail = (message: string): never => {
    throw new Error(`[wiz] ${message} at ${path}:${line}`);
  };

  while (index < text.length) {
    const code = text.charCodeAt(index);

    if (code === 10) {
      if (!sawContent && pending.length > 0) pending = [];
      line += 1;
      sawContent = false;
      index += 1;
      continue;
    }
    if (code === 32 || code === 9 || code === 13 || code === 12) {
      index += 1;
      continue;
    }

    if (code === 47 && text.charCodeAt(index + 1) === 47) {
      const end = text.indexOf("\n", index);
      const stop = end === -1 ? text.length : end;
      if (!sawContent) pending.push(cleanComment([text.slice(index, stop)]));
      sawContent = true;
      index = stop;
      continue;
    }
    if (code === 47 && text.charCodeAt(index + 1) === 42) {
      const end = text.indexOf("*/", index + 2);
      if (end === -1) fail("unterminated block comment");
      const body = text.slice(index, end + 2);
      if (!sawContent) pending.push(cleanComment(body.split("\n")));
      sawContent = true;
      for (let i = 0; i < body.length; i += 1) {
        if (body.charCodeAt(i) === 10) line += 1;
      }
      index = end + 2;
      continue;
    }

    const comment = pending.length > 0 ? pending.join("\n") : undefined;
    pending = [];
    sawContent = true;
    const start = index;

    if (code === 34 || code === 39) {
      index += 1;
      while (index < text.length) {
        const c = text.charCodeAt(index);
        if (c === 92) {
          index += 2;
          continue;
        }
        if (c === code) break;
        if (c === 10) fail("unterminated string");
        index += 1;
      }
      if (index >= text.length) fail("unterminated string");
      const value = text.slice(start + 1, index);
      index += 1;
      tokens.push({ kind: "string", value, comment, line });
      continue;
    }

    const nextCode = text.charCodeAt(index + 1);
    if (isDigit(code) || ((code === 45 || code === 43) && isDigit(nextCode))) {
      index += 1;
      while (index < text.length) {
        const c = text.charCodeAt(index);
        const exponent =
          (c === 45 || c === 43) &&
          (text.charCodeAt(index - 1) === 101 ||
            text.charCodeAt(index - 1) === 69);
        if (isIdentPart(c) || c === 46 || exponent) {
          index += 1;
          continue;
        }
        break;
      }
      tokens.push({ kind: "number", value: text.slice(start, index), comment, line });
      continue;
    }

    // A dotted path is one name in every position it can appear, including the
    // leading dot that makes a type reference fully qualified.
    if (isIdentStart(code) || (code === 46 && isIdentStart(nextCode))) {
      index += 1;
      while (index < text.length) {
        const c = text.charCodeAt(index);
        if (isIdentPart(c)) {
          index += 1;
          continue;
        }
        if (c === 46 && isIdentStart(text.charCodeAt(index + 1))) {
          index += 1;
          continue;
        }
        break;
      }
      tokens.push({ kind: "ident", value: text.slice(start, index), comment, line });
      continue;
    }

    const punct = text[index]!;
    if (!PUNCTUATION.includes(punct)) fail(`unexpected character '${punct}'`);
    index += 1;
    tokens.push({ kind: "punct", value: punct, comment, line });
  }

  return tokens;
}

/* ------------------------------------------------------------------ parser */

interface FieldNode {
  kind: "field";
  name: string;
  /** Written type name, unresolved: scoping is a whole-program question. */
  type: string;
  number: number;
  repeated: boolean;
  /** The `optional` keyword, which is the only presence proto3 spells out. */
  optional: boolean;
  map?: { key: string; value: string };
  description?: string;
}

interface OneofNode {
  kind: "oneof";
  name: string;
  fields: FieldNode[];
  description?: string;
}

interface MessageNode {
  name: string;
  /** Fields and oneofs in declaration order, which the IR preserves. */
  members: Array<FieldNode | OneofNode>;
  messages: MessageNode[];
  enums: EnumNode[];
  description?: string;
}

interface EnumNode {
  name: string;
  values: { name: string; value: number }[];
  description?: string;
}

interface RpcNode {
  name: string;
  requestType: string;
  requestStream: boolean;
  responseType: string;
  responseStream: boolean;
  description?: string;
}

interface ServiceNode {
  name: string;
  rpcs: RpcNode[];
  description?: string;
}

interface ProtoFile {
  syntax?: string;
  package?: string;
  imports: string[];
  messages: MessageNode[];
  enums: EnumNode[];
  services: ServiceNode[];
}

/** Cursor over one file's tokens, plus what diagnostics need to name a spot. */
interface P {
  tokens: Token[];
  index: number;
  path: string;
  ctx: Ctx;
  /**
   * Package seen so far, so a parse-time diagnostic can point at
   * `pkg.Msg.field`. Files declare their package before their declarations;
   * one that does not simply gets an unprefixed pointer.
   */
  scope: string;
}

function peek(p: P): Token | undefined {
  return p.tokens[p.index];
}

function next(p: P): Token {
  const token = p.tokens[p.index];
  if (!token) {
    throw new Error(`[wiz] unexpected end of ${p.path}`);
  }
  p.index += 1;
  return token;
}

function accept(p: P, value: string): boolean {
  if (p.tokens[p.index]?.value !== value) return false;
  p.index += 1;
  return true;
}

function expect(p: P, value: string): Token {
  const token = next(p);
  if (token.value !== value) {
    throw new Error(
      `[wiz] expected '${value}' but found '${token.value}' at ${p.path}:${token.line}`
    );
  }
  return token;
}

function expectName(p: P): string {
  const token = next(p);
  if (token.kind !== "ident") {
    throw new Error(
      `[wiz] expected a name but found '${token.value}' at ${p.path}:${token.line}`
    );
  }
  return token.value;
}

function expectInteger(p: P): number {
  const token = next(p);
  const value = Number(token.value);
  if (token.kind !== "number" || !Number.isInteger(value)) {
    throw new Error(
      `[wiz] expected an integer but found '${token.value}' at ${p.path}:${token.line}`
    );
  }
  return value;
}

/**
 * Consumes an option, whatever it says. Options carry everything from gRPC
 * gateway routes to per-language codegen switches, none of which the IR
 * models, so the grammar has to be walked without being understood: the
 * aggregate form nests braces and brackets arbitrarily.
 */
function skipOption(p: P): void {
  let depth = 0;
  while (p.index < p.tokens.length) {
    const token = next(p);
    if (token.value === "{" || token.value === "[") depth += 1;
    else if (token.value === "}" || token.value === "]") depth -= 1;
    else if (token.value === ";" && depth <= 0) return;
  }
}

/** Consumes a `{ ... }` body, balanced, for constructs that are dropped whole. */
function skipBlock(p: P): void {
  while (p.index < p.tokens.length && peek(p)!.value !== "{") next(p);
  if (p.index >= p.tokens.length) return;
  let depth = 0;
  do {
    const token = next(p);
    if (token.value === "{") depth += 1;
    else if (token.value === "}") depth -= 1;
  } while (depth > 0 && p.index < p.tokens.length);
}

function skipStatement(p: P): void {
  while (p.index < p.tokens.length) {
    if (next(p).value === ";") return;
  }
}

function parseFieldOptions(p: P, pointer: string): void {
  let depth = 1;
  while (depth > 0 && p.index < p.tokens.length) {
    const token = next(p);
    if (token.value === "[" || token.value === "{") depth += 1;
    else if (token.value === "]" || token.value === "}") depth -= 1;
    else if (depth === 1 && token.value === "default") {
      diagnose(
        p.ctx,
        pointer,
        "default",
        "dropped proto2 field default; proto3 presence is the only default the IR carries"
      );
    }
  }
}

function parseField(p: P, scope: string, description?: string): FieldNode | undefined {
  let repeated = false;
  let optional = false;
  let required = false;

  for (;;) {
    if (accept(p, "repeated")) {
      repeated = true;
      continue;
    }
    if (accept(p, "optional")) {
      optional = true;
      continue;
    }
    if (accept(p, "required")) {
      required = true;
      continue;
    }
    break;
  }

  if (peek(p)?.value === "group") {
    next(p);
    const name = expectName(p);
    expect(p, "=");
    expectInteger(p);
    skipBlock(p);
    diagnose(
      p.ctx,
      `${scope}.${name}`,
      "group",
      "dropped proto2 group; declare it as a nested message instead"
    );
    return undefined;
  }

  let map: FieldNode["map"] | undefined;
  let type: string;
  if (peek(p)?.value === "map" && p.tokens[p.index + 1]?.value === "<") {
    next(p);
    expect(p, "<");
    const key = expectName(p);
    expect(p, ",");
    const value = expectName(p);
    expect(p, ">");
    map = { key, value };
    type = value;
  } else {
    type = expectName(p);
  }

  const name = expectName(p);
  expect(p, "=");
  const number = expectInteger(p);
  const pointer = `${scope}.${name}`;
  if (accept(p, "[")) parseFieldOptions(p, pointer);
  expect(p, ";");

  if (required) {
    diagnose(
      p.ctx,
      pointer,
      "required",
      "dropped proto2 'required'; the field is carried as present-or-absent"
    );
  }

  const field: FieldNode = { kind: "field", name, type, number, repeated, optional };
  if (map) field.map = map;
  if (description) field.description = description;
  return field;
}

function parseOneof(p: P, scope: string, description?: string): OneofNode {
  const name = expectName(p);
  const node: OneofNode = { kind: "oneof", name, fields: [] };
  if (description) node.description = description;

  expect(p, "{");
  while (!accept(p, "}")) {
    const token = peek(p)!;
    if (accept(p, ";")) continue;
    if (token.value === "option") {
      next(p);
      skipOption(p);
      continue;
    }
    const field = parseField(p, scope, token.comment);
    if (field) node.fields.push(field);
  }
  return node;
}

function parseEnum(p: P, scope: string, description?: string): EnumNode {
  const name = expectName(p);
  const node: EnumNode = { name, values: [] };
  if (description) node.description = description;
  const fqn = scope ? `${scope}.${name}` : name;

  expect(p, "{");
  while (!accept(p, "}")) {
    const token = peek(p)!;
    if (accept(p, ";")) continue;
    if (token.value === "option") {
      next(p);
      skipOption(p);
      continue;
    }
    if (token.value === "reserved") {
      next(p);
      skipStatement(p);
      diagnose(
        p.ctx,
        fqn,
        "reserved",
        "dropped 'reserved'; the IR records the names a message has, not the ones it may not have"
      );
      continue;
    }
    // A member comment has nowhere to live: `EnumMemberIR` is a name and a
    // value, by design, so it is read and discarded rather than stored.
    const valueName = expectName(p);
    expect(p, "=");
    const value = expectInteger(p);
    if (accept(p, "[")) parseFieldOptions(p, `${fqn}.${valueName}`);
    expect(p, ";");
    node.values.push({ name: valueName, value });
  }
  return node;
}

function parseMessage(p: P, scope: string, description?: string): MessageNode {
  const name = expectName(p);
  const node: MessageNode = { name, members: [], messages: [], enums: [] };
  if (description) node.description = description;
  const fqn = scope ? `${scope}.${name}` : name;

  expect(p, "{");
  while (!accept(p, "}")) {
    const token = peek(p)!;
    if (accept(p, ";")) continue;

    switch (token.value) {
      case "message":
        next(p);
        node.messages.push(parseMessage(p, fqn, token.comment));
        continue;
      case "enum":
        next(p);
        node.enums.push(parseEnum(p, fqn, token.comment));
        continue;
      case "oneof":
        next(p);
        node.members.push(parseOneof(p, fqn, token.comment));
        continue;
      case "option":
        next(p);
        skipOption(p);
        continue;
      case "extend":
        next(p);
        skipBlock(p);
        diagnose(
          p.ctx,
          fqn,
          "extend",
          "dropped 'extend'; the IR has no slot for a field added from outside its message"
        );
        continue;
      case "reserved":
      case "extensions":
        next(p);
        skipStatement(p);
        diagnose(
          p.ctx,
          fqn,
          token.value,
          `dropped '${token.value}'; the IR records the fields a message has, not the numbers it may not use`
        );
        continue;
      default: {
        const field = parseField(p, fqn, token.comment);
        if (field) node.members.push(field);
        continue;
      }
    }
  }
  return node;
}

function parseRpc(p: P, scope: string, description?: string): RpcNode {
  const name = expectName(p);
  expect(p, "(");
  const requestStream = accept(p, "stream");
  const requestType = expectName(p);
  expect(p, ")");
  expect(p, "returns");
  expect(p, "(");
  const responseStream = accept(p, "stream");
  const responseType = expectName(p);
  expect(p, ")");

  if (peek(p)?.value === "{") {
    skipBlock(p);
  } else {
    expect(p, ";");
  }

  const rpc: RpcNode = {
    name,
    requestType,
    requestStream,
    responseType,
    responseStream,
  };
  if (description) rpc.description = description;
  void scope;
  return rpc;
}

function parseService(p: P, scope: string, description?: string): ServiceNode {
  const name = expectName(p);
  const node: ServiceNode = { name, rpcs: [] };
  if (description) node.description = description;
  const fqn = scope ? `${scope}.${name}` : name;

  expect(p, "{");
  while (!accept(p, "}")) {
    const token = peek(p)!;
    if (accept(p, ";")) continue;
    if (token.value === "option") {
      next(p);
      skipOption(p);
      continue;
    }
    if (token.value === "rpc") {
      next(p);
      node.rpcs.push(parseRpc(p, fqn, token.comment));
      continue;
    }
    throw new Error(
      `[wiz] unexpected '${token.value}' in service '${fqn}' at ${p.path}:${token.line}`
    );
  }
  return node;
}

function parseProtoFile(ctx: Ctx, path: string, text: string): ProtoFile {
  const file: ProtoFile = {
    imports: [],
    messages: [],
    enums: [],
    services: [],
  };
  const p: P = { tokens: tokenize(text, path), index: 0, path, ctx, scope: "" };

  while (p.index < p.tokens.length) {
    const token = peek(p)!;
    if (accept(p, ";")) continue;

    switch (token.value) {
      case "syntax": {
        next(p);
        expect(p, "=");
        file.syntax = next(p).value;
        expect(p, ";");
        continue;
      }
      case "package": {
        next(p);
        file.package = expectName(p);
        p.scope = file.package;
        expect(p, ";");
        continue;
      }
      case "import": {
        next(p);
        // `public` and `weak` change how a descriptor re-exports an import,
        // which only matters to a compiler that emits descriptors.
        accept(p, "public");
        accept(p, "weak");
        const target = next(p);
        if (target.kind !== "string") {
          throw new Error(
            `[wiz] expected an import path but found '${target.value}' at ${path}:${target.line}`
          );
        }
        file.imports.push(target.value);
        expect(p, ";");
        continue;
      }
      case "option":
        next(p);
        skipOption(p);
        continue;
      case "message":
        next(p);
        file.messages.push(parseMessage(p, p.scope, token.comment));
        continue;
      case "enum":
        next(p);
        file.enums.push(parseEnum(p, p.scope, token.comment));
        continue;
      case "service":
        next(p);
        file.services.push(parseService(p, p.scope, token.comment));
        continue;
      case "extend":
        next(p);
        skipBlock(p);
        diagnose(
          ctx,
          p.scope || path,
          "extend",
          "dropped 'extend'; the IR has no slot for a field added from outside its message"
        );
        continue;
      default:
        throw new Error(
          `[wiz] unexpected '${token.value}' at ${path}:${token.line}`
        );
    }
  }

  if (file.syntax !== "proto3") {
    diagnose(
      ctx,
      file.package || path,
      "syntax",
      `expected syntax 'proto3' but found '${file.syntax ?? "none"}'; parsed best-effort as proto3`
    );
  }

  return file;
}

/* -------------------------------------------------------------- resolution */

interface ProtoScalar {
  type: PrimitiveTypeIR["type"];
  /** The width, where protobuf promises less than the JS type it lands in. */
  format?: string;
}

/**
 * Every proto3 scalar. A JS number *is* a double, so `double` is the one
 * spelling that needs no constraint; each other numeric name is narrower than
 * its carrier, and that narrowing is exactly what a `format` constraint says -
 * the same registry value the validator and the protobuf codec already read.
 * The 64-bit widths land on `bigint` because a `number` cannot hold them.
 */
const SCALARS: Record<string, ProtoScalar> = {
  double: { type: "number" },
  float: { type: "number", format: "float" },
  int32: { type: "number", format: "int32" },
  uint32: { type: "number", format: "uint32" },
  sint32: { type: "number", format: "sint32" },
  fixed32: { type: "number", format: "fixed32" },
  sfixed32: { type: "number", format: "sfixed32" },
  int64: { type: "bigint", format: "int64" },
  uint64: { type: "bigint", format: "uint64" },
  sint64: { type: "bigint", format: "sint64" },
  fixed64: { type: "bigint", format: "fixed64" },
  sfixed64: { type: "bigint", format: "sfixed64" },
  bool: { type: "boolean" },
  string: { type: "string" },
  bytes: { type: "bytes" },
};

/**
 * Well-known types with a JS shape that needs no struct. `Timestamp` is an
 * instant and `Duration` is ISO 8601 text, so both collapse to a primitive and
 * their `.proto` files never have to be read. Everything else under
 * `google.protobuf` - `Any`, `Struct`, `Empty`, the wrappers - is a message
 * whose meaning lives in the runtime, not in its fields, and is diagnosed.
 */
const WELL_KNOWN_TYPES: Record<string, PrimitiveTypeIR["type"]> = {
  "google.protobuf.Timestamp": "date",
  "google.protobuf.Duration": "string",
};

/** Imports satisfied by {@link WELL_KNOWN_TYPES} rather than from disk. */
const WELL_KNOWN_PREFIX = "google/protobuf/";

type Declaration =
  | { kind: "message"; fqn: string; node: MessageNode }
  | { kind: "enum"; fqn: string; node: EnumNode };

interface Unit {
  path: string;
  file: ProtoFile;
}

interface Ctx {
  /** Every declaration of every parsed unit, by fully qualified name. */
  declarations: Map<string, Declaration>;
  types: Map<string, TypeIR>;
  /** Names whose IR is mid-construction, which is what makes a `ref` needed. */
  building: Set<string>;
  diagnostics: ApiDiagnostic[];
  strict: boolean;
  /** Per-extraction node id counter, so two runs produce equal IR. */
  ids: number;
}

/** Ids only need to be unique within one extraction; `p_` marks the origin. */
function nextId(ctx: Ctx): string {
  return `p_${++ctx.ids}`;
}

function diagnose(
  ctx: Ctx,
  pointer: string,
  keyword: string,
  message: string
): void {
  if (ctx.strict) {
    throw new Error(`[wiz] ${message} at ${pointer}`);
  }
  ctx.diagnostics.push({ pointer, keyword, message });
}

function registerDeclarations(
  ctx: Ctx,
  scope: string,
  messages: MessageNode[],
  enums: EnumNode[]
): void {
  const register = (declaration: Declaration): boolean => {
    const existing = ctx.declarations.get(declaration.fqn);
    if (existing) {
      diagnose(
        ctx,
        declaration.fqn,
        "duplicate",
        `ignored a second declaration of '${declaration.fqn}'; the first one wins`
      );
      return false;
    }
    ctx.declarations.set(declaration.fqn, declaration);
    return true;
  };

  // Outer before inner, so `types` reads top-down for a human looking at it.
  for (const node of messages) {
    const fqn = scope ? `${scope}.${node.name}` : node.name;
    if (!register({ kind: "message", fqn, node })) continue;
    registerDeclarations(ctx, fqn, node.messages, node.enums);
  }
  for (const node of enums) {
    register({ kind: "enum", fqn: scope ? `${scope}.${node.name}` : node.name, node });
  }
}

/**
 * proto scoping: an unqualified name is looked up in the innermost enclosing
 * scope first and then outwards, so `Inner` inside `pkg.Outer` finds
 * `pkg.Outer.Inner` before `pkg.Inner`. A leading dot skips the search.
 */
function resolveDeclaration(
  ctx: Ctx,
  name: string,
  scope: string
): Declaration | undefined {
  if (name.startsWith(".")) return ctx.declarations.get(name.slice(1));

  let prefix = scope;
  for (;;) {
    const found = ctx.declarations.get(prefix ? `${prefix}.${name}` : name);
    if (found) return found;
    if (!prefix) return undefined;
    const cut = prefix.lastIndexOf(".");
    prefix = cut === -1 ? "" : prefix.slice(0, cut);
  }
}

function unknownIR(ctx: Ctx): PrimitiveTypeIR {
  return { id: nextId(ctx), kind: "primitive", type: "unknown" };
}

/**
 * The IR for a named type, built once and shared by every field that names it.
 * A reference that arrives while its own target is still being built would
 * recurse forever, and that is the one case a `ref` exists for.
 */
function declarationIR(ctx: Ctx, declaration: Declaration): TypeIR {
  const built = ctx.types.get(declaration.fqn);
  if (built) return built;
  if (ctx.building.has(declaration.fqn)) {
    return {
      id: nextId(ctx),
      kind: "ref",
      targetId: declaration.fqn,
      name: declaration.fqn,
    };
  }

  ctx.building.add(declaration.fqn);
  const ir =
    declaration.kind === "enum"
      ? enumIR(ctx, declaration)
      : messageIR(ctx, declaration.fqn, declaration.node);
  ctx.building.delete(declaration.fqn);
  ctx.types.set(declaration.fqn, ir);
  return ir;
}

function enumIR(
  ctx: Ctx,
  declaration: { fqn: string; node: EnumNode }
): TypeIR {
  const members: EnumMemberIR[] = declaration.node.values.map((value) => ({
    name: value.name,
    value: value.value,
  }));
  const ir: TypeIR = {
    id: nextId(ctx),
    name: declaration.fqn,
    kind: "enum",
    members,
  };
  if (declaration.node.description) ir.description = declaration.node.description;
  return ir;
}

/**
 * A field's type with `repeated` and `map` applied. The name is fully
 * qualified from the message that declares the field, which is the scope proto
 * resolves in.
 */
function fieldTypeIR(ctx: Ctx, field: FieldNode, scope: string, pointer: string): TypeIR {
  if (field.map) {
    return {
      id: nextId(ctx),
      kind: "record",
      keyType: singularIR(ctx, field.map.key, scope, pointer),
      valueType: singularIR(ctx, field.map.value, scope, pointer),
    };
  }
  const singular = singularIR(ctx, field.type, scope, pointer);
  return field.repeated
    ? { id: nextId(ctx), kind: "array", element: singular }
    : singular;
}

function singularIR(ctx: Ctx, name: string, scope: string, pointer: string): TypeIR {
  const scalar = SCALARS[name];
  if (scalar) {
    const ir: PrimitiveTypeIR = {
      id: nextId(ctx),
      kind: "primitive",
      type: scalar.type,
    };
    if (scalar.format) ir.constraints = [{ kind: "format", value: scalar.format }];
    return ir;
  }

  // A user declaration wins over a well-known name, so a package that declares
  // its own `Timestamp` keeps it.
  const declaration = resolveDeclaration(ctx, name, scope);
  if (declaration) return declarationIR(ctx, declaration);

  const qualified = name.startsWith(".") ? name.slice(1) : name;
  const wellKnown = WELL_KNOWN_TYPES[qualified];
  if (wellKnown) return { id: nextId(ctx), kind: "primitive", type: wellKnown };

  diagnose(
    ctx,
    pointer,
    "type",
    qualified.startsWith("google.protobuf.")
      ? `unmapped well-known type '${qualified}'; the field is carried as 'unknown'`
      : `unresolved type '${name}'; the field is carried as 'unknown'`
  );
  return unknownIR(ctx);
}

function messageIR(ctx: Ctx, fqn: string, node: MessageNode): TypeIR {
  const properties: PropertyIR[] = [];

  for (const member of node.members) {
    if (member.kind === "field") {
      const property: PropertyIR = {
        name: member.name,
        type: fieldTypeIR(ctx, member, fqn, `${fqn}.${member.name}`),
        optional: member.optional,
        readonly: false,
        fieldNumber: member.number,
      };
      if (member.description) property.description = member.description;
      properties.push(property);
      continue;
    }

    // A oneof is one property holding one of several shapes, and the numbers
    // travel positionally beside them: exactly what `NumberedUnion` produces on
    // the TypeScript side, so the protobuf generator reads both the same way.
    // The member *names* have no slot in a union and are dropped, as they are
    // for a `NumberedUnion`.
    const union: UnionTypeIR = {
      id: nextId(ctx),
      kind: "union",
      types: member.fields.map((field) =>
        fieldTypeIR(ctx, field, fqn, `${fqn}.${member.name}.${field.name}`)
      ),
      fieldNumbers: member.fields.map((field) => field.number),
    };
    const property: PropertyIR = {
      name: member.name,
      type: union,
      // At most one variant is set, and none has to be.
      optional: true,
      readonly: false,
    };
    if (member.description) property.description = member.description;
    properties.push(property);
  }

  const ir: TypeIR = {
    id: nextId(ctx),
    name: fqn,
    kind: "object",
    properties,
  };
  if (node.description) ir.description = node.description;
  return ir;
}

/**
 * An rpc payload, which must be a message: an enum or a scalar is not
 * addressable on the wire, and neither is a name that never resolved.
 */
function payloadIR(
  ctx: Ctx,
  name: string,
  scope: string,
  pointer: string,
  side: "request" | "response",
  streaming: boolean
): TypeIR {
  const declaration = resolveDeclaration(ctx, name, scope);
  if (declaration?.kind === "message") return declarationIR(ctx, declaration);

  const qualified = name.startsWith(".") ? name.slice(1) : name;
  const stream = streaming ? "streamed " : "";
  diagnose(
    ctx,
    pointer,
    "rpc",
    declaration
      ? `${stream}${side} type '${name}' is an enum, not a message; the payload is carried as 'unknown'`
      : qualified.startsWith("google.protobuf.")
        ? `unmapped well-known ${stream}${side} type '${qualified}'; the payload is carried as 'unknown'`
        : `unresolved ${stream}${side} type '${name}'; the payload is carried as 'unknown'`
  );
  return unknownIR(ctx);
}

function buildService(ctx: Ctx, units: Unit[], entry: Unit): ServiceIR {
  const service: ServiceIR = { kind: "service", methods: [] };
  // A proto file has no `info`: the package is the only identity on offer, and
  // it is the entry file's, even when an import contributes rpcs of its own.
  if (entry.file.package) service.name = entry.file.package;

  for (const unit of units) {
    const scope = unit.file.package ?? "";
    for (const node of unit.file.services) {
      const serviceFqn = scope ? `${scope}.${node.name}` : node.name;
      for (const rpc of node.rpcs) {
        const pointer = `${serviceFqn}.${rpc.name}`;
        const method: GrpcServiceMethodIR = {
          kind: "serviceMethod",
          protocol: "grpc",
          address: {
            protocol: "grpc",
            ...(unit.file.package ? { package: unit.file.package } : {}),
            service: node.name,
            method: rpc.name,
          },
          request: {
            protocol: "grpc",
            message: payloadIR(
              ctx,
              rpc.requestType,
              serviceFqn,
              pointer,
              "request",
              rpc.requestStream
            ),
            streaming: rpc.requestStream,
          },
          responses: [
            {
              protocol: "grpc",
              message: payloadIR(
                ctx,
                rpc.responseType,
                serviceFqn,
                pointer,
                "response",
                rpc.responseStream
              ),
              streaming: rpc.responseStream,
            },
          ],
          // A proto rpc name is already the unique operation identifier the
          // rest of the pipeline keys generated members on.
          operationId: rpc.name,
        };
        if (rpc.description) method.description = rpc.description;
        service.methods.push(method);
      }
    }
  }

  return service;
}

function buildApi(ctx: Ctx, units: Unit[]): ApiIR {
  for (const unit of units) {
    registerDeclarations(
      ctx,
      unit.file.package ?? "",
      unit.file.messages,
      unit.file.enums
    );
  }

  // Declarations before services, so an rpc finds its payload already built.
  // Iterating a snapshot: building a message registers nothing new, but it does
  // fill `types`, and the registry is what defines the set.
  for (const declaration of [...ctx.declarations.values()]) {
    declarationIR(ctx, declaration);
  }

  const entry = units[0];
  if (!entry) {
    throw new Error("[wiz] no proto file to extract");
  }

  return {
    kind: "api",
    version: "proto3",
    types: ctx.types,
    components: emptyApiComponents(),
    service: buildService(ctx, units, entry),
    diagnostics: ctx.diagnostics,
  };
}

/* ------------------------------------------------------------------- entry */

function createCtx(options: ExtractProtoOptions): Ctx {
  return {
    declarations: new Map(),
    types: new Map(),
    building: new Set(),
    diagnostics: [],
    strict: options.strict === true,
    ids: 0,
  };
}

export function extractProtoIR(
  text: string,
  options: ExtractProtoOptions = {}
): ApiIR {
  const ctx = createCtx(options);
  const unit: Unit = { path: "<proto>", file: parseProtoFile(ctx, "<proto>", text) };

  // Nothing an import names can be resolved from text alone: there is no base
  // path to resolve it against. The well-known types are the exception,
  // because they are synthesised rather than read.
  for (const target of unit.file.imports) {
    if (target.startsWith(WELL_KNOWN_PREFIX)) continue;
    diagnose(
      ctx,
      target,
      "import",
      `unresolved import '${target}'; imports are only followed by extractProtoIRFromFile`
    );
  }

  return buildApi(ctx, [unit]);
}

/**
 * Loads a file and everything it imports, depth-first, resolving each import
 * against the file that wrote it. A cycle is legal in proto - two files may
 * reference each other through a third - so `seen` guards the walk rather than
 * reporting anything.
 */
async function loadUnit(
  ctx: Ctx,
  path: string,
  seen: Set<string>,
  units: Unit[]
): Promise<void> {
  if (seen.has(path)) return;
  seen.add(path);

  const file = Bun.file(path);
  if (!(await file.exists())) {
    diagnose(
      ctx,
      path,
      "import",
      `unresolved import '${path}'; references into it are carried as 'unknown'`
    );
    return;
  }

  const unit: Unit = { path, file: parseProtoFile(ctx, path, await file.text()) };
  units.push(unit);

  const base = dirname(path);
  for (const target of unit.file.imports) {
    if (target.startsWith(WELL_KNOWN_PREFIX)) continue;
    await loadUnit(ctx, resolvePath(base, target), seen, units);
  }
}

export async function extractProtoIRFromFile(
  path: string,
  options: ExtractProtoOptions = {}
): Promise<ApiIR> {
  const ctx = createCtx(options);
  const units: Unit[] = [];
  await loadUnit(ctx, resolvePath(path), new Set(), units);
  return buildApi(ctx, units);
}
