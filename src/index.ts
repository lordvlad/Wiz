import type { ValidationError } from "./types.ts";

export class PluginInactiveError extends Error {
  constructor(fnName: string) {
    super(
      `[wiz] Function '${fnName}' called without active Bun plugin. Please enable 'wizPlugin()' in your Bun runtime or build configuration.`
    );
    this.name = "PluginInactiveError";
  }
}

/**
 * A union that also declares a protobuf field number for each member.
 *
 * To TypeScript this is exactly the union of the map's values, so it is
 * assignable, narrowable and printable like any other union:
 *
 * ```ts
 * type Shape = NumberedUnion<{ 1: Circle; 2: Square }>;
 * const s: Shape = { kind: "circle", radius: 1 };
 * ```
 *
 * wiz reads the numbers off the declaration and emits a protobuf `oneof`.
 * The numbers live in the enclosing message's field-number space, exactly as
 * `oneof` members do on the wire, so they must not collide with sibling
 * fields, and the property itself takes no `@fieldNumber`.
 */
export type NumberedUnion<T extends Record<number, unknown>> = T[keyof T];

export function keysOf<T>(): (keyof T)[] {
  throw new PluginInactiveError("keysOf");
}

export function requiredKeysOf<T>(): (keyof T)[] {
  throw new PluginInactiveError("requiredKeysOf");
}

export function optionalKeysOf<T>(): (keyof T)[] {
  throw new PluginInactiveError("optionalKeysOf");
}

export function schema<
  T,
  V extends "draft-2020-12" | "draft-07" = "draft-2020-12"
>(_version?: V): Record<string, unknown> {
  throw new PluginInactiveError("schema");
}

export function validate<T>(_arg: unknown): ValidationError[] {
  throw new PluginInactiveError("validate");
}

/**
 * Narrows `arg` to `T` when the generated structural check passes.
 *
 * The same check `validate` runs, without building the error list.
 */
export function is<T>(_arg: unknown): _arg is T {
  throw new PluginInactiveError("is");
}
export type HttpMethod =
  | "get"
  | "post"
  | "put"
  | "patch"
  | "delete"
  | "head"
  | "options"
  | "trace";

export interface OperationOptions {
  tags?: string[];
  summary?: string;
  description?: string;
  operationId?: string;
  deprecated?: boolean;
  [key: string]: unknown;
}

/**
 * Compile-time descriptor produced by `openapiSchema.<method>()`.
 * Instances never exist at runtime: the plugin folds them into the document.
 */
export interface OpenApiOperation {
  method: HttpMethod;
  path: string;
}

export interface OperationBuilder {
  <TPathParams, TQueryParams, TResponse, TRequestBody>(
    path: string,
    options?: OperationOptions
  ): OpenApiOperation;
}

export type OpenApiVersion = "3.0" | "3.1" | 3.0 | 3.1;

export interface OpenApiSchemaBuilder {
  <TTypes extends unknown[], V extends OpenApiVersion = "3.1">(
    baseSchema?: Record<string, unknown>,
    operations?: OpenApiOperation[]
  ): Record<string, unknown>;
  get: OperationBuilder;
  post: OperationBuilder;
  put: OperationBuilder;
  patch: OperationBuilder;
  delete: OperationBuilder;
  head: OperationBuilder;
  options: OperationBuilder;
  trace: OperationBuilder;
  /**
   * Declares a Bun `routes` map to the document generator and returns it
   * **verbatim** — runtime behaviour is identical to passing the literal
   * straight to `Bun.serve`. The document is collected at compile time and
   * read back through {@link openapiDocument}.
   */
  bunRoutes<TRoutes>(
    baseSchema: Record<string, unknown>,
    routes: TRoutes
  ): TRoutes;
  /**
   * Mounts a route map onto any Hono-compatible app and returns the **app**
   * verbatim. Handlers reach the router untouched; only registration is done
   * here, so what is documented and what is mounted cannot drift.
   */
  honoRoutes<TApp>(
    app: TApp,
    baseSchema: Record<string, unknown>,
    routes: RouteMap
  ): TApp;
}

/** A route value is either a handler/response, or a map of method -> handler. */
export type RouteMap = Record<string, unknown>;

/**
 * Minimal structural view of a router. Hono's own `on` signature is generic
 * over env/path/schema in ways that cannot be restated here, so the app is
 * narrowed to the one method the adapter actually calls.
 */
interface RouteRegistrar {
  on(method: string, path: string, handler: unknown): unknown;
}

const HTTP_METHOD_NAMES = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "TRACE",
]);

function mountRoutes(app: unknown, routes: RouteMap): void {
  const registrar = app as unknown as RouteRegistrar;
  if (typeof registrar?.on !== "function") return;

  for (const [path, value] of Object.entries(routes)) {
    if (typeof value === "function") {
      // Bare handler: mounted as GET, matching how it is documented.
      registrar.on("GET", path, value);
      continue;
    }
    if (value === null || typeof value !== "object") continue;

    for (const [method, handler] of Object.entries(value)) {
      if (!HTTP_METHOD_NAMES.has(method.toUpperCase())) continue;
      if (typeof handler !== "function") continue;
      registrar.on(method.toUpperCase(), path, handler);
    }
  }
}

function operationStub(method: HttpMethod): OperationBuilder {
  return () => {
    throw new PluginInactiveError(`openapiSchema.${method}`);
  };
}

export const openapiSchema: OpenApiSchemaBuilder = Object.assign(
  (): Record<string, unknown> => {
    throw new PluginInactiveError("openapiSchema");
  },
  {
    get: operationStub("get"),
    post: operationStub("post"),
    put: operationStub("put"),
    patch: operationStub("patch"),
    delete: operationStub("delete"),
    head: operationStub("head"),
    options: operationStub("options"),
    trace: operationStub("trace"),
    // Identity by design: the plugin harvests descriptors from the callsite and
    // never rewrites the routes value, so servers behave the same either way.
    bunRoutes: <TRoutes>(
      _baseSchema: Record<string, unknown>,
      routes: TRoutes
    ): TRoutes => routes,
    honoRoutes: <TApp>(
      app: TApp,
      _baseSchema: Record<string, unknown>,
      routes: RouteMap
    ): TApp => {
      mountRoutes(app, routes);
      return app;
    },
  }
);

/**
 * Per-operation type carrier. The generics are the whole point; at runtime this
 * hands the handler straight back, so an app without the plugin still serves —
 * it just has no document.
 */
export function op<TSpec>(
  handler: unknown,
  _options?: OperationOptions
): typeof handler {
  return handler;
}

/**
 * The single merged OpenAPI document for every route declared in the program.
 *
 * Compile-time only: the plugin harvests every route across the program and
 * replaces this call with the finished document. There is deliberately no
 * runtime that could answer it, since that would mean shipping wiz's
 * bookkeeping in your bundle and reading a document assembled by import-order
 * side effects.
 */
export function openapiDocument(): Record<string, unknown> {
  throw new PluginInactiveError("openapiDocument");
}
export function encodeProto<T>(_val: T, _buf: Uint8Array, _offset = 0): number {
  throw new PluginInactiveError("encodeProto");
}

export function decodeProto<T>(_buf: Uint8Array, _offset = 0): T {
  throw new PluginInactiveError("decodeProto");
}
export function protobufSchema<TTypes extends unknown[]>(
  _options?: { indent?: string }
): string {
  throw new PluginInactiveError("protobufSchema");
}
export function encodeAvro<T>(_val: T, _buf: Uint8Array, _offset = 0): number {
  throw new PluginInactiveError("encodeAvro");
}

export function decodeAvro<T>(_buf: Uint8Array, _offset = 0): T {
  throw new PluginInactiveError("decodeAvro");
}

export function avroSchema<TTypes extends unknown[]>(
  _options?: { indent?: string }
): string {
  throw new PluginInactiveError("avroSchema");
}

/**
 * Encodes rows as an Arrow IPC stream.
 *
 * Arrow is columnar, so a value is a table of records rather than one record:
 * the rows are transposed into a buffer per column, framed as a schema message
 * and a record batch.
 */
export function encodeArrow<T>(_rows: T[], _buf: Uint8Array, _offset = 0): number {
  throw new PluginInactiveError("encodeArrow");
}

export function decodeArrow<T>(_buf: Uint8Array, _offset = 0): T[] {
  throw new PluginInactiveError("decodeArrow");
}

export function arrowSchema<TTypes extends unknown[]>(
  _options?: { indent?: string }
): string {
  throw new PluginInactiveError("arrowSchema");
}

// `wizPlugin` is deliberately NOT re-exported here: it pulls in the TypeScript
// compiler, and importing the runtime must never drag that into an app bundle.
// Build tooling imports it from "wiz/plugin". The logger contract is dependency
// free, so it stays available to both sides.
export {
  consoleLogger,
  defaultLogger,
  silentLogger,
  type WizLogger,
} from "./logger.ts";
export * from "./types.ts";
