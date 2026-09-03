import type { ApiIR } from "../ir/api.ts";
import {
  isGrpcMethod,
  isHttpMethod,
  isOpenRpcMethod,
  type GrpcServiceMethodIR,
  type HttpResponseIR,
  type HttpServiceMethodIR,
  type OpenRpcServiceMethodIR,
  type ParameterIR,
  type ServiceIR,
  type ServiceMethodBodyIR,
  type ServiceMethodIR,
} from "../ir/service.ts";
import { collectNamedTypes, type PropertyIR, type TypeIR } from "../types.ts";
import type { GeneratedFiles, Generator, GeneratorContext } from "./generator.ts";
import { generateProtobufCodecCode } from "./protobuf.ts";
import { generateJsonCodecCode } from "./json.ts";
import { generateErlangTextCode, generateErlangBinaryCode } from "./erlang.ts";
import { generateValidationBlock, helpersFor } from "./validator.ts";
import { docComment, tsDeclarations, typeIdentifiers, typeText } from "./tsTypes.ts";

/**
 * A TypeScript HTTP client, emitted as two files a consumer can drop into a
 * project: `model.ts` for the document's types and `api.ts` for its operations.
 *
 * The emitted code imports nothing from wiz. It is the end of the pipeline, not
 * a runtime that has to stay in step with one, and a generated client that
 * needs its generator installed is a generated client nobody can vendor.
 *
 * Operations are emitted once, as the body of `createClient`, and reached two
 * ways: a client instance carrying its own configuration, for a caller talking
 * to several tenants at once, and a module-level function per operation reading
 * the configuration `configure()` set, for the far more common caller talking to
 * one. Neither is a wrapper around a second implementation.
 */

export type ValidateTarget = "path" | "query" | "body" | "headers" | "response";

export type MediaType =
  | "json"
  | "jsonl"
  | "jsonc"
  | "json5"
  | "xml"
  | "html"
  | "xml+html"
  | "grpc"
  | "erlangText"
  | "erlangBinary"
  | "erlang"
  | "yaml";

export interface TsClientOptions {
  /**
   * Widens the parameter objects: headers accept any string entry and query
   * accepts any string or boolean one, on top of what the document declared.
   *
   * The strict shape is the honest one, but real documents omit the header a
   * gateway requires, so the escape hatch is opt-in rather than absent.
   */
  lenient?: boolean;
  /**
   * Validates request parameters and/or response payloads at runtime.
   * Pass `true` to validate all parts (`path`, `query`, `body`, `headers`, `response`),
   * or an array of specific parts to validate.
   */
  validate?: boolean | ValidateTarget[];
  /**
   * Additional media types to support when generating the client.
   * "all" enables all supported media types (JSONL, JSONC, JSON5, XML, HTML, gRPC, Erlang Text, Erlang Binary, YAML).
   */
  mediaTypes?: string[] | "all";
}
function isValidationEnabled(
  options: TsClientOptions,
  target: ValidateTarget
): boolean {
  if (options.validate === true) return true;
  if (Array.isArray(options.validate)) {
    return options.validate.includes(target);
  }
  return false;
}

/**
 * The `{ petId: string }` object a parameter group is passed as, expressed as
 * IR so the validator emitter can read it. `slotMembers` builds the same shape
 * as TypeScript text; this builds it as a type the checks are generated from.
 *
 * The node is synthetic - it never enters an extracted graph - so its `id` only
 * has to be stable and distinct within this file.
 */
function parameterGroupTypeIR(
  parameters: ParameterIR[],
  group: ParameterIR["in"]
): TypeIR | undefined {
  const usable = parameters.filter((parameter) => !isAbsent(parameter.type));
  if (usable.length === 0) return undefined;

  return {
    id: `wiz:parameters:${group}`,
    kind: "object",
    properties: usable.map((parameter) => ({
      name: parameter.name,
      type: parameter.type,
      optional: !parameter.required,
      readonly: false,
      description: parameter.description,
    })),
  };
}

/**
 * Resolves `$ref` nodes against the document's named types.
 *
 * The validator emitter has no `ref` case - a ref is where it stops, which is
 * what keeps a cyclic type from generating an infinite check. An OpenAPI
 * document names every reused schema, though, so leaving the refs in place
 * would emit a client that validates nothing but inline schemas. Inlining them
 * here keeps the emitter's contract and still checks what the document said,
 * and `seen` preserves the stopping behaviour exactly where it matters: a type
 * already being inlined is a cycle, and stays a ref.
 */
function inlineRefs(
  ir: TypeIR,
  declared: ReadonlyMap<string, TypeIR>,
  seen: ReadonlySet<string> = new Set()
): TypeIR {
  if (ir.kind === "ref") {
    if (seen.has(ir.targetId)) return ir;
    const target = declared.get(ir.targetId);
    if (!target) return ir;
    return inlineRefs(target, declared, new Set([...seen, ir.targetId]));
  }

  const next = ir.name !== undefined ? new Set([...seen, ir.name]) : seen;

  switch (ir.kind) {
    case "object":
      return {
        ...ir,
        properties: ir.properties.map((property) => ({
          ...property,
          type: inlineRefs(property.type, declared, next),
        })),
        additionalProperties:
          typeof ir.additionalProperties === "object"
            ? inlineRefs(ir.additionalProperties, declared, next)
            : ir.additionalProperties,
      };
    case "array":
      return { ...ir, element: inlineRefs(ir.element, declared, next) };
    case "tuple":
      return {
        ...ir,
        elements: ir.elements.map((element) => ({
          ...element,
          type: inlineRefs(element.type, declared, next),
        })),
        rest: ir.rest ? inlineRefs(ir.rest, declared, next) : ir.rest,
      };
    case "union":
    case "intersection":
      return {
        ...ir,
        types: ir.types.map((member) => inlineRefs(member, declared, next)),
      };
    case "record":
      return {
        ...ir,
        keyType: inlineRefs(ir.keyType, declared, next),
        valueType: inlineRefs(ir.valueType, declared, next),
      };
    default:
      return ir;
  }
}

/**
 * The checks report where a failure was, and the emitter builds that path by
 * concatenating onto a root it is handed. Handing it a string *literal* makes
 * every `root ? root + "." + key : key` a constant-truthy test, which is a
 * `strict` error in the file this generator writes. A widened local is the
 * same value without the literal type.
 */
function validationRoot(target: ValidateTarget): { declaration: string; expression: string } {
  const name = `__wizPath${target.charAt(0).toUpperCase()}${target.slice(1)}`;
  return {
    declaration: `const ${name}: string = ${JSON.stringify(target)};`,
    expression: name,
  };
}

const CODEC_FILE = "codec.ts";
const TRANSPORT_FILE = "transport.ts";

const JSON_MIME = "application/json";
const MODEL_FILE = "model.ts";
const API_FILE = "api.ts";

/** `never`/`void`/`undefined` in a payload slot means "this method has none". */
function isAbsent(ir: TypeIR | undefined): boolean {
  if (!ir) return true;
  return (
    ir.kind === "primitive" &&
    (ir.type === "never" || ir.type === "undefined" || ir.type === "void")
  );
}

function normalizeMediaTypes(mediaTypes?: string[] | "all"): Set<string> | "all" {
  if (mediaTypes === "all") return "all";
  if (Array.isArray(mediaTypes)) {
    if (mediaTypes.includes("all")) return "all";
    const set = new Set<string>();
    for (const item of mediaTypes) {
      const lower = item.toLowerCase().trim();
      set.add(lower);
      if (lower === "erlangtext" || lower === "erlang-text" || lower === "erlang") {
        set.add("erlangtext");
        set.add("erlang-text");
        set.add("erlang");
      }
      if (lower === "erlangbinary" || lower === "erlang-binary") {
        set.add("erlangbinary");
        set.add("erlang-binary");
      }
      if (lower === "xml+html") {
        set.add("xml");
        set.add("html");
        set.add("xml+html");
      }
    }
    return set;
  }
  return new Set();
}

function isMimetypeSupported(mimetype: string, mediaTypes?: string[] | "all"): boolean {
  const norm = mimetype.toLowerCase().trim();

  // JSON is always supported
  if (norm === "application/json" || norm.endsWith("+json") || norm === "json") {
    return true;
  }

  const enabled = normalizeMediaTypes(mediaTypes);
  const isAll = enabled === "all";
  const has = (key: string) => isAll || (enabled instanceof Set && enabled.has(key));

  if (norm.includes("jsonl") || norm.includes("json-lines") || norm.includes("x-jsonlines")) {
    return has("jsonl");
  }
  if (norm.includes("jsonc")) {
    return has("jsonc");
  }
  if (norm.includes("json5")) {
    return has("json5");
  }
  if (norm.includes("yaml") || norm.includes("x-yaml")) {
    return has("yaml");
  }
  if (norm.includes("xml")) {
    return has("xml") || has("xml+html");
  }
  if (norm.includes("html")) {
    return has("html") || has("xml+html");
  }
  if (norm.includes("erlang-binary") || norm.includes("x-erlang-binary") || norm.includes("etf")) {
    return has("erlangbinary") || has("erlang-binary");
  }
  if (norm.includes("erlang")) {
    return has("erlangtext") || has("erlang-text") || has("erlang");
  }
  if (norm.includes("grpc")) {
    return has("grpc");
  }

  return false;
}

function selectBody(
  bodies: ServiceMethodBodyIR[] | undefined,
  options: TsClientOptions,
  onSkipped?: (mimetype: string) => void
): ServiceMethodBodyIR | undefined {
  if (!bodies || bodies.length === 0) return undefined;

  const chosen =
    bodies.find((body) => body.mimetype === JSON_MIME) ??
    bodies.find((body) => isMimetypeSupported(body.mimetype, options.mediaTypes)) ??
    bodies[0];

  const supported = chosen && isMimetypeSupported(chosen.mimetype, options.mediaTypes);

  if (onSkipped) {
    for (const body of bodies) {
      if (body !== chosen || !supported) {
        onSkipped(body.mimetype);
      }
    }
  }

  if (!supported || !chosen || isAbsent(chosen.content)) {
    return undefined;
  }

  return chosen;
}

function bodySerializer(mimetype: string, access: string, encode?: string): string {
  const norm = mimetype.toLowerCase().trim();
  if (norm.includes("jsonl") || norm.includes("json-lines") || norm.includes("x-jsonlines")) {
    return `(${access}.body).map((row: any) => JSON.stringify(row)).join("\\n")`;
  }
  if (norm.includes("jsonc")) {
    return `JSON.stringify(${access}.body)`;
  }
  if (norm.includes("json5")) {
    return `((globalThis as any).Bun?.JSON5 ?? JSON).stringify(${access}.body)`;
  }
  if (norm.includes("yaml") || norm.includes("x-yaml")) {
    return `((globalThis as any).Bun?.YAML ?? JSON).stringify(${access}.body)`;
  }
  if (norm.includes("xml")) {
    return `((globalThis as any).Bun?.XML ?? { stringify: (v: any) => String(v) }).stringify(${access}.body)`;
  }
  if (norm.includes("html")) {
    return `typeof ${access}.body === "string" ? ${access}.body : ((globalThis as any).Bun?.escapeHTML ? (globalThis as any).Bun.escapeHTML(String(${access}.body)) : String(${access}.body))`;
  }
  if (norm.includes("erlang-binary") || norm.includes("x-erlang-binary") || norm.includes("etf")) {
    return `encodeErlangBinary(${access}.body)`;
  }
  if (norm.includes("erlang")) {
    return `encodeErlangText(${access}.body)`;
  }
  return encode ? `${encode}(${access}.body)` : `JSON.stringify(${access}.body)`;
}

function jsonBody(
  bodies: ServiceMethodBodyIR[] | undefined,
  options: TsClientOptions,
  onSkipped?: (mimetype: string) => void
): TypeIR | undefined {
  const chosen = selectBody(bodies, options, onSkipped);
  return chosen ? chosen.content : undefined;
}
/**
 * A method name for an operation that named none: `/pets/{petId}` becomes
 * `getPetsByPetId`. An rpc always carries its own name, so the gRPC side is
 * only reached for a method assembled by hand.
 */
function derivedName(method: ServiceMethodIR): string {
  if (isGrpcMethod(method)) {
    return camelCase(`${method.address.service} ${method.address.method}`);
  }
  if (isOpenRpcMethod(method)) {
    return camelCase(
      method.address.service
        ? `${method.address.service} ${method.address.method}`
        : method.address.method
    );
  }
  if (method.address.protocol === "asyncapi") {
    return camelCase(
      method.operationId ?? `${method.address.channel} ${method.address.action}`
    );
  }
  if (!isHttpMethod(method)) return "call";
  const segments = method.address.path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      const parameter = segment.match(/^\{(.+)\}$/);
      const word = parameter ? `by ${parameter[1]}` : segment;
      return word
        .replace(/[^A-Za-z0-9]+/g, " ")
        .trim()
        .split(" ")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join("");
    });

  return `${method.address.method.toLowerCase()}${segments.join("")}`;
}

function camelCase(text: string): string {
  const parts = text.replace(/[^A-Za-z0-9]+/g, " ").trim().split(" ");
  return parts
    .map((part, index) =>
      index === 0
        ? part.charAt(0).toLowerCase() + part.slice(1)
        : part.charAt(0).toUpperCase() + part.slice(1)
    )
    .join("");
}

/**
 * Method names, resolved once for the whole service.
 *
 * `operationId` is the document's own name for the call and wins; a document
 * without one still has to produce a stable identifier, and two operations that
 * land on the same one are suffixed rather than silently merged.
 */
export function methodNames(service: ServiceIR): Map<ServiceMethodIR, string> {
  const names = new Map<ServiceMethodIR, string>();
  const taken: Record<string, true> = {};

  for (const method of service.methods) {
    const preferred = method.operationId
      ? camelCase(method.operationId)
      : derivedName(method);
    const base = preferred.length > 0 ? preferred : "call";

    let unique = base;
    for (let index = 2; taken[unique]; index += 1) unique = `${base}${index}`;

    taken[unique] = true;
    names.set(method, unique);
  }

  return names;
}

/** One `{ name: type }` slot for a group of parameters, or nothing. */
function slotMembers(
  parameters: ParameterIR[],
  identifiers: ReadonlyMap<string, string>
): { text: string; required: boolean } | undefined {
  const usable = parameters.filter((parameter) => !isAbsent(parameter.type));
  if (usable.length === 0) return undefined;

  const members = usable.map((parameter) => {
    const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(parameter.name)
      ? parameter.name
      : JSON.stringify(parameter.name);
    const optional = parameter.required ? "" : "?";
    const doc = parameter.description ? `/** ${parameter.description} */ ` : "";
    return `${doc}${key}${optional}: ${typeText(parameter.type, identifiers)}`;
  });

  return {
    text: `{ ${members.join("; ")} }`,
    required: usable.some((parameter) => parameter.required),
  };
}

interface Slot {
  name: string;
  type: string;
  required: boolean;
}

function requestSlots(
  method: HttpServiceMethodIR,
  identifiers: ReadonlyMap<string, string>,
  options: TsClientOptions,
  onSkipped: (mimetype: string) => void
): Slot[] {
  const parameters = method.request.parameters ?? [];
  const grouped = (location: ParameterIR["in"]) =>
    parameters.filter((parameter) => parameter.in === location);

  const slots: Slot[] = [];

  const path = slotMembers(grouped("path"), identifiers);
  // Path parameters are part of the URL, so they are never optional.
  if (path) slots.push({ name: "path", type: path.text, required: true });

  const query = slotMembers(grouped("query"), identifiers);
  const looseQuery = "Record<string, string | boolean>";
  if (query) {
    slots.push({
      name: "query",
      type: options.lenient ? `${query.text} & ${looseQuery}` : query.text,
      required: query.required,
    });
  } else if (options.lenient) {
    slots.push({ name: "query", type: looseQuery, required: false });
  }

  const headers = slotMembers(grouped("header"), identifiers);
  const looseHeaders = "Record<string, string>";
  if (headers) {
    slots.push({
      name: "headers",
      type: options.lenient ? `${headers.text} & ${looseHeaders}` : headers.text,
      required: headers.required,
    });
  } else if (options.lenient) {
    slots.push({ name: "headers", type: looseHeaders, required: false });
  }

  const cookie = slotMembers(grouped("cookie"), identifiers);
  if (cookie) {
    slots.push({ name: "cookie", type: cookie.text, required: cookie.required });
  }

  const body = jsonBody(method.request.body, options, onSkipped);
  if (body) {
    slots.push({
      name: "body",
      type: typeText(body, identifiers),
      required: method.request.bodyRequired !== false,
    });
  }

  return slots;
}

/**
 * What a call resolves to: every success payload the document lists.
 *
 * A failure is thrown rather than returned, so error responses are absent from
 * the type - a caller that wants them reads `ApiError.body`.
 */
function successType(
  method: HttpServiceMethodIR,
  identifiers: ReadonlyMap<string, string>,
  options: TsClientOptions,
  onSkipped: (mimetype: string) => void
): string {
  const isSuccess = (response: HttpResponseIR) =>
    typeof response.status === "number" &&
    response.status >= 200 &&
    response.status < 300;

  const responses = method.responses.filter(isSuccess);
  const chosen =
    responses.length > 0
      ? responses
      : method.responses.filter((response) => response.status === "default");

  const types: string[] = [];
  for (const response of chosen) {
    const body = jsonBody(response.body, options, onSkipped);
    const text = body ? typeText(body, identifiers) : "void";
    if (!types.includes(text)) types.push(text);
  }

  if (types.length === 0) return "void";
  // `void` only means "no payload"; alongside a real one it says nothing.
  const meaningful = types.filter((text) => text !== "void");
  return meaningful.length > 0 ? meaningful.join(" | ") : "void";
}

/** The URL template, reading path parameters off the caller's slot object. */
function urlTemplate(
  method: HttpServiceMethodIR,
  access: string,
  hasQuery: boolean
): string {
  const path = method.address.path.replace(
    /\{([^}]+)\}/g,
    (_match: string, name: string) => {
      const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
        ? `.${name}`
        : `[${JSON.stringify(name)}]`;
      return `\${encodePath(${access}.path${key})}`;
    }
  );

  return hasQuery
    ? `\`\${config.baseUrl}${path}\${queryString(${access}.query)}\``
    : `\`\${config.baseUrl}${path}\``;
}

/** One operation, in the shapes the emitted file needs it in. */
interface Operation {
  name: string;
  doc: string;
  /** `options: { … }`, `request: Msg`, or nothing at all. */
  parameter: string;
  returns: string;
  /** The method body, as a member of the object `createClient` returns. */
  implementation: string;
  /** A server stream is an async generator, which reads differently. */
  streaming: boolean;
}

function httpOperation(
  method: HttpServiceMethodIR,
  name: string,
  identifiers: ReadonlyMap<string, string>,
  declared: ReadonlyMap<string, TypeIR>,
  options: TsClientOptions,
  onSkipped: (mimetype: string) => void
): Operation {
  const slots = requestSlots(method, identifiers, options, onSkipped);
  const returns = successType(method, identifiers, options, onSkipped);
  const required = slots.some((slot) => slot.required);
  const access = slots.length === 0 || required ? "options" : "options?";

  const parameter =
    slots.length === 0
      ? "callOptions?: HttpCallOptions"
      : `options${required ? "" : "?"}: { ${slots
          .map((slot) => `${slot.name}${slot.required ? "" : "?"}: ${slot.type}`)
          .join("; ")} }, callOptions?: HttpCallOptions`;

  const requestBodyObj = selectBody(method.request.body, options, onSkipped);
  const requestType = requestBodyObj?.content;
  const requestMimetype = requestBodyObj?.mimetype ?? JSON_MIME;
  const requestName = requestType?.name;
  const requestIdentifier = requestName ? identifiers.get(requestName) : undefined;
  const encode = requestIdentifier ? codecName("encode", requestIdentifier) : undefined;

  const isSuccess = (response: HttpResponseIR) =>
    typeof response.status === "number" &&
    response.status >= 200 &&
    response.status < 300;
  const responses = method.responses.filter(isSuccess);
  const chosen =
    responses.length > 0
      ? responses
      : method.responses.filter((response) => response.status === "default");
  const responseBodyObj = selectBody(chosen[0]?.body, options, onSkipped);
  const responseType = responseBodyObj?.content;
  const responseName = responseType?.name;
  const responseIdentifier = responseName ? identifiers.get(responseName) : undefined;
  const decode = responseIdentifier ? codecName("decode", responseIdentifier) : undefined;

  const has = (name: string) => slots.some((slot) => slot.name === name);
  const call = [
    `        method: ${JSON.stringify(method.address.method)},`,
    `        url: ${urlTemplate(method, access, has("query"))},`,
    `        headers: headerRecord(${[
      has("headers") ? `${access}.headers` : "undefined",
      has("cookie") ? `${access}.cookie` : "undefined",
      has("body") ? JSON.stringify(requestMimetype) : "undefined",
    ].join(", ")}),`,
    ...(has("body")
      ? [
          `        body: ${bodySerializer(requestMimetype, access, encode)},`,
        ]
      : []),
  ].join("\n");

  const send = `send(config, {\n${call}\n      }, callOptions)`;

  const parameters = method.request.parameters ?? [];
  const grouped = (location: ParameterIR["in"]) =>
    parameters.filter((parameter) => parameter.in === location);

  const resolved = (ir: TypeIR | undefined): TypeIR | undefined =>
    ir ? inlineRefs(ir, declared) : undefined;

  const pathTypeIR = resolved(parameterGroupTypeIR(grouped("path"), "path"));
  const queryTypeIR = resolved(parameterGroupTypeIR(grouped("query"), "query"));
  const headerTypeIR = resolved(parameterGroupTypeIR(grouped("header"), "header"));
  const bodyTypeIR = resolved(jsonBody(method.request.body, options, onSkipped));
  const responseTypeIR = resolved(jsonBody(chosen[0]?.body, options, onSkipped));

  /**
   * One slot's checks, as a guarded block.
   *
   * A slot the caller may legitimately omit is only checked when it is there;
   * a required one that is missing is itself a failure, and saying so here is
   * what stops the request going out with a URL that has `undefined` in it.
   */
  const slotCheck = (
    target: ValidateTarget,
    ir: TypeIR,
    expression: string,
    required: boolean,
    missing: string
  ): string => {
    const root = validationRoot(target);
    const lines = [
      `      if (${expression} !== undefined) {`,
      `        const errors: ValidationError[] = [];`,
      `        ${root.declaration}`,
      generateValidationBlock(ir, expression, root.expression, 0, true)
        .split("\n")
        .map((line) => `        ${line}`)
        .join("\n"),
      `        if (errors.length > 0) throw new ClientValidationError(${JSON.stringify(target)}, errors);`,
    ];
    if (required) {
      lines.push(`      } else {`);
      lines.push(
        `        throw new ClientValidationError(${JSON.stringify(target)}, [{ path: ${JSON.stringify(target)}, message: ${JSON.stringify(missing)} }]);`
      );
    }
    lines.push(`      }`);
    return lines.join("\n");
  };

  const requestChecks: string[] = [];

  if (pathTypeIR && isValidationEnabled(options, "path")) {
    // A path parameter is always required: it is part of the URL.
    requestChecks.push(
      slotCheck("path", pathTypeIR, `${access}.path`, true, "Missing required path parameters")
    );
  }
  if (queryTypeIR && isValidationEnabled(options, "query")) {
    requestChecks.push(
      slotCheck(
        "query",
        queryTypeIR,
        `${access}.query`,
        grouped("query").some((parameter) => parameter.required),
        "Missing required query parameters"
      )
    );
  }
  if (headerTypeIR && isValidationEnabled(options, "headers")) {
    requestChecks.push(
      slotCheck(
        "headers",
        headerTypeIR,
        `${access}.headers`,
        grouped("header").some((parameter) => parameter.required),
        "Missing required header parameters"
      )
    );
  }
  if (bodyTypeIR && isValidationEnabled(options, "body")) {
    requestChecks.push(
      slotCheck(
        "body",
        bodyTypeIR,
        `${access}.body`,
        method.request.bodyRequired !== false,
        "Missing required request body"
      )
    );
  }


  const validatesResponse =
    responseTypeIR !== undefined && isValidationEnabled(options, "response");

  // The response is checked after decoding, so what the caller is handed and
  // what was checked are the same value rather than two readings of one body.
  const responseCheck = (): string => {
    const root = validationRoot("response");
    return [
      `      const errors: ValidationError[] = [];`,
      `      ${root.declaration}`,
      generateValidationBlock(responseTypeIR!, "result", root.expression, 0, true)
        .split("\n")
        .map((line) => `      ${line}`)
        .join("\n"),
      `      if (errors.length > 0) throw new ClientValidationError("response", errors);`,
    ].join("\n");
  };

  const hasValidation = requestChecks.length > 0 || validatesResponse;
  const valPrefix = hasValidation
    ? `      const __prune = false;\n${requestChecks.length > 0 ? `${requestChecks.join("\n")}\n` : ""}`
    : "";

  let body: string;
  if (returns === "void") {
    body = `${valPrefix}      await ${send};`;
  } else if (decode) {
    body = validatesResponse
      ? `${valPrefix}      const result = ${decode}(await ${send} as string) as ${returns};\n${responseCheck()}\n      return result;`
      : `${valPrefix}      return ${decode}(await ${send} as string) as ${returns};`;
  } else {
    body = validatesResponse
      ? `${valPrefix}      const result = (await ${send}) as ${returns};\n${responseCheck()}\n      return result;`
      : `${valPrefix}      return (await ${send}) as ${returns};`;
  }
  return {
    name,
    doc: docComment(
      {
        description:
          [method.summary, method.description]
            .filter((line): line is string => Boolean(line))
            .join("\n\n") || undefined,
        deprecated: method.deprecated ? { isDeprecated: true } : undefined,
      },
      ""
    ),
    parameter,
    returns: returns === "void" ? "Promise<void>" : `Promise<${returns}>`,
    // Parameters are left unannotated: the object literal is contextually typed
    // by `Client`, so the signature has exactly one source of truth.
    implementation: `    async ${name}(${slots.length === 0 ? "callOptions" : "options, callOptions"}) {\n${body}\n    },`,
    streaming: false,
  };
}

/** `encodePet`, from the identifier the model declares the message under. */
function codecName(kind: "encode" | "decode", identifier: string): string {
  return `${kind}${identifier.charAt(0).toUpperCase()}${identifier.slice(1)}`;
}

/** `/pets.Pets/GetPet`, which is the whole of a gRPC address on the wire. */
function grpcPath(method: GrpcServiceMethodIR): string {
  const qualified = method.address.package
    ? `${method.address.package}.${method.address.service}`
    : method.address.service;
  return `/${qualified}/${method.address.method}`;
}
function openRpcOperation(
  method: OpenRpcServiceMethodIR,
  name: string,
  identifiers: ReadonlyMap<string, string>
): Operation {
  const params = method.request.params;
  const paramMembers: string[] = [];
  for (const p of params) {
    paramMembers.push(`${p.name}${p.required ? "" : "?"}: ${typeText(p.type, identifiers)}`);
  }

  const parameter = paramMembers.length > 0 ? `params: { ${paramMembers.join("; ")} }` : "";

  const response0 = method.responses[0];
  const returnsType = response0?.result ? typeText(response0.result, identifiers) : "unknown";
  const returns = `Promise<${returnsType}>`;

  const methodName = method.address.service
    ? `${method.address.service}.${method.address.method}`
    : method.address.method;

  const doc = docComment(
    {
      description:
        [method.summary, method.description]
          .filter((line): line is string => Boolean(line))
          .join("\n\n") || undefined,
      deprecated: method.deprecated ? { isDeprecated: true } : undefined,
    },
    ""
  );

  const implementation = [
    `    async ${name}(${parameter}): ${returns} {`,
    `      const transport = config.openrpcTransport || config.transport || httpTransport({ url: config.baseUrl });`,
    `      const res = await transport.call({`,
    `        jsonrpc: "2.0",`,
    `        id: ++config.idSeq,`,
    `        method: ${JSON.stringify(methodName)},`,
    `        params: ${params.length > 0 ? (method.request.paramsByName ? "params" : "Object.values(params ?? {})") : "{}"},`,
    `      });`,
    `      if (res.error) {`,
    `        const err = new Error(res.error.message);`,
    `        (err as any).code = res.error.code;`,
    `        throw err;`,
    `      }`,
    `      return res.result as ${returnsType};`,
    `    },`,
  ].join("\n");

  return {
    name,
    parameter,
    returns,
    doc,
    implementation,
    // A JSON-RPC call resolves once; there is no server-stream form of it.
    streaming: false,
  };
}

function grpcOperation(
  method: GrpcServiceMethodIR,
  name: string,
  identifiers: ReadonlyMap<string, string>,
  onUnsupported: (name: string, reason: string) => void
): Operation {
  const response = method.responses[0];
  const requestName = method.request.message.name;
  const responseName = response?.message.name;
  const requestIdentifier = requestName ? identifiers.get(requestName) : undefined;
  const responseIdentifier = responseName
    ? identifiers.get(responseName)
    : undefined;

  const doc = docComment(
    {
      description:
        [method.summary, method.description]
          .filter((line): line is string => Boolean(line))
          .join("\n\n") || undefined,
      deprecated: method.deprecated ? { isDeprecated: true } : undefined,
    },
    ""
  );

  // A message the document never declared leaves nothing to encode with, so the
  // method is emitted and says so rather than quietly disappearing.
  if (!requestIdentifier || !responseIdentifier) {
    const reason = "its request or response message is not declared in this document";
    onUnsupported(name, reason);

    return {
      name,
      doc,
      parameter: "",
      returns: "Promise<never>",
      implementation: `    async ${name}() {\n      throw new Error(${JSON.stringify(
        `[wiz] ${name} is not callable: ${reason}`
      )});\n    },`,
      streaming: false,
    };
  }

  const path = JSON.stringify(grpcPath(method));
  const encode = codecName("encode", requestIdentifier);
  const decode = codecName("decode", responseIdentifier);
  const streamsIn = method.request.streaming;
  const streamsOut = response?.streaming === true;

  // The caller's side of each direction: one message or a stream of them,
  // resolving once or yielding until the server is done. The transport decides
  // whether the streaming-in directions can run at all, and says so at the
  // call rather than here, because a client can be reconfigured.
  const parameter = streamsIn
    ? `requests: AsyncIterable<${requestIdentifier}>, options?: GrpcCallOptions`
    : `request: ${requestIdentifier}, options?: GrpcCallOptions`;

  const outgoing = streamsIn
    ? `grpcEncoded(requests, ${encode})`
    : `[${encode}(request)]`;

  if (streamsOut) {
    return {
      name,
      doc,
      parameter,
      returns: `AsyncIterable<${responseIdentifier}>`,
      implementation: [
        `    async *${name}(${streamsIn ? "requests" : "request"}, options) {`,
        `      const messages = grpcCall(config, ${path}, ${outgoing}, options, ${streamsIn});`,
        `      for await (const message of messages) yield ${decode}(message);`,
        `    },`,
      ].join("\n"),
      streaming: true,
    };
  }

  return {
    name,
    doc,
    parameter,
    returns: `Promise<${responseIdentifier}>`,
    implementation: streamsIn
      ? [
          `    async ${name}(requests, options) {`,
          `      return ${decode}(`,
          `        await grpcClientStream(config, ${path}, ${outgoing}, options)`,
          `      );`,
          `    },`,
        ].join("\n")
      : [
          `    async ${name}(request, options) {`,
          `      return ${decode}(await grpcUnary(config, ${path}, ${encode}(request), options));`,
          `    },`,
        ].join("\n"),
    streaming: false,
  };
}

/**
 * The runtime every emitted method shares.
 *
 * It is deliberately small and dependency-free: one configuration shape, one
 * interceptor chain, and the encoding rules. Anything larger would be a
 * framework the consumer did not ask for. `send` takes the configuration rather
 * than reading a module-level one, which is what lets one file serve both a
 * per-instance client and the module-level default.
 */
const PRELUDE = `/** One outgoing call, as built by a method and seen by every interceptor. */
export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** JSON text for an HTTP call, a framed protobuf message for a gRPC one. */
  body?: string | Uint8Array;
  /** Signal for cancellation or local timeout. */
  signal?: AbortSignal;
}

/** A call and what came back, before the status is judged. */
export interface CallResult {
  call: Call;
  response: Response;
}

/**
 * Per-call cancellation and deadline, the same two things a gRPC call takes.
 * There is deliberately no \`headers\` here: an HTTP document declares its
 * headers, so they are slots on the method rather than ambient metadata.
 */
export interface HttpCallOptions {
  /** Cancels the call. Whatever \`fetch\` does with an aborted signal happens. */
  signal?: AbortSignal;
  /**
   * A deadline for this call, enforced locally: the call aborts with a
   * \`TimeoutError\` when it passes, whatever the server is doing.
   */
  timeoutMs?: number;
}

/**
 * The caller's signal and the deadline as one signal, built per attempt so an
 * interceptor that calls \`next\` again gets a fresh deadline rather than one
 * that has already fired.
 */
function effectiveSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined
): AbortSignal | undefined {
  const deadline =
    timeoutMs === undefined ? [] : [AbortSignal.timeout(timeoutMs)];
  return signal ? AbortSignal.any([signal, ...deadline]) : deadline[0];
}


/**
 * A wrapper around one call.
 *
 * One shape serves both protocols, so an interceptor can do the same four
 * things either side: change the call on the way in, change what comes back on
 * the way out, call \`next\` more than once to retry, or never call it and
 * answer from somewhere else. The call type is shared too, so an interceptor
 * that only touches the request - the common case, a token - is one generic
 * function that both sides accept.
 */
export type Interceptor<TResult> = (
  call: Call,
  next: (call: Call) => TResult
) => TResult;

/** Wraps an HTTP call. The response is raw: its status is judged afterwards. */
export type HttpInterceptor = Interceptor<Promise<CallResult>>;

/**
 * A chain per protocol, because what an interceptor gets back differs. Only the
 * protocols this document speaks are here, so an array can never be written
 * into a key nothing will read.
 */
export interface Interceptors {
__INTERCEPTOR_KEYS__}

/** Folds the chain right to left, so the first interceptor is the outermost. */
function chain<TResult>(
  interceptors: ReadonlyArray<Interceptor<TResult>> | undefined,
  invoke: (call: Call) => TResult
): (call: Call) => TResult {
  if (!interceptors || interceptors.length === 0) return invoke;
  return interceptors.reduceRight<(call: Call) => TResult>(
    (next, interceptor) => (call) => interceptor(call, next),
    invoke
  );
}

/**
 * The part of \`fetch\` this client calls, so a stub does not have to be a whole
 * one. A real \`fetch\` is assignable to it: it accepts wider input than this.
 */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string | Uint8Array;
    signal?: AbortSignal;
  }
) => Promise<Response>;


/**
 * An HTTP transport that executes an outgoing call.
 *
 * Symmetrical to \`GrpcTransport\`: a custom transport receives the \`Call\` and
 * returns a \`Response\`.
 */
export interface HttpTransport {
  call(call: Call): Promise<Response>;
}

function httpTransport(config: ClientConfig): HttpTransport {
  if (config.transport) {
    if (typeof config.transport === "function") {
      const fn = config.transport;
      return {
        call: (c) =>
          fn(c.url, {
            method: c.method,
            headers: c.headers,
            body: c.body,
            signal: c.signal,
          }),
      };
    }
    if (
      typeof config.transport === "object" &&
      "call" in config.transport &&
      !("duplex" in config.transport)
    ) {
      return config.transport;
    }
  }
  return {
    call: (c) =>
      globalThis.fetch(c.url, {
        method: c.method,
        headers: c.headers,
        body: c.body as BodyInit | undefined,
        signal: c.signal,
      }),
  };
}

export interface ClientConfig {
  /**
   * Prefix for every path. The document does not carry it: OpenAPI \`servers\`
   * describe environments, which is a runtime fact, not a compile-time one.
   */
  baseUrl: string;
__TRANSPORT_CONFIG__
  /**
   * Wrappers around every call, outermost first. This is where an
   * Authorization header comes from, and where a retry or a log belongs.
   */
  interceptors?: Interceptors;
  /**
   * A deadline for every call, unless the call overrides it. Sent as
   * \`grpc-timeout\` where the protocol has one, and always enforced locally.
   */
  timeoutMs?: number;
__GRPC_CONFIG__}

const DEFAULTS: ClientConfig = {
  baseUrl: "",
};

/** A response outside 2xx. The parsed body is kept: that is where APIs explain. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly response: Response;

  constructor(status: number, body: unknown, response: Response) {
    super(\`HTTP \${status} for \${response.url}\`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.response = response;
  }
}

function encodePath(value: string | number | boolean): string {
  return encodeURIComponent(String(value));
}

function queryString(query: Record<string, unknown> | undefined): string {
  if (!query) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    // A repeated key is how every OpenAPI serialisation style spells an array.
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, String(item));
      continue;
    }
    search.append(key, String(value));
  }
  const text = search.toString();
  return text ? \`?\${text}\` : "";
}

function headerRecord(
  headers: Record<string, unknown> | undefined,
  cookie: Record<string, unknown> | undefined,
  contentType: string | undefined
): Record<string, string> {
  const record: Record<string, string> = {};
  if (contentType) record["content-type"] = contentType;

  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value === undefined || value === null) continue;
    record[key] = String(value);
  }

  // Cookie parameters travel in one header, which is the only way HTTP has.
  const crumbs = Object.entries(cookie ?? {}).filter(
    ([, value]) => value !== undefined && value !== null
  );
  if (crumbs.length > 0) {
    record["cookie"] = crumbs
      .map(([key, value]) => \`\${key}=\${encodeURIComponent(String(value))}\`)
      .join("; ");
  }

  return record;
}

async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (text === "") return undefined;
  const ct = (response.headers.get("content-type") ?? "").toLowerCase();
  const bun = (globalThis as any).Bun;
  if (ct.includes("jsonl") || ct.includes("json-lines") || ct.includes("x-jsonlines")) {
    try {
      return (bun?.JSONL ?? { parse: (t: string) => t.trim().split("\\n").map((l: string) => JSON.parse(l)) }).parse(text);
    } catch {
      return text;
    }
  }
  if (ct.includes("jsonc")) {
    try {
      return (bun?.JSONC ?? JSON).parse(text);
    } catch {
      return text;
    }
  }
  if (ct.includes("json5")) {
    try {
      return (bun?.JSON5 ?? JSON).parse(text);
    } catch {
      return text;
    }
  }
  if (ct.includes("yaml")) {
    try {
      return (bun?.YAML ?? { parse: (t: string) => JSON.parse(t) }).parse(text);
    } catch {
      return text;
    }
  }
  if (ct.includes("xml")) {
    try {
      return (bun?.XML ?? { parse: (t: string) => t }).parse(text);
    } catch {
      return text;
    }
  }
  if (ct.includes("erlang-binary") || ct.includes("etf")) {
    try {
      const bytes = new Uint8Array(await response.arrayBuffer());
      return typeof (globalThis as any).decodeErlangBinary === "function" ? (globalThis as any).decodeErlangBinary(bytes) : bytes;
    } catch {
      return text;
    }
  }
  if (ct.includes("erlang")) {
    try {
      return typeof (globalThis as any).decodeErlangText === "function" ? (globalThis as any).decodeErlangText(text) : text;
    } catch {
      return text;
    }
  }
  if (ct.includes("json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

async function send(
  config: ClientConfig,
  call: Call,
  options: HttpCallOptions | undefined
): Promise<unknown> {
  const http = httpTransport(config);

  // The signal is built inside the attempt, not once per call, so an
  // interceptor that calls \`next\` again gets a fresh deadline rather than one
  // that has already fired. The caller's own signal spans every attempt.
  const invoke = async (outgoing: Call): Promise<CallResult> => {
    const activeCall: Call = {
      ...outgoing,
      signal: effectiveSignal(
        options?.signal,
        options?.timeoutMs ?? config.timeoutMs
      ),
    };
    return {
      call: activeCall,
      response: await http.call(activeCall),
    };
  };
  // The status is judged after the chain, so an interceptor sees the response
  // that a retry or a token refresh has to look at, not an exception.
  const settled = await __HTTP_CHAIN__(call);

  const body = await parseBody(settled.response);
  if (!settled.response.ok) {
    throw new ApiError(settled.response.status, body, settled.response);
  }
  return body;
}`;

/**
 * The real gRPC transport, in a file of its own.
 *
 * It is separate because it imports `node:http2`, which a browser bundle must
 * never see. A consumer on a server opts in - `configure({ transport:
 * createHttp2Transport() })` - and gains what gRPC needs and `fetch` cannot
 * give: HTTP/2 trailers for the status, and a request body that stays open, so
 * client and bidirectional streaming work.
 */
const HTTP2_TRANSPORT = `import http2 from "node:http2";
import {
  frameMessage,
  GrpcError,
  grpcFrames,
  parseGrpcStatus,
  type GrpcCompression,
  type GrpcTransport,
  type GrpcTransportCall,
  type GrpcTransportResponse,
} from "./api.ts";

const GRPC_MIME = "application/grpc+proto";

export interface Http2TransportOptions {
  /** Passed to \`http2.connect\`, for a CA bundle or a client certificate. */
  session?: http2.SecureClientSessionOptions;
}

export interface Http2Transport extends GrpcTransport {
  /** Closes every pooled session. A process that exits does not need this. */
  close(): void;
}

/**
 * One session per origin, reopened when it goes away.
 *
 * HTTP/2 multiplexes every call over one connection, which is the whole reason
 * gRPC uses it: a stream is cheap, a connection is not. The origin comes off
 * the call rather than out of an option, so the client's \`baseUrl\` stays the
 * only place a URL is written - and one transport can serve several of them.
 */
export function createHttp2Transport(
  options: Http2TransportOptions = {}
): Http2Transport {
  const sessions = new Map<string, http2.ClientHttp2Session>();

  const connected = (origin: string): http2.ClientHttp2Session => {
    const existing = sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;

    const session = http2.connect(origin, options.session);
    // Without this an idle session's error takes the process down.
    session.on("error", () => {
      sessions.delete(origin);
    });
    sessions.set(origin, session);
    return session;
  };

  return {
    duplex: true,

    close() {
      for (const session of sessions.values()) session.close();
      sessions.clear();
    },

    call(call: GrpcTransportCall): GrpcTransportResponse {
      const target = new URL(call.url);
      const stream = connected(target.origin).request({
        ":method": "POST",
        ":path": \`\${target.pathname}\${target.search}\`,
        "content-type": GRPC_MIME,
        // \`te: trailers\` is how a gRPC client announces it will read them.
        te: "trailers",
        ...call.headers,
      });

      // Assigned inside the executor, which runs before anything can read them;
      // the assertion is what tells the compiler that.
      let resolveHeaders!: (value: { status: number; headers: Record<string, string> }) => void;
      let rejectHeaders!: (reason: unknown) => void;
      const headers = new Promise<{ status: number; headers: Record<string, string> }>(
        (resolve, reject) => {
          resolveHeaders = resolve;
          rejectHeaders = reject;
        }
      );
      // A caller only awaits the headers when an interceptor asked for them. The
      // real failure travels through \`messages\`; without this, rejecting an
      // unobserved promise would surface as an unhandled rejection instead.
      headers.catch(() => {});

      const flatten = (raw: http2.IncomingHttpHeaders): Record<string, string> => {
        const flat: Record<string, string> = {};
        for (const [key, value] of Object.entries(raw)) {
          if (value === undefined) continue;
          flat[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
        }
        return flat;
      };

      let status: { code: number; details: string } | undefined;
      let httpStatus = 200;
      // What the server compressed its messages with, if it did.
      let responseEncoding = "identity";

      // Reading state lives here rather than inside the generator below: the
      // listeners have to be attached before the stream can emit anything, and
      // \`cancel\` has to be able to wake the reader even when the stream never
      // got far enough to emit an event of its own.
      const queue: Uint8Array[] = [];
      let finished = false;
      let failure: unknown;
      let wake: (() => void) | undefined;
      const nudge = () => {
        wake?.();
        wake = undefined;
      };

      // Trailing metadata is everything the server appended, status included:
      // it is kept whole, because what a server puts beside \`grpc-status\` -
      // error details, a retry hint, a request id - is the caller's business.
      let resolveTrailers!: (value: Record<string, string>) => void;
      const trailers = new Promise<Record<string, string>>((resolve) => {
        resolveTrailers = resolve;
      });
      let trailing: Record<string, string> = {};

      stream.on("response", (raw) => {
        const flat = flatten(raw);
        httpStatus = Number(flat[":status"] ?? 200);
        responseEncoding = flat["grpc-encoding"] ?? "identity";
        // A trailers-only reply carries the status here, and ends.
        if (flat["grpc-status"] !== undefined) {
          status = {
            code: Number(flat["grpc-status"]),
            details: decodeURIComponent(flat["grpc-message"] ?? ""),
          };
          trailing = flat;
        }
        resolveHeaders({ status: httpStatus, headers: flat });
      });
      stream.on("trailers", (raw) => {
        const flat = flatten(raw);
        trailing = flat;
        if (flat["grpc-status"] !== undefined) {
          status = {
            code: Number(flat["grpc-status"]),
            details: decodeURIComponent(flat["grpc-message"] ?? ""),
          };
        }
      });
      stream.on("data", (chunk: Uint8Array) => {
        queue.push(chunk);
        nudge();
      });
      stream.on("end", () => {
        finished = true;
        nudge();
      });
      stream.on("error", (error: unknown) => {
        // A cancel closes the stream, which errors; the reason we cancelled for
        // is the better one to report.
        if (status === undefined) failure = error;
        finished = true;
        nudge();
      });
      stream.on("close", () => {
        finished = true;
        nudge();
      });

      const cancel = (code: number, details: string) => {
        status = { code, details };
        finished = true;
        nudge();
        if (!stream.closed) stream.close(http2.constants.NGHTTP2_CANCEL);
      };

      // A deadline is sent as a header so the server can stop early, and kept
      // locally too: a server that ignores it must not hang the caller.
      const deadline =
        call.timeoutMs === undefined
          ? undefined
          : setTimeout(() => cancel(4, "deadline exceeded"), call.timeoutMs);
      const onAbort = () => cancel(1, "cancelled");
      call.signal?.addEventListener("abort", onAbort, { once: true });
      // A caller can abort before this line runs, in which case the listener
      // would never fire; the signal is read as well as listened to.
      if (call.signal?.aborted) onAbort();

      // Writing runs alongside reading, which is what makes a duplex call one
      // call: a bidirectional stream reads replies while it is still sending.
      const writing = (async () => {
        try {
          // The header the caller set decides the request encoding; framing is
          // shared with the fetch transport so both compress identically.
          const requestEncoding = (call.headers["grpc-encoding"] ??
            "identity") as GrpcCompression;
          for await (const message of call.messages) {
            if (finished) break;
            const framed = await frameMessage(message, requestEncoding);
            if (!stream.write(framed)) {
              await new Promise<void>((resolve) => stream.once("drain", resolve));
            }
          }
          if (!stream.closed) stream.end();
        } catch (error) {
          cancel(2, error instanceof Error ? error.message : String(error));
          throw error;
        }
      })();
      // The reader reports the failure; this keeps an early write error from
      // surfacing as an unhandled rejection first.
      writing.catch(() => {});

      const chunks = (async function* (): AsyncGenerator<Uint8Array> {
        while (true) {
          while (queue.length > 0) yield queue.shift()!;
          if (finished) break;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }

        if (failure) throw failure;
      })();

      const messages = (async function* (): AsyncGenerator<Uint8Array> {
        try {
          for await (const frame of grpcFrames(chunks, responseEncoding)) {
            // Over HTTP/2 the status is in the trailers, so a trailer frame is
            // gRPC-Web's device and does not belong here; it is read anyway
            // rather than handed to the codec.
            if (frame.trailer) {
              status = parseGrpcStatus(new TextDecoder().decode(frame.payload));
              continue;
            }
            yield frame.payload;
          }

          await writing;

          if (httpStatus !== 200 && status === undefined) {
            throw new GrpcError(2, \`the server answered HTTP \${httpStatus}\`, trailing);
          }
          if (status && status.code !== 0) {
            throw new GrpcError(status.code, status.details, trailing);
          }
          if (status === undefined) {
            throw new GrpcError(2, "the response carried no gRPC status", trailing);
          }
        } catch (error) {
          rejectHeaders(error);
          throw error;
        } finally {
          // Whatever happened, a caller awaiting the trailers gets what arrived.
          resolveTrailers(trailing);
          clearTimeout(deadline);
          call.signal?.removeEventListener("abort", onAbort);
        }
      })();

      return { headers, messages, trailers };
    },
  };
}`;

/**
 * The gRPC half of the runtime, emitted only when the document declares rpcs.
 *
 * Everything goes through one seam: a transport takes a path, headers and a
 * stream of encoded messages, and returns the response headers plus a stream of
 * encoded messages. All four streaming directions are that same call, which is
 * why the generated methods do not care which transport is underneath.
 *
 * The default transport is gRPC-Web over `fetch`, because that is what runs
 * everywhere including a browser. It cannot do client or bidirectional
 * streaming - `fetch` sends one complete body - so it reports `duplex: false`,
 * and the HTTP/2 transport in the companion file reports `true`.
 */
const GRPC_PRELUDE = `const GRPC_WEB_MIME = "application/grpc-web+proto";

/** A gRPC status other than OK. \`code\` is the canonical numeric status. */
export class GrpcError extends Error {
  readonly code: number;
  readonly details: string;
  /**
   * Trailing metadata, which is where a server puts what a status code cannot
   * say - \`grpc-status-details-bin\`, a retry hint, a request id.
   */
  readonly metadata: Record<string, string>;

  constructor(code: number, details: string, metadata: Record<string, string> = {}) {
    super(\`gRPC status \${code}\${details ? \`: \${details}\` : ""}\`);
    this.name = "GrpcError";
    this.code = code;
    this.details = details;
    this.metadata = metadata;
  }
}

export interface GrpcCallOptions {
  /** Cancels the call. Over HTTP/2 this resets the stream. */
  signal?: AbortSignal;
  /** A deadline, sent as \`grpc-timeout\` and enforced locally as well. */
  timeoutMs?: number;
  /** Extra metadata for this call only. */
  headers?: Record<string, string>;
}

export interface GrpcTransportCall {
  /** Absolute: the client's \`baseUrl\` plus \`/package.Service/Method\`. */
  url: string;
  headers: Record<string, string>;
  /**
   * One message for a unary request, many for a client stream. A plain array is
   * allowed, and is what a unary call passes: re-iterable, so an interceptor
   * can send it twice.
   */
  messages: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface GrpcTransportResponse {
  /** Resolves when the server's headers arrive, before any message. */
  headers: Promise<{ status: number; headers: Record<string, string> }>;
  messages: AsyncIterable<Uint8Array>;
  /**
   * Resolves once the call is over, with whatever the server appended. A
   * transport with nowhere to put trailers resolves it empty rather than never.
   */
  trailers: Promise<Record<string, string>>;
}

export interface GrpcTransport {
  /**
   * Whether the request body can stay open while the response is read. Client
   * and bidirectional streaming need it; gRPC-Web over fetch cannot offer it.
   */
  readonly duplex: boolean;
  call(call: GrpcTransportCall): GrpcTransportResponse;
}

/**
 * Wraps a gRPC call.
 *
 * \`next\` returns before the response exists - a stream has no single moment of
 * arrival - so an interceptor reads \`headers\` or \`trailers\` off the result
 * instead of awaiting the call. Attach a \`catch\` to either: a failed call
 * rejects both, and the error itself travels through \`messages\`.
 */
export type GrpcInterceptor = Interceptor<GrpcTransportResponse>;

/**
 * The message encodings a gRPC peer may name.
 *
 * \`gzip\` and \`deflate\` are the registered ones a browser can also do, through
 * \`CompressionStream\`; anything else a server asks for is refused rather than
 * guessed at. (zstd is not a registered gRPC encoding.)
 */
export type GrpcCompression = "identity" | "gzip" | "deflate";

const GRPC_ACCEPT_ENCODING = "gzip, deflate, identity";

/**
 * Compression goes through the web streams rather than a runtime's own zlib, so
 * one emitted client works in Bun, Node, Deno and a browser alike.
 */
async function compressMessage(
  payload: Uint8Array,
  encoding: Exclude<GrpcCompression, "identity">
): Promise<Uint8Array> {
  const squeezed = new Blob([payload as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream(encoding));
  return new Uint8Array(await new Response(squeezed).arrayBuffer());
}

async function decompressMessage(
  payload: Uint8Array,
  encoding: string
): Promise<Uint8Array> {
  if (encoding !== "gzip" && encoding !== "deflate") {
    throw new GrpcError(
      12,
      \`the server compressed with '\${encoding}', which this client cannot read\`
    );
  }
  const expanded = new Blob([payload as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream(encoding));
  return new Uint8Array(await new Response(expanded).arrayBuffer());
}

/**
 * One length-prefixed frame: a flag byte, a big-endian length, the message.
 *
 * Bit 0 of the flag says this message is compressed with whatever the
 * \`grpc-encoding\` header named, which is per-message by design: a stream may
 * mix compressed and plain frames.
 */
export async function frameMessage(
  payload: Uint8Array,
  encoding: GrpcCompression = "identity"
): Promise<Uint8Array> {
  const compressed = encoding === "identity" ? payload : await compressMessage(payload, encoding);
  const framed = new Uint8Array(compressed.length + 5);
  const view = new DataView(framed.buffer);
  view.setUint8(0, encoding === "identity" ? 0 : 1);
  view.setUint32(1, compressed.length, false);
  framed.set(compressed, 5);
  return framed;
}

/** Encodes a caller's stream on the way out, one message at a time. */
async function* grpcEncoded<TMessage>(
  requests: AsyncIterable<TMessage>,
  encode: (message: TMessage) => Uint8Array
): AsyncGenerator<Uint8Array> {
  for await (const request of requests) yield encode(request);
}

/**
 * Splits a byte stream into gRPC frames.
 *
 * A frame is only readable once its header and its whole payload have arrived,
 * so the leftovers are carried between chunks rather than assumed to align.
 */
export function grpcFrames(
  chunks: AsyncIterable<Uint8Array>,
  encoding: string = "identity"
): AsyncGenerator<{ trailer: boolean; payload: Uint8Array }> {
  return (async function* () {
    let buffer = new Uint8Array(0);

    for await (const chunk of chunks) {
      if (chunk.length > 0) {
        const merged = new Uint8Array(buffer.length + chunk.length);
        merged.set(buffer, 0);
        merged.set(chunk, buffer.length);
        buffer = merged;
      }

      while (buffer.length >= 5) {
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        const length = view.getUint32(1, false);
        if (buffer.length < 5 + length) break;
        const flags = buffer[0]!;
        const payload = buffer.subarray(5, 5 + length);
        buffer = buffer.subarray(5 + length);
        const trailer = (flags & 0x80) !== 0;
        // A trailer frame is metadata and is never compressed; a message frame
        // is, whenever bit 0 says the server used the encoding it announced.
        yield {
          trailer,
          payload:
            (flags & 0x01) !== 0 && !trailer
              ? await decompressMessage(payload, encoding)
              : payload,
        };
      }
    }

  })();
}
/**
 * A trailer block as a record, for the gRPC-Web dialect where trailers arrive
 * as text in a frame rather than as HTTP/2 trailers.
 */
export function parseTrailerBlock(text: string): Record<string, string> {
  const trailers: Record<string, string> = {};
  for (const line of text.split(/\\r?\\n/)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    trailers[line.slice(0, separator).trim().toLowerCase()] = line
      .slice(separator + 1)
      .trim();
  }
  return trailers;
}

/** Trailers arrive as text, whether in a frame or in an HTTP/2 trailer block. */
export function parseGrpcStatus(text: string): { code: number; details: string } {
  let code = 0;
  let details = "";
  for (const line of text.split(/\\r?\\n/)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name === "grpc-status") code = Number(value);
    if (name === "grpc-message") details = decodeURIComponent(value);
  }
  return { code, details };
}

function statusFromHeaders(
  headers: Record<string, string>
): { code: number; details: string } | undefined {
  const raw = headers["grpc-status"];
  if (raw === undefined) return undefined;
  return {
    code: Number(raw),
    details: decodeURIComponent(headers["grpc-message"] ?? ""),
  };
}

/**
 * gRPC-Web over \`fetch\`: one request body, framed; the status rides in a
 * trailer frame at the end of the response body, or in the headers when the
 * server failed before producing anything.
 */
function fetchTransport(config: ClientConfig): GrpcTransport {
  return {
    duplex: false,

    call(call: GrpcTransportCall): GrpcTransportResponse {
      let resolveHeaders!: (value: { status: number; headers: Record<string, string> }) => void;
      let rejectHeaders!: (reason: unknown) => void;
      const headers = new Promise<{ status: number; headers: Record<string, string> }>(
        (resolve, reject) => {
          resolveHeaders = resolve;
          rejectHeaders = reject;
        }
      );
      headers.catch(() => {});

      let resolveTrailers!: (value: Record<string, string>) => void;
      const trailers = new Promise<Record<string, string>>((resolve) => {
        resolveTrailers = resolve;
      });
      let trailing: Record<string, string> = {};

      const messages = (async function* () {
        try {
          const collected: Uint8Array[] = [];
          for await (const message of call.messages) collected.push(message);
          if (collected.length !== 1) {
            throw new GrpcError(
              12,
              "this transport sends one request message; client streaming needs the HTTP/2 transport"
            );
          }

          const requestEncoding = (call.headers["grpc-encoding"] ??
            "identity") as GrpcCompression;
          const http = httpTransport(config);
          const response = await http.call({
            method: "POST",
            url: call.url,
            headers: { ...call.headers, "content-type": GRPC_WEB_MIME, accept: GRPC_WEB_MIME, "x-grpc-web": "1" },
            body: await frameMessage(collected[0]!, requestEncoding),
            signal: call.signal,
          });

          const received: Record<string, string> = {};
          response.headers.forEach((value, key) => {
            received[key.toLowerCase()] = value;
          });
          resolveHeaders({ status: response.status, headers: received });

          const early = statusFromHeaders(received);
          if (!response.ok && !early) {
            throw new ApiError(response.status, await response.text(), response);
          }
          if (early && early.code !== 0) throw new GrpcError(early.code, early.details);

          let status = early ?? { code: 0, details: "" };
          const body = response.body;
          if (body) {
            // A \`ReadableStream\` is async-iterable at runtime everywhere this
            // client runs, but the DOM types do not say so; the reader does.
            const reader = body.getReader();
            const chunks = (async function* (): AsyncGenerator<Uint8Array> {
              while (true) {
                const { done, value } = await reader.read();
                if (value) yield value;
                if (done) break;
              }
            })();

            for await (const frame of grpcFrames(chunks, received["grpc-encoding"])) {
              if (frame.trailer) {
                // The trailer frame is a header block in text form, so the
                // metadata beside the status comes out of the same parse.
                const text = new TextDecoder().decode(frame.payload);
                status = parseGrpcStatus(text);
                trailing = parseTrailerBlock(text);
                continue;
              }
              yield frame.payload;
            }
          }

          if (status.code !== 0) {
            throw new GrpcError(status.code, status.details, trailing);
          }
        } catch (error) {
          // A failure before the headers arrived has to reach whoever awaited
          // them, or that promise never settles.
          rejectHeaders(error);
          throw error;
        } finally {
          resolveTrailers(trailing);
        }
      })();

      return { headers, messages, trailers };
    },
  };
}

function grpcTransport(config: ClientConfig): GrpcTransport {
  if (config.transport && typeof config.transport === "object" && "duplex" in config.transport) {
    return config.transport;
  }
  return fetchTransport(config);
}

/**
 * The metadata every call carries: how it may be compressed, how long it may
 * take, and whatever the caller added.
 *
 * \`grpc-accept-encoding\` goes out even when the request itself is plain, since
 * it is what lets the server compress its reply.
 */
function callHeaders(
  options: GrpcCallOptions | undefined,
  config: ClientConfig
): Record<string, string> {
  const headers: Record<string, string> = {
    te: "trailers",
    "grpc-accept-encoding": GRPC_ACCEPT_ENCODING,
    ...options?.headers,
  };

  const compression = config.compression ?? "identity";
  if (compression !== "identity") headers["grpc-encoding"] = compression;

  const timeout = options?.timeoutMs ?? config.timeoutMs;
  if (timeout !== undefined) headers["grpc-timeout"] = \`\${Math.ceil(timeout)}m\`;
  return headers;
}

/**
 * Runs one call: the interceptor chain, then the transport, then the response
 * messages.
 *
 * The chain is the same mechanism an HTTP call runs and sees the same \`Call\`,
 * so an interceptor that only adds a header is one function serving both. What
 * differs is what it gets back: a response that has not arrived yet, because a
 * stream never arrives all at once.
 */
async function* grpcCall(
  config: ClientConfig,
  path: string,
  requests: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  options: GrpcCallOptions | undefined,
  needsDuplex: boolean
): AsyncGenerator<Uint8Array> {
  const transport = grpcTransport(config);
  if (needsDuplex && !transport.duplex) {
    throw new GrpcError(
      12,
      "the configured transport cannot stream requests; use createHttp2Transport()"
    );
  }

  const call: Call = {
    method: "POST",
    url: \`\${config.baseUrl}\${path}\`,
    headers: callHeaders(options, config),
  };

  const invoke = (outgoing: Call): GrpcTransportResponse =>
    transport.call({
      url: outgoing.url,
      headers: outgoing.headers,
      messages: requests,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs ?? config.timeoutMs,
    });

  yield* chain(config.interceptors?.grpc, invoke)(call).messages;
}

/** A unary call: exactly one message out, exactly one back. */
async function grpcUnary(
  config: ClientConfig,
  path: string,
  request: Uint8Array,
  options?: GrpcCallOptions
): Promise<Uint8Array> {
  let message: Uint8Array | undefined;
  // A plain array rather than a generator, so an interceptor that calls \`next\`
  // twice sends the same message again instead of an empty stream.
  for await (const received of grpcCall(config, path, [request], options, false)) {
    message ??= received;
  }

  if (!message) throw new GrpcError(13, "the response carried no message");
  return message;
}

/** A client stream: many messages out, one back. */
async function grpcClientStream(
  config: ClientConfig,
  path: string,
  requests: AsyncIterable<Uint8Array>,
  options?: GrpcCallOptions
): Promise<Uint8Array> {
  let message: Uint8Array | undefined;
  for await (const received of grpcCall(config, path, requests, options, true)) {
    message ??= received;
  }

  if (!message) throw new GrpcError(13, "the response carried no message");
  return message;
}`;

/**
 * Every named type the client refers to.
 *
 * `components.schemas` is the declared set; a document can also name a type
 * only inside an operation, and those have to be declared too or the emitted
 * signatures would reference nothing.
 */
function declaredTypes(
  service: ServiceIR,
  types: Map<string, TypeIR> | undefined
): Map<string, TypeIR> {
  const declared = new Map<string, TypeIR>(types ?? []);

  const collect = (ir: TypeIR | undefined) => {
    if (!ir) return;
    for (const [name, named] of collectNamedTypes(ir)) {
      // A `ref` names its target without defining it.
      if (named.kind === "ref") continue;
      if (!declared.has(name)) declared.set(name, named);
    }
  };

  for (const method of service.methods) {
    if (isGrpcMethod(method)) {
      collect(method.request.message);
      for (const response of method.responses) collect(response.message);
      continue;
    }
    if (isOpenRpcMethod(method)) continue;
    for (const parameter of method.request.parameters ?? []) collect(parameter.type);
    for (const body of method.request.body ?? []) collect(body.content);
    for (const response of method.responses) {
      for (const body of response.body ?? []) collect(body.content);
      for (const header of response.headers ?? []) collect(header.type);
    }
  }

  return declared;
}

function emitFiles(
  service: ServiceIR,
  types: Map<string, TypeIR> | undefined,
  context: GeneratorContext<TsClientOptions>
): GeneratedFiles {
  const declared = declaredTypes(service, types);
  const identifiers = typeIdentifiers(declared.keys());

  const speaksHttp = service.methods.some(isHttpMethod);
  const speaksGrpc = service.methods.some(isGrpcMethod);
  const speaksAsyncApi = service.methods.some((m) => m.protocol === "asyncapi");
  const speaksOpenRpc = service.methods.some(isOpenRpcMethod);
  const isOnlyAsyncApi = speaksAsyncApi && !speaksHttp && !speaksGrpc && !speaksOpenRpc;

  const banner = (what: string) =>
    `// Generated by wiz from ${service.name ?? "an API document"}.\n` +
    `// ${what} Edit the document, not this file.\n`;

  const model = `${banner("Types the API exchanges.")}\n${tsDeclarations(
    declared,
    identifiers
  )}\n`;

  if (isOnlyAsyncApi) {
    const codecTypes = service.methods.length > 0 ? messageTypes(service.methods, declared, context.options) : [];
    const parts: string[] = [];
    if (codecTypes.length > 0) {
      parts.push(generateJsonCodecCode(codecTypes, { modelModule: `./${MODEL_FILE}`, identifiers }));
    }
    const codecContent = `${banner("Wire encoders and decoders.")}\n${parts.join("\n\n")}\n`;
    return {
      [MODEL_FILE]: model,
      [CODEC_FILE]: parts.length > 0 ? codecContent : `${banner("Wire encoders and decoders.")}\n`,
    };
  }

  const skipped: Record<string, true> = {};
  const onSkipped = (mimetype: string) => {
    if (skipped[mimetype]) return;
    skipped[mimetype] = true;
    context.logger.warn(
      `[wiz] ${mimetype} payloads are not emitted; the client speaks ${JSON_MIME}`
    );
  };

  const unsupported: Record<string, true> = {};
  const onUnsupported = (name: string, reason: string) => {
    if (unsupported[name]) return;
    unsupported[name] = true;
    context.logger.warn(`[wiz] ${name} is emitted as a throwing stub: ${reason}`);
  };

  const names = methodNames(service);
  const grpcMethods = service.methods.filter(isGrpcMethod);
  const operations = service.methods.map((method) => {
    if (isGrpcMethod(method)) {
      return grpcOperation(method, names.get(method)!, identifiers, onUnsupported);
    }
    if (isOpenRpcMethod(method)) {
      return openRpcOperation(method, names.get(method)!, identifiers);
    }
    return httpOperation(
      method as HttpServiceMethodIR,
      names.get(method)!,
      identifiers,
      declared,
      context.options,
      onSkipped
    );
  });
  const clientInterface = [
    "/**",
    " * Every operation the document declares.",
    " *",
    " * A caller that talks to one deployment can ignore this and use the",
    " * module-level functions below; a caller that talks to several holds one",
    " * client per configuration.",
    " */",
    "export interface Client {",
    operations
      .map((operation) => {
        const doc = operation.doc
          ? operation.doc
              .split("\n")
              .filter((line) => line.length > 0)
              .map((line) => `  ${line}`)
              .join("\n") + "\n"
          : "";
        return `${doc}  ${operation.name}(${operation.parameter}): ${operation.returns};`;
      })
      .join("\n"),
    "}",
  ].join("\n");

  const factory = [
    "/**",
    " * A client bound to its own configuration.",
    " *",
    " * Two tenants, two base URLs or two credentials are two clients; nothing is",
    " * shared between them, and the module-level default is just one more.",
    " */",
    "export function createClient(overrides: Partial<ClientConfig> = {}): Client {",
    "  const config: ClientConfig = { ...DEFAULTS, ...overrides };",
    "",
    "  return {",
    operations.map((operation) => operation.implementation).join("\n"),
    "  };",
    "}",
  ].join("\n");

  const moduleLevel = [
    "let defaults: ClientConfig = { ...DEFAULTS };",
    "let client: Client = createClient();",
    "",
    "/**",
    " * Merges into the configuration the module-level functions use, so a base",
    " * URL and an interceptor can be set from different places.",
    " */",
    "export function configure(next: Partial<ClientConfig>): void {",
    "  defaults = { ...defaults, ...next };",
    "  client = createClient(defaults);",
    "}",
    "",
    "export function currentConfig(): ClientConfig {",
    "  return defaults;",
    "}",
    "",
    operations
      .map((operation) => {
        // Typed from `Client`, so a delegate cannot drift from the method it
        // forwards to, and reads `client` per call so `configure` still applies.
        // The names have to match the emitted signature, since the parameters
        // are what the delegate forwards.
        const parameters = operation.parameter
          .split(",")
          .map((part) => part.trim().split(/[?:]/)[0]!.trim())
          .filter((name) => name.length > 0)
          .join(", ");
        return `${operation.doc}export const ${operation.name}: Client[${JSON.stringify(
          operation.name
        )}] = (${parameters}) => client.${operation.name}(${parameters});`;
      })
      .join("\n\n"),
  ].join("\n");

  // Only the names the signatures actually mention are imported, so the file
  // stays clean under `noUnusedLocals`.
  const declarations = `${clientInterface}\n\n${factory}\n\n${moduleLevel}`;
  const imported = [...identifiers.values()]
    .filter((identifier) => new RegExp(`\\b${identifier}\\b`).test(declarations))
    .sort();

  // The wire codec is a file of its own: it is the only generated code with no
  // types in it, it is large, and a caller may well want to frame a message
  // without going through a method.
  const codecTypes = service.methods.length > 0 ? messageTypes(service.methods, declared, context.options) : [];
  const speaksErlangText = service.methods.some((m) => {
    if (!isHttpMethod(m)) return false;
    const http = m as HttpServiceMethodIR;
    const reqBody = selectBody(http.request.body, context.options, () => {});
    const respBody = selectBody(http.responses[0]?.body, context.options, () => {});
    const reqMime = reqBody?.mimetype.toLowerCase() ?? "";
    const respMime = respBody?.mimetype.toLowerCase() ?? "";
    const isErlangText = (mime: string) => mime.includes("erlang") && !mime.includes("binary") && !mime.includes("etf");
    return isErlangText(reqMime) || isErlangText(respMime);
  });

  const speaksErlangBinary = service.methods.some((m) => {
    if (!isHttpMethod(m)) return false;
    const http = m as HttpServiceMethodIR;
    const reqBody = selectBody(http.request.body, context.options, () => {});
    const respBody = selectBody(http.responses[0]?.body, context.options, () => {});
    const reqMime = reqBody?.mimetype.toLowerCase() ?? "";
    const respMime = respBody?.mimetype.toLowerCase() ?? "";
    const isErlangBinary = (mime: string) => mime.includes("erlang-binary") || mime.includes("x-erlang-binary") || mime.includes("etf");
    return isErlangBinary(reqMime) || isErlangBinary(respMime);
  });

  const codecImports = [...new Set([
    ...codecTypes.flatMap(({ name }) => {
      const identifier = identifiers.get(name);
      return identifier
        ? [codecName("encode", identifier), codecName("decode", identifier)]
        : [];
    }),
    ...(speaksErlangText ? ["encodeErlangText", "decodeErlangText"] : []),
    ...(speaksErlangBinary ? ["encodeErlangBinary", "decodeErlangBinary"] : []),
  ])]
    .filter((fn) => new RegExp(`\\b${fn}\\b`).test(declarations) || speaksErlangText || speaksErlangBinary)
    .sort();
  // The gRPC fields only exist on a client that has rpcs to make, so the shared
  // configuration carries them conditionally rather than always.
  const transportConfig = speaksGrpc
    ? [
        "  /**",
        "   * Custom transport. Defaults to `fetch` for HTTP or gRPC-Web over `fetch`",
        "   * for gRPC; `createHttp2Transport()` speaks gRPC proper over HTTP/2.",
        "   */",
        "  transport?: GrpcTransport | HttpTransport | FetchLike;",
      ].join("\n")
    : [
        "  /**",
        "   * Custom HTTP transport. Defaults to globalThis.fetch when omitted.",
        "   */",
        "  transport?: HttpTransport | FetchLike;",
      ].join("\n");

  const grpcConfig = speaksGrpc
    ? [
        "  /**",
        "   * Compresses outgoing messages. A client always advertises that it",
        "   * accepts `gzip` and `deflate`, so a server may compress its replies",
        "   * whatever this is set to.",
        "   */",
        "  compression?: GrpcCompression;",
        "",
      ].join("\n")
    : "";

  // A key per protocol the document speaks, so an interceptor array is never
  // written into a slot nothing reads. Both are the same mechanism either way.
  const interceptorKeys = [
    ...(speaksHttp
      ? [
          "  /** Outermost first: `[a, b]` runs a around b around the request. */",
          "  http?: HttpInterceptor[];",
        ]
      : []),
    ...(speaksGrpc
      ? [
          speaksHttp
            ? "  /** Outermost first, exactly as `http`. */"
            : "  /** Outermost first: `[a, b]` runs a around b around the call. */",
          "  grpc?: GrpcInterceptor[];",
        ]
      : []),
    "",
  ].join("\n");

  // The checks are emitted per operation, but the helpers they call and the
  // error they throw are shared, so the set is collected once over the whole
  // service. Refs are inlined first for the same reason they are at the
  // callsite: a ref carries no constraints, and the type it names carries them.
  const valHelpers = new Set<string>();
  const validatedIRs: TypeIR[] = [];
  for (const method of service.methods) {
    if (!isHttpMethod(method)) continue;
    const http = method as HttpServiceMethodIR;
    const params = http.request.parameters ?? [];
    const grouped = (location: ParameterIR["in"]) =>
      params.filter((parameter) => parameter.in === location);

    const isSuccess = (response: HttpResponseIR) =>
      typeof response.status === "number" &&
      response.status >= 200 &&
      response.status < 300;
    const successes = http.responses.filter(isSuccess);
    const chosen =
      successes.length > 0
        ? successes
        : http.responses.filter((response) => response.status === "default");

    const candidates: Array<[ValidateTarget, TypeIR | undefined]> = [
      ["path", parameterGroupTypeIR(grouped("path"), "path")],
      ["query", parameterGroupTypeIR(grouped("query"), "query")],
      ["headers", parameterGroupTypeIR(grouped("header"), "header")],
      ["body", jsonBody(http.request.body, onSkipped)],
      ["response", jsonBody(chosen[0]?.body, onSkipped)],
    ];

    for (const [target, ir] of candidates) {
      if (!ir || !isValidationEnabled(context.options, target)) continue;
      validatedIRs.push(inlineRefs(ir, declared));
    }
  }
  for (const ir of validatedIRs) {
    // `annotate`: this file is compiled by the consumer, not loaded as JS.
    for (const helper of helpersFor(ir, true)) valHelpers.add(helper);
  }

  // Only a client that validates carries the error type: an unused exported
  // class in every other client is noise a consumer has to read past.
  const validates = validatedIRs.length > 0;

  const validationPrelude = validates
    ? `
/** One failed check, in the shape \`wiz\`'s own validators report. */
export interface ValidationError {
  path: string;
  message: string;
  constraint?: string;
  expected?: string;
  actual?: unknown;
}

/**
 * A request the document's own schema rejects, or a response that does not
 * match what it promised. Thrown before the call goes out for a request, and
 * after the body is decoded for a response, so \`errors\` always names the part
 * that failed rather than the whole payload.
 */
export class ClientValidationError extends Error {
  readonly target: "path" | "query" | "body" | "headers" | "response";
  readonly errors: ValidationError[];

  constructor(
    target: "path" | "query" | "body" | "headers" | "response",
    errors: ValidationError[]
  ) {
    super(
      \`Validation failed for \${target}: \${errors
        .map((error) => (error.path ? \`\${error.path}: \${error.message}\` : error.message))
        .join("; ")}\`
    );
    this.name = "ClientValidationError";
    this.target = target;
    this.errors = errors;
  }
}

${valHelpers.size > 0 ? `${[...valHelpers].join("\n\n")}\n` : ""}`
    : "";

  const api = [
    banner("Every operation the document declares."),
    imported.length > 0
      ? `\nimport type { ${imported.join(", ")} } from "./${MODEL_FILE}";\n`
      : "",
    codecImports.length > 0
      ? `import { ${codecImports.join(", ")} } from "./${CODEC_FILE}";\n`
      : "",
    `\n${validationPrelude}${PRELUDE.replace("__GRPC_CONFIG__", grpcConfig)
      .replace("__TRANSPORT_CONFIG__", transportConfig)
      .replace("__INTERCEPTOR_KEYS__", interceptorKeys)
      .replace(
        "__HTTP_CHAIN__",
        speaksHttp ? "chain(config.interceptors?.http, invoke)" : "invoke"
      )}\n`,
    grpcMethods.length > 0 ? `\n${GRPC_PRELUDE}\n` : "",
    operations.length > 0 ? `\n${declarations}\n` : "",
  ].join("");

  const parts: string[] = [];
  if (speaksGrpc) {
    parts.push(generateProtobufCodecCode(codecTypes, { modelModule: `./${MODEL_FILE}`, identifiers }));
  }
  if ((speaksHttp || speaksAsyncApi) && codecTypes.length > 0) {
    parts.push(generateJsonCodecCode(codecTypes, { modelModule: `./${MODEL_FILE}`, identifiers }));
  }
  const emptyIR: TypeIR = { id: "erlang", kind: "primitive", type: "unknown" };
  if (speaksErlangText) {
    parts.push(generateErlangTextCode(emptyIR));
  }
  if (speaksErlangBinary) {
    parts.push(generateErlangBinaryCode(emptyIR));
  }

  const codecContent = `${banner("Wire encoders and decoders.")}\n${parts.join("\n\n")}\n`;

  if (isOnlyAsyncApi) {
    return {
      [MODEL_FILE]: model,
      [CODEC_FILE]: parts.length > 0 ? codecContent : `${banner("Wire encoders and decoders.")}\n`,
    };
  }

  const files: GeneratedFiles = { [MODEL_FILE]: model, [API_FILE]: api };
  if (parts.length > 0) {
    files[CODEC_FILE] = codecContent;
    if (speaksGrpc) {
      files[TRANSPORT_FILE] = `${banner(
        "The HTTP/2 transport, for a server that speaks gRPC proper."
      )}\n${HTTP2_TRANSPORT}\n`;
    }
  }
  return files;
}

/** Every message or body a service method puts on the wire, in a stable order. */
function messageTypes(
  methods: ServiceMethodIR[],
  declared: ReadonlyMap<string, TypeIR>,
  options: TsClientOptions
): Array<{ name: string; ir: TypeIR }> {
  const wanted = new Map<string, TypeIR>();

  for (const method of methods) {
    if (isGrpcMethod(method)) {
      for (const message of [
        method.request.message,
        ...method.responses.map((response) => response.message),
      ]) {
        const name = message.name;
        if (!name) continue;
        const ir = declared.get(name) ?? message;
        if (ir.kind !== "ref") wanted.set(name, ir);
      }
    } else {
      const http = method as HttpServiceMethodIR;
      const reqBody = jsonBody(http.request.body, options, () => {});
      if (reqBody) {
        const name = reqBody.name;
        if (name) {
          const ir = declared.get(name) ?? reqBody;
          if (ir.kind !== "ref") wanted.set(name, ir);
        }
      }
      for (const response of http.responses) {
        const resBody = jsonBody(response.body, options, () => {});
        if (resBody) {
          const name = resBody.name;
          if (name) {
            const ir = declared.get(name) ?? resBody;
            if (ir.kind !== "ref") wanted.set(name, ir);
          }
        }
      }
    }
  }
  return [...wanted].map(([name, ir]) => ({ name, ir }));
}

export const tsClientGenerator: Generator<TsClientOptions> = {
  name: "typescript-client",

  api(ir: ApiIR, context) {
    return emitFiles(ir.service, ir.types, context);
  },

  /** A service on its own still needs its types declared to compile. */
  service(ir: ServiceIR, context) {
    return emitFiles(ir, undefined, context);
  },
};

export default tsClientGenerator;
