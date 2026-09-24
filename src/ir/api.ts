import type { HttpResponseIR, ParameterIR, ServiceIR, ServiceMethodBodyIR } from './service.ts';
import type { TypeIR } from './types.ts';

/** One keyword the document used that the IR cannot represent. */
export interface ApiDiagnostic {
  /** JSON pointer into the source document, e.g. `#/components/schemas/User/not`. */
  pointer: string;
  /** The offending keyword or construct, e.g. `not`, `minProperties`, `2XX`. */
  keyword: string;
  message: string;
}
export type SecuritySchemeType = 'http' | 'apiKey' | 'oauth2' | 'openIdConnect';

export interface SecurityOAuthFlowIR {
  authorizationUrl?: string;
  tokenUrl?: string;
  refreshUrl?: string;
  scopes?: Record<string, string>;
}

export interface SecurityOAuthFlowsIR {
  implicit?: SecurityOAuthFlowIR;
  password?: SecurityOAuthFlowIR;
  clientCredentials?: SecurityOAuthFlowIR;
  authorizationCode?: SecurityOAuthFlowIR;
}

export interface SecuritySchemeIR {
  type: SecuritySchemeType;
  description?: string;
  name?: string;
  in?: 'header' | 'query' | 'cookie';
  scheme?: string;
  bearerFormat?: string;
  flows?: SecurityOAuthFlowsIR;
  openIdConnectUrl?: string;
}

/**
 * The document's reusable components, keyed by their declared name.
 *
 * Kept as registries rather than dereferenced away, so a model or client
 * emitter can name what the document named. Operations reference them through
 * the `component` field on `ParameterIR`, `HttpResponseIR` and
 * `HttpRequestIR.bodyComponent`, while still carrying the resolved value, so a
 * consumer that does not care about reuse can ignore this entirely.
 */
export interface ApiComponentsIR {
  /** `components.parameters`. */
  parameters: Map<string, ParameterIR>;
  /** `components.headers`; header-shaped, so each has `in: "header"`. */
  headers: Map<string, ParameterIR>;
  /** `components.requestBodies`: the media types each offers. */
  requestBodies: Map<string, { bodies: ServiceMethodBodyIR[]; required: boolean }>;
  /**
   * `components.responses`. A response component has no status of its own, so
   * `status` is `"default"` as a placeholder; the operation that uses it holds
   * the real status. HTTP-shaped, because components are an OpenAPI concept:
   * a gRPC method has one response and nothing to reuse.
   */
  responses: Map<string, HttpResponseIR>;
  /** `components.securitySchemes`. */
  securitySchemes: Map<string, SecuritySchemeIR>;
}
export interface ApiIR {
  kind: 'api';
  /**
   * The dialect the document was written in. An OpenAPI version, or `proto3`
   * for a `.proto` file: one field, because every consumer that cares asks the
   * same question - what shape was this before it became IR.
   */
  version: '3.0' | '3.1' | 'proto3' | 'openrpc-1.3' | 'asyncapi-2.6' | 'asyncapi-3.0';
  /** `components.schemas`, or a proto file's messages and enums, by name. */
  types: Map<string, TypeIR>;
  /** The other four component sections, by name. Empty for a proto file. */
  components: ApiComponentsIR;
  /**
   * `paths` as callable methods, plus `info` mapped onto name/version/
   * description. For a proto file, every rpc of every service in it: the
   * service each one belongs to is part of its address.
   */
  service: ServiceIR;
  /** Everything dropped, so a caller can see what was lost. */
  diagnostics: ApiDiagnostic[];
}

export function emptyApiComponents(): ApiComponentsIR {
  return {
    parameters: new Map(),
    headers: new Map(),
    requestBodies: new Map(),
    responses: new Map(),
    securitySchemes: new Map(),
  };
}
