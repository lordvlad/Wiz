import {
  emptyApiComponents,
  type ApiComponentsIR,
  type ApiDiagnostic,
  type ApiIR,
} from "../ir/api.ts";
import { extractOpenRpcIR } from "./openrpc.ts";
import type {
  Annotated,
  EnumMemberIR,
  PropertyIR,
  TypeIR,
} from "../ir/types.ts";
import {
  keywordsToAnnotations,
  keywordsToConstraints,
  PRIMITIVE_FORMATS,
} from "../openapiDialect.ts";
import type {
  HttpMethodName,
  HttpResponseIR,
  ParameterIR,
  ServiceIR,
  ServiceMethodBodyIR,
  ServiceMethodIR,
  ServiceMethodRequestIR,
  ServiceMethodResponseIR,
} from "../ir/service.ts";

export interface ExtractApiOptions {
  /** Overrides sniffing; the file entry point derives it from the extension. */
  format?: "json" | "jsonc" | "json5" | "yaml";
  /** Throw on the first diagnostic instead of collecting them. Default false. */
  strict?: boolean;
}

/** Ids only need to be unique within one extraction; `o_` marks the origin. */
function nextId(ctx: Ctx): string {
  return `o_${++ctx.ids}`;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON Pointer token escaping, so `/users/{id}` survives inside a pointer. */
function token(part: string): string {
  return part.replace(/~/g, "~0").replace(/\//g, "~1");
}

interface Ctx {
  version: "3.0" | "3.1";
  document: JsonObject;
  components: ApiComponentsIR;
  diagnostics: ApiDiagnostic[];
  strict: boolean;
  /** Per-extraction node id counter, so two runs produce equal IR. */
  ids: number;
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

/**
 * Keywords a Schema Object may carry that no `TypeIR` shape can express. They
 * are dropped, but never silently: each one becomes a diagnostic.
 */
const UNSUPPORTED_SCHEMA_KEYWORDS = [
  "not",
  "if",
  "then",
  "else",
  "patternProperties",
  "dependentSchemas",
  "dependentRequired",
  "minProperties",
  "maxProperties",
  "contains",
  "minContains",
  "maxContains",
  "unevaluatedProperties",
  "unevaluatedItems",
  "propertyNames",
  "writeOnly",
  "xml",
  "externalDocs",
] as const;

function reportUnsupported(schema: JsonObject, ctx: Ctx, pointer: string): void {
  for (const keyword of UNSUPPORTED_SCHEMA_KEYWORDS) {
    if (schema[keyword] === undefined) continue;
    diagnose(
      ctx,
      `${pointer}/${keyword}`,
      keyword,
      `dropped unrepresentable schema keyword '${keyword}'`
    );
  }
  const discriminator = schema.discriminator;
  if (isObject(discriminator) && discriminator.mapping !== undefined) {
    diagnose(
      ctx,
      `${pointer}/discriminator/mapping`,
      "discriminator.mapping",
      "dropped discriminator mapping; the IR records only propertyName"
    );
  }
}

function readAnnotations(
  schema: JsonObject,
  ctx: Ctx,
  consumedFormat: boolean
): Annotated {
  const annotated = keywordsToAnnotations(schema);
  const constraints = keywordsToConstraints(
    schema,
    ctx.version,
    consumedFormat
  );
  if (constraints.length > 0) annotated.constraints = constraints;
  return annotated;
}

const SCHEMAS_REF = "#/components/schemas/";

/** Structural keywords that make a sibling of `allOf` worth keeping. */
const STRUCTURAL_KEYWORDS = [
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "prefixItems",
  "enum",
  "const",
  "oneOf",
  "anyOf",
] as const;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function enumMembers(values: unknown[]): EnumMemberIR[] {
  return values.map((value, index) => ({
    name:
      typeof value === "string" && IDENTIFIER.test(value)
        ? value
        : `VALUE_${index}`,
    value: value as string | number,
  }));
}

/**
 * Inverse of `irToOpenApiSchema`. A `$ref` always becomes a `ref` node rather
 * than being inlined, which is what makes recursive schemas cost nothing.
 */
function schemaToIR(
  raw: unknown,
  ctx: Ctx,
  pointer: string
): TypeIR {
  if (raw === undefined || raw === true) {
    return { id: nextId(ctx), kind: "primitive", type: "unknown" };
  }
  if (raw === false) {
    return { id: nextId(ctx), kind: "primitive", type: "never" };
  }
  if (!isObject(raw)) {
    return { id: nextId(ctx), kind: "primitive", type: "unknown" };
  }

  if (typeof raw.$ref === "string") {
    const ref = raw.$ref;
    if (!ref.startsWith(SCHEMAS_REF) || ref.length === SCHEMAS_REF.length) {
      throw new Error(
        `[wiz] unsupported $ref '${ref}' at ${pointer}; a schema may only reference #/components/schemas/*`
      );
    }
    const name = ref.slice(SCHEMAS_REF.length);
    return { id: nextId(ctx), kind: "ref", targetId: name, name };
  }

  reportUnsupported(raw, ctx, pointer);

  const declared = raw.type;
  const typeNames = Array.isArray(declared)
    ? declared.filter((t): t is string => typeof t === "string")
    : typeof declared === "string"
      ? [declared]
      : undefined;
  const nonNull = typeNames?.filter((t) => t !== "null");

  // `type: "string"` plus one of a few formats is how the generator spells
  // bigint/bytes/date, so those formats are part of the type, not a constraint.
  const consumedFormat =
    Boolean(nonNull?.includes("string")) &&
    typeof raw.format === "string" &&
    raw.format in PRIMITIVE_FORMATS;

  const annotated = readAnnotations(raw, ctx, consumedFormat);

  // `type: ["null"]` is the null type itself, not a nullable wrapper.
  if (typeNames !== undefined && nonNull!.length === 0) {
    return { id: nextId(ctx), ...annotated, kind: "primitive", type: "null" };
  }

  const nullable =
    (ctx.version === "3.0" && raw.nullable === true) ||
    (typeNames !== undefined && nonNull!.length < typeNames.length);

  if (!nullable) return coreToIR(raw, ctx, pointer, nonNull, annotated);

  // The annotations belong on the wrapper: that is where the generator reads
  // them from when it collapses a nullable union back into one schema.
  return {
    id: nextId(ctx),
    ...annotated,
    kind: "union",
    types: [
      coreToIR(raw, ctx, pointer, nonNull, {}),
      { id: nextId(ctx), kind: "primitive", type: "null" },
    ],
  };
}

function coreToIR(
  raw: JsonObject,
  ctx: Ctx,
  pointer: string,
  typeNames: string[] | undefined,
  annotated: Annotated
): TypeIR {
  const base = { id: nextId(ctx), ...annotated };

  if (Array.isArray(raw.allOf)) {
    const types = raw.allOf.map((member, index) =>
      schemaToIR(member, ctx, `${pointer}/allOf/${index}`)
    );
    // Sibling keywords alongside `allOf` are a schema in their own right.
    const { allOf: _allOf, ...siblings } = raw;
    if (STRUCTURAL_KEYWORDS.some((key) => siblings[key] !== undefined)) {
      types.push(schemaToIR(siblings, ctx, pointer));
    }
    return { ...base, kind: "intersection", types };
  }

  const variants = Array.isArray(raw.oneOf)
    ? { key: "oneOf" as const, members: raw.oneOf }
    : Array.isArray(raw.anyOf)
      ? { key: "anyOf" as const, members: raw.anyOf }
      : undefined;

  if (variants) {
    const types = variants.members.map((member, index) =>
      schemaToIR(member, ctx, `${pointer}/${variants.key}/${index}`)
    );
    const discriminator = raw.discriminator;
    const propertyName =
      variants.key === "oneOf" &&
      isObject(discriminator) &&
      typeof discriminator.propertyName === "string"
        ? discriminator.propertyName
        : undefined;
    return {
      ...base,
      kind: "union",
      types,
      ...(propertyName ? { discriminator: { propertyName } } : {}),
    };
  }

  const values = Array.isArray(raw.enum) ? raw.enum : undefined;
  const single =
    "const" in raw
      ? raw.const
      : values && values.length === 1
        ? values[0]
        : undefined;

  if ("const" in raw || (values && values.length === 1)) {
    // The generator spells a bigint literal as a string enum with `format:
    // int64`, so that pairing has to come back as a bigint.
    const value =
      typeNames?.includes("string") &&
      raw.format === "int64" &&
      typeof single === "string"
        ? BigInt(single)
        : (single as string | number | boolean | bigint | null);
    return { ...base, kind: "literal", value };
  }

  if (values && values.length > 1) {
    const allStrings = values.every((v) => typeof v === "string");
    const allNumbers = values.every((v) => typeof v === "number");
    if (allStrings || allNumbers) {
      return { ...base, kind: "enum", members: enumMembers(values) };
    }
    // A mixed-type enum is not an enum node; it is a union of literals.
    return {
      ...base,
      kind: "union",
      types: values.map((value) => ({
        id: nextId(ctx),
        kind: "literal" as const,
        value: value as string | number | boolean | bigint | null,
      })),
    };
  }

  if (typeNames && typeNames.length > 1) {
    return {
      ...base,
      kind: "union",
      types: typeNames.map((name) =>
        typeToIR({ ...raw, type: name }, ctx, pointer, name, {})
      ),
    };
  }

  return typeToIR(raw, ctx, pointer, typeNames?.[0], annotated, base);
}

function typeToIR(
  raw: JsonObject,
  ctx: Ctx,
  pointer: string,
  typeName: string | undefined,
  annotated: Annotated,
  prebuilt?: { id: string } & Annotated
): TypeIR {
  const base = prebuilt ?? { id: nextId(ctx), ...annotated };

  switch (typeName) {
    case "string": {
      const named =
        typeof raw.format === "string"
          ? PRIMITIVE_FORMATS[raw.format]
          : undefined;
      if (named) return { ...base, kind: "primitive", type: named };
      // 3.1 defers to JSON Schema's contentEncoding for binary.
      if (raw.contentEncoding === "base64") {
        return { ...base, kind: "primitive", type: "bytes" };
      }
      return { ...base, kind: "primitive", type: "string" };
    }
    case "number":
    case "integer":
      return { ...base, kind: "primitive", type: "number" };
    case "boolean":
      return { ...base, kind: "primitive", type: "boolean" };
    case "null":
      return { ...base, kind: "primitive", type: "null" };
    case "array":
      return arrayToIR(raw, ctx, pointer, base);
    case "object":
      return objectToIR(raw, ctx, pointer, base);
    case undefined: {
      if (raw.properties !== undefined || raw.additionalProperties !== undefined) {
        return objectToIR(raw, ctx, pointer, base);
      }
      if (raw.items !== undefined || raw.prefixItems !== undefined) {
        return arrayToIR(raw, ctx, pointer, base);
      }
      return { ...base, kind: "primitive", type: "unknown" };
    }
    default:
      diagnose(
        ctx,
        `${pointer}/type`,
        "type",
        `unknown schema type '${typeName}'`
      );
      return { ...base, kind: "primitive", type: "unknown" };
  }
}

function arrayToIR(
  raw: JsonObject,
  ctx: Ctx,
  pointer: string,
  base: { id: string } & Annotated
): TypeIR {
  if (Array.isArray(raw.prefixItems)) {
    return {
      ...base,
      kind: "tuple",
      elements: raw.prefixItems.map((item, index) => ({
        type: schemaToIR(item, ctx, `${pointer}/prefixItems/${index}`),
        optional: false,
      })),
      ...(isObject(raw.items)
        ? { rest: schemaToIR(raw.items, ctx, `${pointer}/items`) }
        : {}),
    };
  }
  // 3.0 spells a tuple as an array of item schemas.
  if (Array.isArray(raw.items)) {
    return {
      ...base,
      kind: "tuple",
      elements: raw.items.map((item, index) => ({
        type: schemaToIR(item, ctx, `${pointer}/items/${index}`),
        optional: false,
      })),
    };
  }
  return {
    ...base,
    kind: "array",
    element: schemaToIR(raw.items, ctx, `${pointer}/items`),
  };
}

function objectToIR(
  raw: JsonObject,
  ctx: Ctx,
  pointer: string,
  base: { id: string } & Annotated
): TypeIR {
  const required = Array.isArray(raw.required)
    ? raw.required.filter((n): n is string => typeof n === "string")
    : [];
  const additional = raw.additionalProperties;

  if (!isObject(raw.properties)) {
    // `additionalProperties` alone is how the generator spells a record.
    if (isObject(additional) || additional === true) {
      return {
        ...base,
        kind: "record",
        keyType: { id: nextId(ctx), kind: "primitive", type: "string" },
        valueType: schemaToIR(
          additional,
          ctx,
          `${pointer}/additionalProperties`
        ),
      };
    }
    return { ...base, kind: "object", properties: [] };
  }

  const properties: PropertyIR[] = Object.entries(raw.properties).map(
    ([name, value]) => ({
      name,
      type: schemaToIR(value, ctx, `${pointer}/properties/${token(name)}`),
      optional: !required.includes(name),
      readonly: isObject(value) && value.readOnly === true,
    })
  );

  return {
    ...base,
    kind: "object",
    properties,
    ...(additional === undefined
      ? {}
      : {
          additionalProperties:
            typeof additional === "boolean"
              ? additional
              : schemaToIR(additional, ctx, `${pointer}/additionalProperties`),
        }),
  };
}

/* ------------------------------------------------------------------ parsing */

/**
 * Parses an OpenAPI document with Bun's own parsers. `Bun.JSONL` is
 * deliberately unused: a document is one value, not a stream of records.
 */
export function parseApiDocument(
  text: string,
  format?: ExtractApiOptions["format"]
): unknown {
  if (format === "json") return JSON.parse(text);
  if (format === "jsonc") return Bun.JSONC.parse(text);
  if (format === "json5") return Bun.JSON5.parse(text);
  if (format === "yaml") return Bun.YAML.parse(text);

  for (const parse of [JSON.parse, Bun.JSONC.parse, Bun.JSON5.parse]) {
    try {
      return parse(text);
    } catch {
      // Sniffing: the next parser is strictly more permissive.
    }
  }
  // A document that is neither JSON nor YAML is most usefully reported as
  // malformed YAML, so this error is the one that escapes.
  return Bun.YAML.parse(text);
}

const EXTENSION_FORMATS: Record<string, ExtractApiOptions["format"]> = {
  json: "json",
  jsonc: "jsonc",
  json5: "json5",
  yaml: "yaml",
  yml: "yaml",
};

/* -------------------------------------------------------------- components */

const COMPONENT_SECTIONS = [
  "parameters",
  "headers",
  "requestBodies",
  "responses",
] as const;

type ComponentSection = (typeof COMPONENT_SECTIONS)[number];

function componentSection(ctx: Ctx, section: ComponentSection): JsonObject {
  const components = ctx.document.components;
  if (!isObject(components)) return {};
  const entry = components[section];
  return isObject(entry) ? entry : {};
}

/**
 * Follows a component definition that is itself a `$ref` into the same section.
 * A cycle here would otherwise hang, so it throws instead.
 */
function componentDefinition(
  ctx: Ctx,
  section: ComponentSection,
  name: string
): JsonObject | undefined {
  const entries = componentSection(ctx, section);
  const seen = new Set<string>();
  let current = name;

  while (true) {
    const pointer = `#/components/${section}/${token(current)}`;
    if (seen.has(current)) {
      throw new Error(`[wiz] circular component reference at ${pointer}`);
    }
    seen.add(current);

    const raw = entries[current];
    if (!isObject(raw)) return undefined;
    if (typeof raw.$ref !== "string") return raw;

    const prefix = `#/components/${section}/`;
    if (!raw.$ref.startsWith(prefix)) {
      throw new Error(
        `[wiz] unsupported $ref '${raw.$ref}' at ${pointer}; a ${section} component may only reference ${prefix}*`
      );
    }
    current = raw.$ref.slice(prefix.length);
  }
}

const PARAMETER_LOCATIONS = ["path", "query", "header", "cookie"] as const;

function parameterToIR(
  raw: JsonObject,
  ctx: Ctx,
  pointer: string,
  fallback: { name?: string; in?: ParameterIR["in"] } = {}
): ParameterIR | undefined {
  // The IR holds one type per parameter, not one per media type.
  if (raw.schema === undefined && raw.content !== undefined) {
    diagnose(
      ctx,
      `${pointer}/content`,
      "content",
      "skipped parameter declared with `content` instead of `schema`"
    );
    return undefined;
  }

  const name = typeof raw.name === "string" ? raw.name : fallback.name;
  if (name === undefined) {
    diagnose(ctx, pointer, "name", "skipped parameter without a name");
    return undefined;
  }

  const location =
    typeof raw.in === "string" &&
    (PARAMETER_LOCATIONS as readonly string[]).includes(raw.in)
      ? (raw.in as ParameterIR["in"])
      : fallback.in;
  if (location === undefined) {
    diagnose(ctx, pointer, "in", `skipped parameter '${name}' without a valid \`in\``);
    return undefined;
  }

  const parameter: ParameterIR = {
    name,
    in: location,
    required: location === "path" ? true : raw.required === true,
    type: schemaToIR(raw.schema, ctx, `${pointer}/schema`),
  };
  if (typeof raw.description === "string") {
    parameter.description = raw.description;
  }
  if (raw.deprecated === true) parameter.deprecated = true;
  return parameter;
}

function bodiesFor(
  content: unknown,
  ctx: Ctx,
  pointer: string
): ServiceMethodBodyIR[] {
  if (!isObject(content)) return [];
  return Object.entries(content).map(([mimetype, media]) => ({
    mimetype,
    content: schemaToIR(
      isObject(media) ? media.schema : undefined,
      ctx,
      `${pointer}/${token(mimetype)}/schema`
    ),
  }));
}

function headersFor(
  raw: unknown,
  ctx: Ctx,
  pointer: string
): ParameterIR[] {
  if (!isObject(raw)) return [];
  const headers: ParameterIR[] = [];
  for (const [name, value] of Object.entries(raw)) {
    if (!isObject(value)) continue;
    const at = `${pointer}/${token(name)}`;
    const resolved = resolveHeader(name, value, ctx, at);
    if (resolved) headers.push(resolved);
  }
  return headers;
}

const HEADERS_REF = "#/components/headers/";

function resolveHeader(
  name: string,
  raw: JsonObject,
  ctx: Ctx,
  pointer: string
): ParameterIR | undefined {
  if (typeof raw.$ref === "string") {
    if (!raw.$ref.startsWith(HEADERS_REF)) {
      throw new Error(
        `[wiz] unsupported $ref '${raw.$ref}' at ${pointer}; a header may only reference ${HEADERS_REF}*`
      );
    }
    const component = raw.$ref.slice(HEADERS_REF.length);
    const registered = ctx.components.headers.get(component);
    if (!registered) {
      throw new Error(
        `[wiz] unresolved $ref '${raw.$ref}' at ${pointer}; no such component`
      );
    }
    // The registry entry is shared; only the use site records the name.
    return { ...registered, name, component };
  }
  return parameterToIR(raw, ctx, pointer, { name, in: "header" });
}

function responseToIR(
  raw: JsonObject,
  ctx: Ctx,
  pointer: string,
  status: number | "default"
): HttpResponseIR {
  const response: HttpResponseIR = { protocol: "http", status };
  if (typeof raw.description === "string") {
    response.description = raw.description;
  }
  const bodies = bodiesFor(raw.content, ctx, `${pointer}/content`);
  if (bodies.length > 0) response.body = bodies;
  const headers = headersFor(raw.headers, ctx, `${pointer}/headers`);
  if (headers.length > 0) response.headers = headers;
  return response;
}

function buildComponents(ctx: Ctx): void {
  for (const name of Object.keys(componentSection(ctx, "parameters"))) {
    const pointer = `#/components/parameters/${token(name)}`;
    const raw = componentDefinition(ctx, "parameters", name);
    if (!raw) continue;
    const parameter = parameterToIR(raw, ctx, pointer);
    if (parameter) ctx.components.parameters.set(name, parameter);
  }

  for (const name of Object.keys(componentSection(ctx, "headers"))) {
    const pointer = `#/components/headers/${token(name)}`;
    const raw = componentDefinition(ctx, "headers", name);
    if (!raw) continue;
    const header = parameterToIR(raw, ctx, pointer, { name, in: "header" });
    if (header) ctx.components.headers.set(name, header);
  }

  for (const name of Object.keys(componentSection(ctx, "requestBodies"))) {
    const pointer = `#/components/requestBodies/${token(name)}`;
    const raw = componentDefinition(ctx, "requestBodies", name);
    if (!raw) continue;
    ctx.components.requestBodies.set(name, {
      bodies: bodiesFor(raw.content, ctx, `${pointer}/content`),
      required: raw.required === true,
    });
  }

  for (const name of Object.keys(componentSection(ctx, "responses"))) {
    const pointer = `#/components/responses/${token(name)}`;
    const raw = componentDefinition(ctx, "responses", name);
    if (!raw) continue;
    // A response component has no status of its own; the use site holds it.
    ctx.components.responses.set(name, responseToIR(raw, ctx, pointer, "default"));
  }
}

/* -------------------------------------------------------------------- paths */

const OPERATION_KEYS: Record<string, HttpMethodName> = {
  get: "GET",
  put: "PUT",
  post: "POST",
  delete: "DELETE",
  options: "OPTIONS",
  head: "HEAD",
  patch: "PATCH",
  trace: "TRACE",
};

const PARAMETERS_REF = "#/components/parameters/";
const REQUEST_BODIES_REF = "#/components/requestBodies/";
const RESPONSES_REF = "#/components/responses/";

function resolveParameter(
  raw: JsonObject,
  ctx: Ctx,
  pointer: string
): ParameterIR | undefined {
  if (typeof raw.$ref === "string") {
    if (!raw.$ref.startsWith(PARAMETERS_REF)) {
      throw new Error(
        `[wiz] unsupported $ref '${raw.$ref}' at ${pointer}; a parameter may only reference ${PARAMETERS_REF}*`
      );
    }
    const component = raw.$ref.slice(PARAMETERS_REF.length);
    const registered = ctx.components.parameters.get(component);
    if (!registered) {
      throw new Error(
        `[wiz] unresolved $ref '${raw.$ref}' at ${pointer}; no such component`
      );
    }
    return { ...registered, component };
  }
  return parameterToIR(raw, ctx, pointer);
}

function collectParameters(
  raw: unknown,
  ctx: Ctx,
  pointer: string,
  into: Map<string, ParameterIR>
): void {
  if (!Array.isArray(raw)) return;
  raw.forEach((entry, index) => {
    if (!isObject(entry)) return;
    const parameter = resolveParameter(entry, ctx, `${pointer}/${index}`);
    // An operation parameter replaces a path-item one of the same name and
    // location, and keeps the path-item's position in the merged order.
    if (parameter) into.set(`${parameter.in}\u0000${parameter.name}`, parameter);
  });
}

function requestToIR(
  operation: JsonObject,
  pathItem: JsonObject,
  ctx: Ctx,
  pathPointer: string,
  pointer: string
): ServiceMethodRequestIR {
  const request: ServiceMethodRequestIR = { protocol: "http" };

  const merged = new Map<string, ParameterIR>();
  collectParameters(
    pathItem.parameters,
    ctx,
    `${pathPointer}/parameters`,
    merged
  );
  collectParameters(operation.parameters, ctx, `${pointer}/parameters`, merged);
  if (merged.size > 0) request.parameters = [...merged.values()];

  const body = operation.requestBody;
  if (isObject(body)) {
    if (typeof body.$ref === "string") {
      if (!body.$ref.startsWith(REQUEST_BODIES_REF)) {
        throw new Error(
          `[wiz] unsupported $ref '${body.$ref}' at ${pointer}/requestBody; a request body may only reference ${REQUEST_BODIES_REF}*`
        );
      }
      const component = body.$ref.slice(REQUEST_BODIES_REF.length);
      const registered = ctx.components.requestBodies.get(component);
      if (!registered) {
        throw new Error(
          `[wiz] unresolved $ref '${body.$ref}' at ${pointer}/requestBody; no such component`
        );
      }
      if (registered.bodies.length > 0) request.body = registered.bodies;
      request.bodyRequired = registered.required;
      request.bodyComponent = component;
    } else {
      const bodies = bodiesFor(
        body.content,
        ctx,
        `${pointer}/requestBody/content`
      );
      if (bodies.length > 0) request.body = bodies;
      // OpenAPI's own default; the generator's output default is separate.
      request.bodyRequired = body.required === true;
    }
  }

  return request;
}

function responsesToIR(
  operation: JsonObject,
  ctx: Ctx,
  pointer: string
): ServiceMethodResponseIR[] {
  const raw = operation.responses;
  if (!isObject(raw)) return [];

  const responses: ServiceMethodResponseIR[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!isObject(value)) continue;
    const at = `${pointer}/responses/${token(key)}`;

    let status: number | "default";
    if (key === "default") {
      status = "default";
    } else if (/^\d{3}$/.test(key)) {
      status = Number(key);
    } else {
      // `status: number | "default"` cannot hold a range.
      diagnose(
        ctx,
        at,
        key,
        `skipped response with range status key '${key}'`
      );
      continue;
    }

    if (typeof value.$ref === "string") {
      if (!value.$ref.startsWith(RESPONSES_REF)) {
        throw new Error(
          `[wiz] unsupported $ref '${value.$ref}' at ${at}; a response may only reference ${RESPONSES_REF}*`
        );
      }
      const component = value.$ref.slice(RESPONSES_REF.length);
      const registered = ctx.components.responses.get(component);
      if (!registered) {
        throw new Error(
          `[wiz] unresolved $ref '${value.$ref}' at ${at}; no such component`
        );
      }
      responses.push({ ...registered, status, component });
      continue;
    }

    responses.push(responseToIR(value, ctx, at, status));
  }
  return responses;
}

/**
 * Inverts `operationSource`. Document-level `servers`, `security` and 3.1
 * `webhooks` produce no diagnostic: `ServiceIR` deliberately excludes them.
 */
function pathsToService(ctx: Ctx): ServiceIR {
  const service: ServiceIR = { kind: "service", methods: [] };

  const info = ctx.document.info;
  if (isObject(info)) {
    if (typeof info.title === "string") service.name = info.title;
    if (typeof info.version === "string") service.version = info.version;
    if (typeof info.description === "string") {
      service.description = info.description;
    }
  }

  const paths = ctx.document.paths;
  if (!isObject(paths)) return service;

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isObject(pathItem)) continue;
    const pathPointer = `#/paths/${token(path)}`;

    for (const [key, operation] of Object.entries(pathItem)) {
      const method = OPERATION_KEYS[key];
      if (!method || !isObject(operation)) continue;
      const pointer = `${pathPointer}/${key}`;

      const irMethod: ServiceMethodIR = {
        kind: "serviceMethod",
        protocol: "http",
        // The path key is already OpenAPI template form.
        address: { protocol: "http", method, path },
        request: requestToIR(operation, pathItem, ctx, pathPointer, pointer),
        responses: responsesToIR(operation, ctx, pointer),
      };

      if (typeof operation.operationId === "string") {
        irMethod.operationId = operation.operationId;
      }
      if (typeof operation.summary === "string") {
        irMethod.summary = operation.summary;
      }
      if (typeof operation.description === "string") {
        irMethod.description = operation.description;
      }
      if (Array.isArray(operation.tags)) {
        irMethod.tags = operation.tags.filter(
          (t): t is string => typeof t === "string"
        );
      }
      if (operation.deprecated === true) irMethod.deprecated = true;

      service.methods.push(irMethod);
    }
  }

  return service;
}

/* ----------------------------------------------------------------- entry */

function detectVersion(document: JsonObject): "3.0" | "3.1" {
  if (document.swagger !== undefined) {
    throw new Error(
      `[wiz] unsupported OpenAPI version '${String(document.swagger)}'; 3.0 and 3.1 are supported`
    );
  }
  const declared = document.openapi;
  if (typeof declared === "string") {
    if (declared.startsWith("3.0")) return "3.0";
    if (declared.startsWith("3.1")) return "3.1";
  }
  throw new Error(
    `[wiz] unsupported OpenAPI version '${String(declared)}'; 3.0 and 3.1 are supported`
  );
}

export function extractApiIR(
  text: string,
  options: ExtractApiOptions = {}
): ApiIR {
  const parsed = parseApiDocument(text, options.format);
  if (!isObject(parsed)) {
    throw new Error("[wiz] OpenAPI document must be an object");
  }
  if (typeof parsed.openrpc === "string" || parsed.openrpc !== undefined) {
    return extractOpenRpcIR(text, options);
  }


  const ctx: Ctx = {
    version: detectVersion(parsed),
    document: parsed,
    components: emptyApiComponents(),
    diagnostics: [],
    strict: options.strict === true,
    ids: 0,
  };

  // Components first, so an operation that references one finds it built.
  buildComponents(ctx);

  const types = new Map<string, TypeIR>();
  const components = parsed.components;
  const schemas = isObject(components) ? components.schemas : undefined;
  if (isObject(schemas)) {
    for (const [name, schema] of Object.entries(schemas)) {
      types.set(
        name,
        schemaToIR(schema, ctx, `#/components/schemas/${token(name)}`)
      );
    }
  }

  return {
    kind: "api",
    version: ctx.version,
    types,
    components: ctx.components,
    service: pathsToService(ctx),
    diagnostics: ctx.diagnostics,
  };
}

export async function extractApiIRFromFile(
  path: string,
  options: ExtractApiOptions = {}
): Promise<ApiIR> {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const format = options.format ?? EXTENSION_FORMATS[extension];
  return extractApiIR(await Bun.file(path).text(), { ...options, format });
}
