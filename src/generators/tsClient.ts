import type { ApiIR } from "../ir/api.ts";
import {
  isGrpcMethod,
  isHttpMethod,
  type GrpcServiceMethodIR,
  type HttpResponseIR,
  type HttpServiceMethodIR,
  type ParameterIR,
  type ServiceIR,
  type ServiceMethodBodyIR,
  type ServiceMethodIR,
} from "../ir/service.ts";
import { collectNamedTypes, type TypeIR } from "../types.ts";
import type { GeneratedFiles, Generator, GeneratorContext } from "./generator.ts";
import { generateProtobufCodecCode } from "./protobuf.ts";
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

export interface TsClientOptions {
  /**
   * Widens the parameter objects: headers accept any string entry and query
   * accepts any string or boolean one, on top of what the document declared.
   *
   * The strict shape is the honest one, but real documents omit the header a
   * gateway requires, so the escape hatch is opt-in rather than absent.
   */
  lenient?: boolean;
}

const CODEC_FILE = "codec.ts";

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

/**
 * The JSON representation of a payload, which is the only one a fetch client
 * can build without being told how to encode the rest.
 */
function jsonBody(
  bodies: ServiceMethodBodyIR[] | undefined,
  onSkipped: (mimetype: string) => void
): TypeIR | undefined {
  if (!bodies || bodies.length === 0) return undefined;

  const json = bodies.find((body) => body.mimetype === JSON_MIME);
  for (const body of bodies) {
    if (body !== json) onSkipped(body.mimetype);
  }

  const chosen = json ?? bodies[0];
  return chosen && !isAbsent(chosen.content) ? chosen.content : undefined;
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
function methodNames(service: ServiceIR): Map<ServiceMethodIR, string> {
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

  const body = jsonBody(method.request.body, onSkipped);
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
    const body = jsonBody(response.body, onSkipped);
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
  options: TsClientOptions,
  onSkipped: (mimetype: string) => void
): Operation {
  const slots = requestSlots(method, identifiers, options, onSkipped);
  const returns = successType(method, identifiers, onSkipped);
  const required = slots.some((slot) => slot.required);
  // Without a required slot the whole argument is optional, so every read of it
  // has to tolerate its absence.
  const access = slots.length === 0 || required ? "options" : "options?";

  const parameter =
    slots.length === 0
      ? ""
      : `options${required ? "" : "?"}: { ${slots
          .map((slot) => `${slot.name}${slot.required ? "" : "?"}: ${slot.type}`)
          .join("; ")} }`;

  const has = (name: string) => slots.some((slot) => slot.name === name);
  const call = [
    `        method: ${JSON.stringify(method.address.method)},`,
    `        url: ${urlTemplate(method, access, has("query"))},`,
    `        headers: headerRecord(${[
      has("headers") ? `${access}.headers` : "undefined",
      has("cookie") ? `${access}.cookie` : "undefined",
      has("body") ? JSON.stringify(JSON_MIME) : "undefined",
    ].join(", ")}),`,
    ...(has("body") ? [`        body: JSON.stringify(${access}.body),`] : []),
  ].join("\n");

  const send = `send(config, {\n${call}\n      })`;
  const body =
    returns === "void"
      ? `      await ${send};`
      : `      return (await ${send}) as ${returns};`;

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
    implementation: `    async ${name}(${slots.length === 0 ? "" : "options"}) {\n${body}\n    },`,
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

  // A request stream needs to send frames after the response has begun, which
  // is a duplex exchange; `fetch` has one request body, sent whole. Emitting a
  // method that throws beats omitting it: the name is in the document, so a
  // caller looking for it deserves to be told why it cannot work here.
  if (method.request.streaming || !requestIdentifier || !responseIdentifier) {
    const reason = method.request.streaming
      ? "client and bidirectional streaming need a duplex transport, which fetch is not"
      : "its request or response message is not declared in this document";
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

  if (response?.streaming) {
    return {
      name,
      doc,
      parameter: `request: ${requestIdentifier}`,
      returns: `AsyncIterable<${responseIdentifier}>`,
      implementation: [
        `    async *${name}(request) {`,
        `      for await (const message of grpcStream(config, ${path}, ${encode}(request))) {`,
        `        yield ${decode}(message);`,
        `      }`,
        `    },`,
      ].join("\n"),
      streaming: true,
    };
  }

  return {
    name,
    doc,
    parameter: `request: ${requestIdentifier}`,
    returns: `Promise<${responseIdentifier}>`,
    implementation: [
      `    async ${name}(request) {`,
      `      return ${decode}(await grpcUnary(config, ${path}, ${encode}(request)));`,
      `    },`,
    ].join("\n"),
    streaming: false,
  };
}

/**
 * The runtime every emitted method shares.
 *
 * It is deliberately small and dependency-free: one configuration shape, two
 * hooks, and the encoding rules. Anything larger would be a framework the
 * consumer did not ask for. `send` takes the configuration rather than reading
 * a module-level one, which is what lets one file serve both a per-instance
 * client and the module-level default.
 */
const PRELUDE = `/** One outgoing call, as built by a method and seen by the hooks. */
export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** JSON text for an HTTP call, a framed protobuf message for a gRPC one. */
  body?: string | Uint8Array;
}

/** A call and what came back, before the status is judged. */
export interface CallResult {
  call: Call;
  response: Response;
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
  }
) => Promise<Response>;

export interface ClientConfig {
  /**
   * Prefix for every path. The document does not carry it: OpenAPI \`servers\`
   * describe environments, which is a runtime fact, not a compile-time one.
   */
  baseUrl: string;
  /**
   * Swappable, so a test can answer calls without a network. Typed as the part
   * of \`fetch\` this client uses rather than \`typeof fetch\`, because the global
   * carries runtime-specific extras - Bun puts \`preconnect\` on it - and
   * requiring those would make every stub implement them.
   */
  fetch: FetchLike;
  /**
   * Runs before the request is sent and may replace it: this is where an
   * Authorization header comes from. Awaited, so refreshing a token is allowed.
   */
  beforeCall?: (call: Call) => Call | Promise<Call>;
  /**
   * Runs once the response arrives, before its status is judged or its body
   * parsed. Awaited, and may substitute a different response.
   */
  afterCall?: (result: CallResult) => CallResult | Promise<CallResult>;
}

const DEFAULTS: ClientConfig = {
  baseUrl: "",
  fetch: (url, init) =>
    globalThis.fetch(url, {
      method: init.method,
      headers: init.headers,
      // A framed message is a \`Uint8Array\`, which is a body every runtime
      // accepts; the DOM types spell it as an ArrayBuffer-backed view, and a
      // plain \`Uint8Array\` is not that narrower type.
      body: init.body as BodyInit | undefined,
    }),
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
  if (!(response.headers.get("content-type") ?? "").includes("json")) return text;
  try {
    return JSON.parse(text);
  } catch {
    // A body that claims JSON and is not is still evidence; the caller sees it.
    return text;
  }
}

async function send(config: ClientConfig, call: Call): Promise<unknown> {
  const prepared = config.beforeCall ? await config.beforeCall(call) : call;
  const response = await config.fetch(prepared.url, {
    method: prepared.method,
    headers: prepared.headers,
    body: prepared.body,
  });
  const settled = config.afterCall
    ? await config.afterCall({ call: prepared, response })
    : { call: prepared, response };

  const body = await parseBody(settled.response);
  if (!settled.response.ok) {
    throw new ApiError(settled.response.status, body, settled.response);
  }
  return body;
}`;

/**
 * The gRPC half of the runtime, emitted only when the document declares rpcs.
 *
 * The transport is gRPC-Web, not gRPC: gRPC proper needs HTTP/2 trailers and a
 * duplex body, neither of which `fetch` exposes, so a fetch client that claimed
 * to speak gRPC would be lying. gRPC-Web is the framing designed for exactly
 * this constraint, and it is what a proxy in front of a gRPC server speaks.
 */
const GRPC_PRELUDE = `const GRPC_MIME = "application/grpc-web+proto";

/** A gRPC status other than OK. \`code\` is the canonical numeric status. */
export class GrpcError extends Error {
  readonly code: number;
  readonly details: string;

  constructor(code: number, details: string) {
    super(\`gRPC status \${code}\${details ? \`: \${details}\` : ""}\`);
    this.name = "GrpcError";
    this.code = code;
    this.details = details;
  }
}

/** One length-prefixed frame: a flag byte, a big-endian length, the message. */
function frameMessage(payload: Uint8Array): Uint8Array {
  const framed = new Uint8Array(payload.length + 5);
  const view = new DataView(framed.buffer);
  view.setUint8(0, 0);
  view.setUint32(1, payload.length, false);
  framed.set(payload, 5);
  return framed;
}

/** Trailers arrive as a frame, as HTTP/1 has nowhere else to put them. */
function trailerStatus(payload: Uint8Array): { code: number; details: string } {
  let code = 0;
  let details = "";
  for (const line of new TextDecoder().decode(payload).split(/\\r?\\n/)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name === "grpc-status") code = Number(value);
    if (name === "grpc-message") details = decodeURIComponent(value);
  }
  return { code, details };
}

/**
 * Status can arrive in the headers - a "trailers-only" reply, which is how a
 * server reports a failure before producing anything - or in a trailer frame.
 */
function headerStatus(response: Response): { code: number; details: string } | undefined {
  const raw = response.headers.get("grpc-status");
  if (raw === null) return undefined;
  return {
    code: Number(raw),
    details: decodeURIComponent(response.headers.get("grpc-message") ?? ""),
  };
}

async function grpcSend(
  config: ClientConfig,
  path: string,
  request: Uint8Array
): Promise<{ call: Call; response: Response }> {
  const call: Call = {
    method: "POST",
    url: \`\${config.baseUrl}\${path}\`,
    // \`x-grpc-web\` is what marks this as the framed dialect rather than proto
    // over plain HTTP; a proxy keys off it.
    headers: { "content-type": GRPC_MIME, accept: GRPC_MIME, "x-grpc-web": "1" },
    body: frameMessage(request),
  };

  const prepared = config.beforeCall ? await config.beforeCall(call) : call;
  const response = await config.fetch(prepared.url, {
    method: prepared.method,
    headers: prepared.headers,
    body: prepared.body,
  });
  return config.afterCall
    ? await config.afterCall({ call: prepared, response })
    : { call: prepared, response };
}

async function grpcUnary(
  config: ClientConfig,
  path: string,
  request: Uint8Array
): Promise<Uint8Array> {
  const { response } = await grpcSend(config, path, request);

  // A transport failure has no gRPC status at all, so it stays an ApiError:
  // the caller is looking at a proxy or a network, not at an rpc.
  const early = headerStatus(response);
  if (!response.ok && !early) {
    throw new ApiError(response.status, await response.text(), response);
  }
  if (early && early.code !== 0) throw new GrpcError(early.code, early.details);

  const bytes = new Uint8Array(await response.arrayBuffer());
  let message: Uint8Array | undefined;
  let status = early ?? { code: 0, details: "" };

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 5 <= bytes.length) {
    const flags = bytes[offset]!;
    const length = view.getUint32(offset + 1, false);
    const start = offset + 5;
    const payload = bytes.subarray(start, start + length);
    if ((flags & 0x80) !== 0) status = trailerStatus(payload);
    // Bit 0 marks a compressed frame. Reading it as-is would hand the codec
    // deflated bytes, so it is refused with UNIMPLEMENTED instead.
    else if ((flags & 0x01) !== 0) throw new GrpcError(12, "compressed frames are not supported");
    else message ??= payload;
    offset = start + length;
  }

  if (status.code !== 0) throw new GrpcError(status.code, status.details);
  if (!message) throw new GrpcError(13, "the response carried no message");
  return message;
}

/**
 * A server stream, yielded frame by frame.
 *
 * The body is read incrementally rather than buffered: a stream that only
 * arrives once the server is finished is not a stream.
 */
async function* grpcStream(
  config: ClientConfig,
  path: string,
  request: Uint8Array
): AsyncGenerator<Uint8Array> {
  const { response } = await grpcSend(config, path, request);

  const early = headerStatus(response);
  if (!response.ok && !early) {
    throw new ApiError(response.status, await response.text(), response);
  }
  if (early && early.code !== 0) throw new GrpcError(early.code, early.details);

  const reader = response.body?.getReader();
  if (!reader) throw new GrpcError(13, "the response had no body to stream");

  let buffer = new Uint8Array(0);
  let status = early ?? { code: 0, details: "" };

  const take = (length: number): Uint8Array => {
    const taken = buffer.subarray(0, length);
    buffer = buffer.subarray(length);
    return taken;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (value && value.length > 0) {
      const merged = new Uint8Array(buffer.length + value.length);
      merged.set(buffer, 0);
      merged.set(value, buffer.length);
      buffer = merged;
    }

    // A frame is only readable once its header and its whole payload arrived.
    while (buffer.length >= 5) {
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const length = view.getUint32(1, false);
      if (buffer.length < 5 + length) break;
      const flags = buffer[0]!;
      take(5);
      const payload = take(length);
      if ((flags & 0x80) !== 0) status = trailerStatus(payload);
      else if ((flags & 0x01) !== 0) {
        throw new GrpcError(12, "compressed frames are not supported");
      }
      else yield payload;
    }

    if (done) break;
  }

  if (status.code !== 0) throw new GrpcError(status.code, status.details);
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
    if (!isHttpMethod(method)) continue;
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
  const operations = service.methods.map((method) =>
    isGrpcMethod(method)
      ? grpcOperation(method, names.get(method)!, identifiers, onUnsupported)
      : httpOperation(
          method as HttpServiceMethodIR,
          names.get(method)!,
          identifiers,
          context.options,
          onSkipped
        )
  );

  const banner = (what: string) =>
    `// Generated by wiz from ${service.name ?? "an OpenAPI document"}.\n` +
    `// ${what} Edit the document, not this file.\n`;

  const model = `${banner("Types the API exchanges.")}\n${tsDeclarations(
    declared,
    identifiers
  )}\n`;

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
    " * Merges into the configuration the module-level functions use, so a base URL",
    " * and a hook can be set from different places.",
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
        const argument =
          operation.parameter === ""
            ? ""
            : operation.parameter.startsWith("request")
              ? "request"
              : "options";
        return `${operation.doc}export const ${operation.name}: Client[${JSON.stringify(
          operation.name
        )}] = (${argument}) => client.${operation.name}(${argument});`;
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
  const codecTypes = grpcMethods.length > 0 ? messageTypes(grpcMethods, declared) : [];
  const codecImports = [...new Set(
    codecTypes.flatMap(({ name }) => {
      const identifier = identifiers.get(name);
      return identifier
        ? [codecName("encode", identifier), codecName("decode", identifier)]
        : [];
    })
  )]
    .filter((fn) => new RegExp(`\\b${fn}\\b`).test(declarations))
    .sort();

  const api = [
    banner("Every operation the document declares."),
    imported.length > 0
      ? `\nimport type { ${imported.join(", ")} } from "./${MODEL_FILE}";\n`
      : "",
    codecImports.length > 0
      ? `import { ${codecImports.join(", ")} } from "./${CODEC_FILE}";\n`
      : "",
    `\n${PRELUDE}\n`,
    grpcMethods.length > 0 ? `\n${GRPC_PRELUDE}\n` : "",
    operations.length > 0 ? `\n${declarations}\n` : "",
  ].join("");

  const files: GeneratedFiles = { [MODEL_FILE]: model, [API_FILE]: api };
  if (codecTypes.length > 0) {
    files[CODEC_FILE] = `${banner("Protobuf readers and writers.")}\n${generateProtobufCodecCode(
      codecTypes,
      { modelModule: `./${MODEL_FILE}`, identifiers }
    )}\n`;
  }
  return files;
}

/** Every message a gRPC method puts on the wire, in a stable order. */
function messageTypes(
  methods: GrpcServiceMethodIR[],
  declared: ReadonlyMap<string, TypeIR>
): Array<{ name: string; ir: TypeIR }> {
  const wanted = new Map<string, TypeIR>();

  for (const method of methods) {
    for (const message of [
      method.request.message,
      ...method.responses.map((response) => response.message),
    ]) {
      const name = message.name;
      if (!name) continue;
      // The declared copy is the definition; a method may hold a `ref` to it.
      const ir = declared.get(name) ?? message;
      if (ir.kind !== "ref") wanted.set(name, ir);
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
