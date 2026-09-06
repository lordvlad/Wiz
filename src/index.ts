import type { ValidateOptions, ValidationError } from "./types.ts";
export { openRPCHandler, type OpenRpcHandlerOptions, type OpenRpcHandler } from "./server/openrpc.ts";
export {
  openRpcClient,
  httpTransport,
  webSocketTransport,
  tcpTransport,
  type OpenRpcCall,
  type OpenRpcResult,
  type OpenRpcTransport,
  type OpenRpcClientOptions,
  type HttpTransportOptions,
  type WebSocketTransportOptions,
  type TcpTransportOptions,
} from "./transports/openrpc.ts";
export { QueryValidationError } from "./generators/query.ts";


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

/** Options for {@link deepKeysOf}. */
export interface DeepKeysOptions {
  /** How far to walk into nested objects. Clamped to 1–10; defaults to 5. */
  maxDepth?: number;
}

/**
 * Every dot-separated path through `T`, to `options.maxDepth` levels.
 *
 * A leaf contributes its own path; an object deeper than the limit contributes
 * the path that reaches it rather than its members.
 */
export function deepKeysOf<T>(_options?: DeepKeysOptions): string[] {
  throw new PluginInactiveError("deepKeysOf");
}

export function jsonSchema<
  T,
  V extends "draft-2020-12" | "draft-07" = "draft-2020-12"
>(_version?: V): Record<string, unknown> {
  throw new PluginInactiveError("jsonSchema");
}

export function jsonSchemas<
  TTypes extends unknown[] = unknown[],
  V extends "draft-2020-12" | "draft-07" = "draft-2020-12"
>(_version?: V): Record<string, unknown> {
  throw new PluginInactiveError("jsonSchemas");
}

/**
 * Collects every way `arg` fails to match `T`.
 *
 * `options.prune` additionally strips properties `T` does not declare, in
 * place - see {@link ValidateOptions}.
 */
export function validate<T>(
  _arg: unknown,
  _options?: ValidateOptions
): ValidationError[] {
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

/**
 * Narrows `arg` to `T`, throwing when the generated structural check fails.
 *
 * The error is an `Error` named `AssertError` carrying every failure on
 * `errors`, so a caller can report all of them rather than the first.
 */
export function assert<T>(
  _arg: unknown,
  _options?: ValidateOptions
): asserts _arg is T {
  throw new PluginInactiveError("assert");
}
/**
 * Parses a query string, `URLSearchParams`, or raw object into `T`.
 *
 * Coerces declared field values to expected types and validates the result.
 * Throws {@link QueryValidationError} if validation fails.
 */
export function parseQuery<T>(
  _input: unknown,
  _options?: ValidateOptions
): T {
  throw new PluginInactiveError("parseQuery");
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
    options?: Record<string, unknown>
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
  }
);
export function openRPCSchema<TTypes extends unknown[] = unknown[]>(
  _baseSchema?: Record<string, unknown>,
  _options?: Record<string, unknown>
): Record<string, unknown> {
  throw new PluginInactiveError("openRPCSchema");
}
/**
 * AsyncAPI document generator stub.
 */
export function asyncapiSchema<TTypes extends unknown[] = unknown[]>(
  _baseSchema?: Record<string, unknown>,
  _options?: Record<string, unknown>
): Record<string, unknown> {
  throw new PluginInactiveError("asyncapiSchema");
}

/**
 * MCP document generator stub.
 */
export function mcpSchema<TTypes extends unknown[] = unknown[]>(
  _baseSchema?: Record<string, unknown>,
  _options?: Record<string, unknown>
): Record<string, unknown> {
  throw new PluginInactiveError("mcpSchema");
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
export function openapiDocument<TTypes extends unknown[] = unknown[]>(
  _baseSchema?: Record<string, unknown>
): Record<string, unknown> {
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
export function grpcSchema<TTypes extends unknown[] = unknown[]>(
  _options?: { indent?: string }
): string {
  throw new PluginInactiveError("grpcSchema");
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

/**
 * Encodes an object to a JSON string with spec-aligned handling for bigint and date fields.
 */
export function encodeJson<T>(_val: T, _indent?: string | number): string {
  throw new PluginInactiveError("encodeJson");
}

/**
 * Decodes a JSON string to an object with spec-aligned handling for bigint and date fields.
 */
export function decodeJson<T>(_raw: string): T {
  throw new PluginInactiveError("decodeJson");
}
/**
 * Encodes a term into Erlang Text format.
 */
export function encodeErlangText<T>(_val: T, _indent?: string | number): string {
  throw new PluginInactiveError("encodeErlangText");
}

/**
 * Decodes an Erlang Text format string into a term.
 */
export function decodeErlangText<T>(_raw: string): T {
  throw new PluginInactiveError("decodeErlangText");
}

/**
 * Encodes a term into Erlang ETF (External Term Format 131) binary.
 */
export function encodeErlangBinary<T>(_val: T): Uint8Array {
  throw new PluginInactiveError("encodeErlangBinary");
}

/**
 * Decodes an Erlang ETF (External Term Format 131) binary into a term.
 */
export function decodeErlangBinary<T>(_raw: Uint8Array): T {
  throw new PluginInactiveError("decodeErlangBinary");
}

/**
 * Encodes a value into CBOR (RFC 8949) binary.
 */
export function encodeCbor<T>(_val: T): Uint8Array {
  throw new PluginInactiveError("encodeCbor");
}

/**
 * Decodes CBOR (RFC 8949) binary into a value.
 */
export function decodeCbor<T>(_raw: Uint8Array): T {
  throw new PluginInactiveError("decodeCbor");
}

/**
 * The part of a zod schema a caller reaches for first.
 *
 * Declared structurally so wiz never imports zod itself: zod is an optional
 * peer dependency, and a type-only import here would make it a required one
 * for everybody who typechecks against this package. The object that arrives
 * at runtime is a real zod schema built by the caller's own copy, so anything
 * else zod offers is reachable by widening this type at the callsite.
 */
export interface ZodSchemaLike<T> {
  parse(data: unknown): T;
  safeParse(
    data: unknown
  ): { success: true; data: T } | { success: false; error: unknown };
}

/**
 * A zod schema for `T`, built from the same IR the validator and JSON Schema
 * come from.
 *
 * It is a promise because zod is loaded lazily: the generated module imports
 * zod the first time this is awaited, so a program that never asks for a zod
 * schema never loads zod - and never needs it installed.
 */
export function zodSchema<T>(): Promise<ZodSchemaLike<T>> {
  throw new PluginInactiveError("zodSchema");
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
export {
  reactQueryGenerator,
  type ReactQueryOptions,
} from "./generators/reactQuery.ts";
