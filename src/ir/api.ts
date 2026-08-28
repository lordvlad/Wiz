import type { TypeIR } from "./types.ts";
import type {
  ParameterIR,
  ServiceIR,
  ServiceMethodBodyIR,
  ServiceMethodResponseIR,
} from "./service.ts";

/** One keyword the document used that the IR cannot represent. */
export interface ApiDiagnostic {
  /** JSON pointer into the source document, e.g. `#/components/schemas/User/not`. */
  pointer: string;
  /** The offending keyword or construct, e.g. `not`, `minProperties`, `2XX`. */
  keyword: string;
  message: string;
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
  requestBodies: Map<
    string,
    { bodies: ServiceMethodBodyIR[]; required: boolean }
  >;
  /**
   * `components.responses`. A response component has no status of its own, so
   * `status` is `"default"` as a placeholder; the operation that uses it holds
   * the real status.
   */
  responses: Map<string, ServiceMethodResponseIR>;
}

export interface ApiIR {
  kind: "api";
  /** OpenAPI dialect the document declared. */
  version: "3.0" | "3.1";
  /** `components.schemas`, by name, in document order. */
  types: Map<string, TypeIR>;
  /** The other four component sections, by name. */
  components: ApiComponentsIR;
  /** `paths` as callable methods, plus `info` mapped onto name/version/description. */
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
  };
}
