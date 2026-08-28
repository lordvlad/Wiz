import type { TypeIR } from "./types.ts";

/**
 * Transport a service method speaks. Every address/request/response carries it
 * so those pieces stay self-describing when passed around on their own, and
 * `ServiceMethodIR` repeats it so a whole method narrows in one check.
 */
export type Protocol = "http";

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
}

export type ServiceMethodAddressIR = HttpAddressIR;

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
  in: "path" | "query" | "header" | "cookie";
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

export type ServiceMethodRequestIR = HttpRequestIR;

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

export type ServiceMethodResponseIR = HttpResponseIR;

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
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  /**
   * Verbatim source for a caller-supplied options object, spread last by the
   * generator so hand-written OpenAPI beats anything derived from types.
   * Deliberately untyped: it is an escape hatch out of the IR, not part of it.
   */
  overrides?: string;
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
  version?: string;
  description?: string;
  methods: ServiceMethodIR[];
}

export function emptyService(): ServiceIR {
  return { kind: "service", methods: [] };
}
