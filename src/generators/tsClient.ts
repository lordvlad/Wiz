import type { ApiIR } from "../ir/api.ts";
import type {
  ParameterIR,
  ServiceIR,
  ServiceMethodBodyIR,
  ServiceMethodIR,
  ServiceMethodResponseIR,
} from "../ir/service.ts";
import { collectNamedTypes, type TypeIR } from "../types.ts";
import type { GeneratedFiles, Generator, GeneratorContext } from "./generator.ts";
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

/** `/pets/{petId}` -> `getPetsByPetId`, for an operation that named nothing. */
function derivedName(method: ServiceMethodIR): string {
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
  method: ServiceMethodIR,
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
  method: ServiceMethodIR,
  identifiers: ReadonlyMap<string, string>,
  onSkipped: (mimetype: string) => void
): string {
  const isSuccess = (response: ServiceMethodResponseIR) =>
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
  method: ServiceMethodIR,
  access: string,
  hasQuery: boolean
): string {
  const path = method.address.path.replace(
    /\{([^}]+)\}/g,
    (_match, name: string) => {
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

/** One operation, in the three shapes the emitted file needs it in. */
interface Operation {
  name: string;
  doc: string;
  /** `options: { … }`, `options?: { … }`, or nothing at all. */
  parameter: string;
  returns: string;
  /** The method body, as a member of the object `createClient` returns. */
  implementation: string;
}

function operationFor(
  method: ServiceMethodIR,
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
    returns,
    // Parameters are left unannotated: the object literal is contextually typed
    // by `Client`, so the signature has exactly one source of truth.
    implementation: `    async ${name}(${slots.length === 0 ? "" : "options"}) {\n${body}\n    },`,
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
  body?: string;
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
  init: { method: string; headers: Record<string, string>; body?: string }
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
  fetch: (url, init) => globalThis.fetch(url, init),
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

  const names = methodNames(service);
  const operations = service.methods.map((method) =>
    operationFor(method, names.get(method)!, identifiers, context.options, onSkipped)
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
        return `${doc}  ${operation.name}(${operation.parameter}): Promise<${operation.returns}>;`;
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
        const argument = operation.parameter === "" ? "" : "options";
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

  const api = [
    banner("Every operation the document declares."),
    imported.length > 0
      ? `\nimport type { ${imported.join(", ")} } from "./${MODEL_FILE}";\n`
      : "",
    `\n${PRELUDE}\n`,
    operations.length > 0 ? `\n${declarations}\n` : "",
  ].join("");

  return { [MODEL_FILE]: model, [API_FILE]: api };
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
