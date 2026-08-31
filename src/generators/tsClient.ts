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
    : `grpcOnce(${encode}(request))`;

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
__GRPC_CONFIG__}

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
 * The real gRPC transport, in a file of its own.
 *
 * It is separate because it imports `node:http2`, which a browser bundle must
 * never see. A consumer on a server opts in - `configure({ transport:
 * createHttp2Transport(...) })` - and gains what gRPC needs and `fetch` cannot
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
  /** \`https://host:port\` for TLS, \`http://host:port\` for cleartext h2c. */
  baseUrl: string;
  /** Passed to \`http2.connect\`, for a CA bundle or a client certificate. */
  session?: http2.SecureClientSessionOptions;
}

export interface Http2Transport extends GrpcTransport {
  /** Closes the pooled session. A process that exits does not need this. */
  close(): void;
}

/**
 * One session per transport, reopened when it goes away.
 *
 * HTTP/2 multiplexes every call over one connection, which is the whole reason
 * gRPC uses it: a stream is cheap, a connection is not.
 */
export function createHttp2Transport(
  options: Http2TransportOptions
): Http2Transport {
  const origin = new URL(options.baseUrl).origin;
  let session: http2.ClientHttp2Session | undefined;

  const connected = (): http2.ClientHttp2Session => {
    if (session && !session.closed && !session.destroyed) return session;
    session = http2.connect(origin, options.session);
    // Without this an idle session's error takes the process down.
    session.on("error", () => {
      session = undefined;
    });
    return session;
  };

  return {
    duplex: true,

    close() {
      session?.close();
      session = undefined;
    },

    call(call: GrpcTransportCall): GrpcTransportResponse {
      const stream = connected().request({
        ":method": "POST",
        ":path": call.path,
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
      // A caller only awaits the headers when it has an \`afterCall\` hook. The
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
  /** \`/package.Service/Method\`. */
  path: string;
  headers: Record<string, string>;
  /** One message for a unary request, many for a client stream. */
  messages: AsyncIterable<Uint8Array>;
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

/** The one-message stream a unary or server-streaming request sends. */
async function* grpcOnce(message: Uint8Array): AsyncGenerator<Uint8Array> {
  yield message;
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
          const response = await config.fetch(\`\${config.baseUrl}\${call.path}\`, {
            method: "POST",
            headers: { ...call.headers, "content-type": GRPC_WEB_MIME, accept: GRPC_WEB_MIME, "x-grpc-web": "1" },
            body: await frameMessage(collected[0]!, requestEncoding),
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
  return config.transport ?? fetchTransport(config);
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
 * Runs one call: hooks, then the transport, then the response messages.
 *
 * The hooks are the same two an HTTP call runs, so a token injected for one is
 * injected for the other. \`afterCall\` sees a \`Response\` synthesised from the
 * response headers when the transport has no \`Response\` of its own.
 */
async function* grpcCall(
  config: ClientConfig,
  path: string,
  requests: AsyncIterable<Uint8Array>,
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
  const prepared = config.beforeCall ? await config.beforeCall(call) : call;

  const response = transport.call({
    path,
    headers: prepared.headers,
    messages: requests,
    signal: options?.signal,
    timeoutMs: options?.timeoutMs ?? config.timeoutMs,
  });

  if (config.afterCall) {
    const received = await response.headers;
    // HTTP/2 pseudo-headers are not headers: \`Response\` rejects a name starting
    // with a colon, and \`:status\` is carried as the status anyway.
    const plain: Record<string, string> = {};
    for (const [name, value] of Object.entries(received.headers)) {
      if (!name.startsWith(":")) plain[name] = value;
    }

    await config.afterCall({
      call: prepared,
      response: new Response(null, { status: received.status, headers: plain }),
    });
  }

  yield* response.messages;

  // Trailing metadata is only known once the stream is done, which is why it is
  // its own hook rather than part of \`afterCall\`: that one runs when the
  // headers arrive, and awaiting trailers there would wait for messages nobody
  // is reading yet. A caller that abandons the iteration early never gets here,
  // and a failure carries its metadata on \`GrpcError\` instead.
  if (config.onTrailers) {
    await config.onTrailers(await response.trailers, prepared);
  }
}

/** A unary call: exactly one message out, exactly one back. */
async function grpcUnary(
  config: ClientConfig,
  path: string,
  request: Uint8Array,
  options?: GrpcCallOptions
): Promise<Uint8Array> {
  let message: Uint8Array | undefined;
  for await (const received of grpcCall(config, path, grpcOnce(request), options, false)) {
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

  // The gRPC fields only exist on a client that has rpcs to make, so the shared
  // configuration carries them conditionally rather than always.
  const grpcConfig =
    grpcMethods.length > 0
      ? [
          "  /**",
          "   * How gRPC calls travel. Defaults to gRPC-Web over `fetch`, which runs",
          "   * anywhere; `createHttp2Transport()` from ./transport.ts speaks gRPC",
          "   * proper and is the only one that can stream requests.",
          "   */",
          "  transport?: GrpcTransport;",
          "  /**",
          "   * Compresses outgoing messages. A client always advertises that it",
          "   * accepts `gzip` and `deflate`, so a server may compress its replies",
          "   * whatever this is set to.",
          "   */",
          "  compression?: GrpcCompression;",
          "  /**",
          "   * Runs once a call's stream has ended, with whatever the server",
          "   * appended. A failure reports its own metadata on `GrpcError`",
          "   * instead, since a failed call has no stream to end.",
          "   */",
          "  onTrailers?: (",
          "    trailers: Record<string, string>,",
          "    call: Call",
          "  ) => void | Promise<void>;",
          "  /** A deadline for every gRPC call, unless the call overrides it. */",
          "  timeoutMs?: number;",
          "",
        ].join("\n")
      : "";

  const api = [
    banner("Every operation the document declares."),
    imported.length > 0
      ? `\nimport type { ${imported.join(", ")} } from "./${MODEL_FILE}";\n`
      : "",
    codecImports.length > 0
      ? `import { ${codecImports.join(", ")} } from "./${CODEC_FILE}";\n`
      : "",
    `\n${PRELUDE.replace("__GRPC_CONFIG__", grpcConfig)}\n`,
    grpcMethods.length > 0 ? `\n${GRPC_PRELUDE}\n` : "",
    operations.length > 0 ? `\n${declarations}\n` : "",
  ].join("");

  const files: GeneratedFiles = { [MODEL_FILE]: model, [API_FILE]: api };
  if (codecTypes.length > 0) {
    files[CODEC_FILE] = `${banner("Protobuf readers and writers.")}\n${generateProtobufCodecCode(
      codecTypes,
      { modelModule: `./${MODEL_FILE}`, identifiers }
    )}\n`;
    files[TRANSPORT_FILE] = `${banner(
      "The HTTP/2 transport, for a server that speaks gRPC proper."
    )}\n${HTTP2_TRANSPORT}\n`;
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
