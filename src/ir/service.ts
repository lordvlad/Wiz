import { normalizeTypeIR, type TypeIR } from "./types.ts";

/**
 * Transport a service method speaks. Every address/request/response carries it
 * so those pieces stay self-describing when passed around on their own, and
 * `ServiceMethodIR` repeats it so a whole method narrows in one check.
 */
export type Protocol = "http" | "grpc" | "openrpc" | "mcp" | "asyncapi";

export type HttpMethodName =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS"
  | "TRACE";

/** Where a method lives. The part that differs most between protocols. */
export interface HttpAddressIR {
  protocol: "http";
  method: HttpMethodName;
  /** OpenAPI template form: `/users/{id}`, never `/users/:id`. */
  path: string;
  package?: string;
  service?: string;
  methodName?: string;
}

/**
 * A gRPC method is addressed by name rather than by path and verb: the
 * transport puts `/package.Service/Method` on the wire and nothing else varies,
 * so the three parts are held apart instead of pre-joined into a string.
 */
export interface GrpcAddressIR {
  protocol: "grpc";
  /** Proto package; absent for a file that declares none. */
  package?: string;
  /** The service the rpc was declared in. One file can declare several. */
  service: string;
  /** The rpc's own name, as written. */
  method: string;
}
export interface OpenRpcAddressIR {
  protocol: "openrpc";
  package?: string;
  service?: string;
  method: string;
}
export interface McpAddressIR {
  protocol: "mcp";
  package?: string;
  service?: string;
  method?: string;
  name: string;
}

/**
 * An AsyncAPI operation is addressed by channel plus the direction the
 * application takes on it, which is all the protocol puts on the wire.
 */
export interface AsyncApiAddressIR {
  protocol: "asyncapi";
  package?: string;
  service?: string;
  channel: string;
  action: string;
}

export type ServiceMethodAddressIR =
  | HttpAddressIR
  | GrpcAddressIR
  | OpenRpcAddressIR
  | McpAddressIR
  | AsyncApiAddressIR;

/**
 * One representation of a payload. A request or response holds a list of these
 * because the same payload is often offered in several media types.
 */
export interface ServiceMethodBodyIR {
  mimetype: string;
  content: TypeIR;
}

/** One parameter or response header, with the component name it came from. */
export interface ParameterIR {
  name: string;
  in: "path" | "query" | "header" | "cookie" | "rpc";
  /** Path parameters are always required, per the OpenAPI spec. */
  required: boolean;
  type: TypeIR;
  description?: string;
  deprecated?: boolean;
  /** Set when declared under `components.parameters` or `components.headers`. */
  component?: string;
}

export interface HttpRequestIR {
  protocol: "http";
  /** Path, query, header and cookie parameters in document order. */
  parameters?: ParameterIR[];
  body?: ServiceMethodBodyIR[];
  bodyRequired?: boolean;
  /** Set when the whole body came from a `components.requestBodies` entry. */
  bodyComponent?: string;
}

/**
 * A gRPC request is one message, not a set of slots: the transport carries no
 * query, no headers of its own and one media type, so everything a caller
 * supplies is inside that message. `streaming` is the `stream` keyword on the
 * request side, which makes the caller send many of them.
 */
export interface GrpcRequestIR {
  protocol: "grpc";
  message: TypeIR;
  streaming: boolean;
}
export interface OpenRpcRequestIR {
  protocol: "openrpc";
  params: ParameterIR[];
  paramsByName?: boolean;
}
export interface McpRequestIR {
  protocol: "mcp";
  input: TypeIR;
}
export interface AsyncApiRequestIR {
  protocol: "asyncapi";
  body?: ServiceMethodBodyIR[];
}

export type ServiceMethodRequestIR =
  | HttpRequestIR
  | GrpcRequestIR
  | OpenRpcRequestIR
  | McpRequestIR
  | AsyncApiRequestIR;


export interface HttpResponseIR {
  protocol: "http";
  /** `"default"` maps to the OpenAPI catch-all response. */
  status: number | "default";
  description?: string;
  body?: ServiceMethodBodyIR[];
  headers?: ParameterIR[];
  /** Set when the whole response came from a `components.responses` entry. */
  component?: string;
}

/**
 * A gRPC response is one message and a status that only exists at runtime, so
 * unlike HTTP there is nothing to enumerate at compile time: a method has
 * exactly one of these, streaming or not.
 */
export interface GrpcResponseIR {
  protocol: "grpc";
  message: TypeIR;
  streaming: boolean;
}
export interface OpenRpcResponseIR {
  protocol: "openrpc";
  result: TypeIR;
  error?: TypeIR;
}
export interface McpResponseIR {
  protocol: "mcp";
  output?: TypeIR;
}
export interface AsyncApiResponseIR {
  protocol: "asyncapi";
  body?: ServiceMethodBodyIR[];
}

export type ServiceMethodResponseIR =
  | HttpResponseIR
  | GrpcResponseIR
  | OpenRpcResponseIR
  | McpResponseIR
  | AsyncApiResponseIR;


/**
 * A single callable endpoint. Responses are a list rather than a TypeScript
 * union: a method genuinely has several of them at once (200 and 404 and 500),
 * so they must all be held, not chosen between.
 */
export interface ServiceMethodIR {
  kind: "serviceMethod";
  protocol: Protocol;
  address: ServiceMethodAddressIR;
  request: ServiceMethodRequestIR;
  responses: ServiceMethodResponseIR[];
  operationId?: string;
  title?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  annotations?: McpToolAnnotationsIR;
  /**
   * Verbatim source for a caller-supplied options object, spread last by the
   * generator so hand-written OpenAPI beats anything derived from types.
   * Deliberately untyped: it is an escape hatch out of the IR, not part of it.
   */
  overrides?: string;
}

/**
 * A method known to speak one protocol.
 *
 * `ServiceMethodIR` holds the union because a service can mix them; a consumer
 * that only understands one - an OpenAPI document emitter, a gRPC client - has
 * to narrow first, and these are the seams for it. The `protocol` field is the
 * discriminant: address, request and responses all follow from it.
 */
export interface HttpServiceMethodIR extends ServiceMethodIR {
  protocol: "http";
  address: HttpAddressIR;
  request: HttpRequestIR;
  responses: HttpResponseIR[];
}

export interface GrpcServiceMethodIR extends ServiceMethodIR {
  protocol: "grpc";
  address: GrpcAddressIR;
  request: GrpcRequestIR;
  responses: GrpcResponseIR[];
}
export interface OpenRpcServiceMethodIR extends ServiceMethodIR {
  protocol: "openrpc";
  address: OpenRpcAddressIR;
  request: OpenRpcRequestIR;
  responses: OpenRpcResponseIR[];
}
export interface McpToolAnnotationsIR {
  audience?: Array<"user" | "assistant">;
  priority?: number;
}
export interface McpServiceMethodIR extends ServiceMethodIR {
  protocol: "mcp";
  address: McpAddressIR;
  title?: string;
  annotations?: McpToolAnnotationsIR;
  request: McpRequestIR;
  responses: McpResponseIR[];
}
export interface AsyncApiServiceMethodIR extends ServiceMethodIR {
  protocol: "asyncapi";
  address: AsyncApiAddressIR;
  request: AsyncApiRequestIR;
  responses: AsyncApiResponseIR[];
}


export function isHttpMethod(
  method: ServiceMethodIR
): method is HttpServiceMethodIR {
  return method.protocol === "http";
}

export function isGrpcMethod(
  method: ServiceMethodIR
): method is GrpcServiceMethodIR {
  return method.protocol === "grpc";
}
export function isOpenRpcMethod(
  method: ServiceMethodIR
): method is OpenRpcServiceMethodIR {
  return method.protocol === "openrpc";
}
export function isMcpMethod(
  method: ServiceMethodIR
): method is McpServiceMethodIR {
  return method.protocol === "mcp";
}
export function isAsyncApiMethod(
  method: ServiceMethodIR
): method is AsyncApiServiceMethodIR {
  return method.protocol === "asyncapi";
}


/**
 * A collection of methods plus the identity shared by all of them.
 *
 * Document-level OpenAPI fields (`servers`, `security`, `externalDocs`, `info`)
 * are intentionally absent: they arrive at runtime through the base document so
 * they can be computed per environment. This IR holds only what is knowable at
 * compile time, which is also what a gRPC or GraphQL emitter would need.
 */
export interface ServiceIR {
  kind: "service";
  name?: string;
  package?: string;
  version?: string;
  description?: string;
  methods: ServiceMethodIR[];
}

export function emptyService(): ServiceIR {
  return { kind: "service", methods: [] };
}

/**
 * Stable, content-addressable projection of a service method, so two methods
 * that describe the same call hash alike and two that do not never collide.
 * Lives here rather than in the plugin because the virtual-module registry
 * keys on it too.
 */
export function normalizeServiceMethod(method: ServiceMethodIR): unknown {
  // Payload types are keyed with their names: an operation renders them as
  // `$ref`s into `components.schemas`, so a nested name is emitted output.
  const bodyKey = (bodies: ServiceMethodBodyIR[] | undefined) =>
    (bodies ?? []).map((b) => ({
      m: b.mimetype,
      c: normalizeTypeIR(b.content, true),
    }));

  // Every field here is rendered into the operation object, down to the
  // descriptions, so all of them have to separate two otherwise equal methods.
  const parameterKey = (p: ParameterIR) => [
    p.name,
    p.in,
    p.required,
    p.description ?? null,
    p.deprecated ?? null,
    p.component ?? null,
    normalizeTypeIR(p.type, true),
  ];

  // A gRPC method has no slots to key, and two shapes that hash alike must not
  // become one module: the streaming flags change the emitted signature as much
  // as the message types do.
  // Narrowed on the method's own discriminant rather than its request's, so
  // `responses` follows from it too: keying a response list against the wrong
  // protocol's fields is how two different methods hash alike.
  if (isGrpcMethod(method)) {
    const streamed = method.responses.find(
      (candidate): candidate is GrpcResponseIR => candidate.protocol === "grpc"
    );

    return {
      a: method.address,
      oi: method.operationId ?? null,
      su: method.summary ?? null,
      de: method.description ?? null,
      tg: method.tags ?? null,
      dp: method.deprecated ?? null,
      o: method.overrides ?? null,
      rq: {
        c: normalizeTypeIR(method.request.message, true),
        s: method.request.streaming,
      },
      rs: streamed
        ? { c: normalizeTypeIR(streamed.message, true), s: streamed.streaming }
        : null,
    };
  }
  if (isOpenRpcMethod(method)) {
    const openRpcResp = method.responses.find(
      (candidate): candidate is OpenRpcResponseIR =>
        candidate.protocol === "openrpc"
    );
    return {
      a: method.address,
      oi: method.operationId ?? null,
      su: method.summary ?? null,
      de: method.description ?? null,
      tg: method.tags ?? null,
      dp: method.deprecated ?? null,
      o: method.overrides ?? null,
      rq: {
        p: method.request.params.map(parameterKey),
        pbn: method.request.paramsByName ?? null,
      },
      rs: openRpcResp
        ? {
            res: normalizeTypeIR(openRpcResp.result, true),
            err: openRpcResp.error
              ? normalizeTypeIR(openRpcResp.error, true)
              : null,
          }
        : null,
    };
  }
  if (isMcpMethod(method)) {
    const mcpResp = method.responses.find(
      (candidate): candidate is McpResponseIR => candidate.protocol === "mcp"
    );
    return {
      a: method.address,
      t: method.title ?? null,
      de: method.description ?? null,
      ann: method.annotations ?? null,
      rq: {
        in: normalizeTypeIR(method.request.input, true),
      },
      rs: mcpResp?.output ? normalizeTypeIR(mcpResp.output, true) : null,
    };
  }
  if (isAsyncApiMethod(method)) {
    return {
      a: method.address,
      oi: method.operationId ?? null,
      su: method.summary ?? null,
      de: method.description ?? null,
      b: bodyKey(method.request.body),
    };
  }

  // `Protocol` is closed and the other two returned above, so this is the HTTP
  // case; the guard is what tells the compiler so, and it makes `responses` a
  // list of HTTP responses rather than the whole union.
  if (!isHttpMethod(method)) {
    throw new Error(
      `[wiz] cannot key a '${method.protocol}' service method: no normal form for it`
    );
  }

  const request = method.request;
  return {
    a: method.address,
    oi: method.operationId ?? null,
    su: method.summary ?? null,
    de: method.description ?? null,
    tg: method.tags ?? null,
    dp: method.deprecated ?? null,
    o: method.overrides ?? null,
    q: (request.parameters ?? []).map(parameterKey),
    b: bodyKey(request.body),
    br: request.bodyRequired ?? null,
    bc: request.bodyComponent ?? null,
    r: method.responses.map((response) => ({
      s: response.status,
      de: response.description ?? null,
      cp: response.component ?? null,
      b: bodyKey(response.body),
      h: (response.headers ?? []).map(parameterKey),
    })),
  };
}
