import type { BunPlugin } from "bun";
import ts from "typescript";
import { mergeDocuments, type OpenApiDocument } from "./document.ts";
import { generateOpenApiSchemaCode } from "./generators/openapi.ts";
import { extractTypeIR } from "./extractors/typescript.ts";
import {
  type HttpMethodName,
  type ParameterIR,
  type ServiceMethodIR,
  type ServiceMethodRequestIR,
  type ServiceMethodResponseIR,
} from "./ir/service.ts";
import { defaultLogger, silentLogger, type WizLogger } from "./logger.ts";
import { getRegisteredType, registerType } from "./registry.ts";
import {
  generateVirtualModuleCode,
  type VirtualModuleOptions,
} from "./generators/virtualGenerator.ts";
import { setupVirtualModuleLifecycle } from "./virtualPlugin.ts";
import {
  flattenObjectProperties,
  getTypeKey,
  type TypeIR,
} from "./types.ts";

const HELPER_FUNCTIONS = new Set([
  "openapiDocument",
  "keysOf",
  "requiredKeysOf",
  "optionalKeysOf",
  "schema",
  "validate",
  "is",
  "openapiSchema",
  "encodeProto",
  "decodeProto",
  "protobufSchema",
  "encodeAvro",
  "decodeAvro",
  "avroSchema",
  "encodeArrow",
  "decodeArrow",
  "arrowSchema",
]);

const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "trace",
]);

/** `/users/:id` (Express style) -> `/users/{id}` (OpenAPI style). */
function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_$]+)/g, "{$1}");
}

/**
 * Flattens one `op<{ path: … }>` slot object into a flat parameter list.
 * The IR carries parameters individually so a component name has somewhere to
 * live; this is the only place TypeScript slot objects are taken apart.
 */
function slotParameters(
  ir: TypeIR | undefined,
  location: ParameterIR["in"]
): ParameterIR[] {
  if (!ir) return [];
  return flattenObjectProperties(ir).map((property) => {
    const parameter: ParameterIR = {
      name: property.name,
      in: location,
      required: location === "path" ? true : !property.optional,
      type: property.type,
    };
    if (property.description) parameter.description = property.description;
    if (property.deprecated) parameter.deprecated = true;
    return parameter;
  });
}

/** Builds an HTTP service method from its parts. */
function httpMethodIR(
  method: string,
  path: string,
  request: ServiceMethodRequestIR,
  responses: ServiceMethodResponseIR[],
  overrides?: string
): ServiceMethodIR {
  return {
    kind: "serviceMethod",
    protocol: "http",
    address: {
      protocol: "http",
      method: method.toUpperCase() as HttpMethodName,
      path: toOpenApiPath(path),
    },
    request,
    responses,
    overrides,
  };
}

/**
 * Reads the `[openapiSchema.get<...>("/users"), ...]` argument.
 * Only inline array literals of direct builder calls are folded; anything else
 * is left alone so the runtime stub reports it loudly.
 *
 * This builder is positional by design (path, query, response, body); the
 * route-map form uses the named `op<{ … }>` slots instead.
 */
function collectOperations(
  arg: ts.Expression | undefined,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile
): ServiceMethodIR[] {
  if (!arg || !ts.isArrayLiteralExpression(arg)) return [];

  const methods: ServiceMethodIR[] = [];
  for (const element of arg.elements) {
    if (!ts.isCallExpression(element)) continue;
    if (!ts.isPropertyAccessExpression(element.expression)) continue;

    const httpMethod = element.expression.name.text.toLowerCase();
    if (!HTTP_METHODS.has(httpMethod)) continue;

    const pathArg = element.arguments[0];
    if (!pathArg || !ts.isStringLiteralLike(pathArg)) continue;

    const optionsArg = element.arguments[1];
    const [pathParams, queryParams, response, requestBody] = (
      element.typeArguments ?? []
    ).map((typeNode) =>
      extractTypeIR(checker.getTypeFromTypeNode(typeNode), checker)
    );

    const request: ServiceMethodRequestIR = { protocol: "http" };
    const parameters = [
      ...slotParameters(
        pathParams && !isAbsent(pathParams) ? pathParams : undefined,
        "path"
      ),
      ...slotParameters(
        queryParams && !isAbsent(queryParams) ? queryParams : undefined,
        "query"
      ),
    ];
    if (parameters.length > 0) request.parameters = parameters;
    if (requestBody && !isAbsent(requestBody)) {
      request.body = [{ mimetype: JSON_MIME, content: requestBody }];
    }

    const responses: ServiceMethodResponseIR[] =
      response && !isAbsent(response)
        ? [
            {
              protocol: "http",
              status: 200,
              body: [{ mimetype: JSON_MIME, content: response }],
            },
          ]
        : [{ protocol: "http", status: 204 }];

    methods.push(
      httpMethodIR(
        httpMethod,
        pathArg.text,
        request,
        responses,
        optionsArg ? optionsArg.getText(sourceFile) : undefined
      )
    );
  }
  return methods;
}

const JSON_MIME = "application/json";

/** Slots understood inside an `op<{ … }>()` type argument. */
const SPEC_SLOTS = new Set([
  "path",
  "query",
  "header",
  "cookie",
  "body",
  "response",
  "responses",
  "status",
]);

interface OperationSpec {
  request: ServiceMethodRequestIR;
  responses: ServiceMethodResponseIR[];
}

function isAbsent(ir: TypeIR | undefined): boolean {
  if (!ir) return true;
  return (
    ir.kind === "primitive" &&
    (ir.type === "never" || ir.type === "void" || ir.type === "undefined")
  );
}

/**
 * Reads the single named-member type argument of `op<{ query: Q; … }>()` into
 * the request/response halves of a service method. Named slots beat positional
 * generics: callers omit what they do not use and new slots can be added
 * without shifting anyone's arguments.
 */
function readOperationSpec(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  logger: WizLogger
): OperationSpec {
  const request: ServiceMethodRequestIR = { protocol: "http" };
  const specNode = call.typeArguments?.[0];
  if (!specNode) {
    return { request, responses: [{ protocol: "http", status: 204 }] };
  }

  const specIR = extractTypeIR(checker.getTypeFromTypeNode(specNode), checker);
  const slots = new Map(
    flattenObjectProperties(specIR).map((p) => [p.name, p])
  );

  for (const name of slots.keys()) {
    if (!SPEC_SLOTS.has(name)) {
      warnUndocumentable(
        logger,
        `unknown op slot "${name}"; expected one of ${[...SPEC_SLOTS].join(", ")}`,
        specNode,
        sourceFile
      );
    }
  }

  const slotType = (name: string) => {
    const property = slots.get(name);
    return property && !isAbsent(property.type) ? property.type : undefined;
  };

  const parameters = [
    ...slotParameters(slotType("path"), "path"),
    ...slotParameters(slotType("query"), "query"),
    ...slotParameters(slotType("header"), "header"),
    ...slotParameters(slotType("cookie"), "cookie"),
  ];
  if (parameters.length > 0) request.parameters = parameters;

  const body = slotType("body");
  if (body) {
    request.body = [{ mimetype: JSON_MIME, content: body }];
  }

  // `status: 201` is a numeric literal type, not a payload schema.
  const statusSlot = slots.get("status");
  const status =
    statusSlot?.type.kind === "literal" &&
    typeof statusSlot.type.value === "number"
      ? statusSlot.type.value
      : undefined;

  const responses: ServiceMethodResponseIR[] = [];

  // `response` is the shorthand for the success case.
  const response = slotType("response");
  if (response) {
    responses.push({
      protocol: "http",
      status: status ?? 200,
      body: [{ mimetype: JSON_MIME, content: response }],
    });
  }

  // `responses: { 404: NotFound }` covers everything else. A method really does
  // have several responses at once, so these accumulate rather than replace.
  const responsesSlot = slots.get("responses");
  if (responsesSlot) {
    for (const entry of flattenObjectProperties(responsesSlot.type)) {
      const status =
        entry.name === "default" ? ("default" as const) : Number(entry.name);
      if (status !== "default" && !Number.isInteger(status)) {
        warnUndocumentable(
          logger,
          `response key "${entry.name}" is not a status code or "default"`,
          specNode,
          sourceFile
        );
        continue;
      }
      responses.push({
        protocol: "http",
        status,
        // The key's own JSDoc becomes the response description.
        ...(entry.description ? { description: entry.description } : {}),
        ...(isAbsent(entry.type)
          ? {}
          : { body: [{ mimetype: JSON_MIME, content: entry.type }] }),
      });
    }
  }

  if (responses.length === 0) {
    responses.push({ protocol: "http", status: status ?? 204 });
  }

  return { request, responses };
}

/** Unwraps `op<…>(handler)` / `openapiSchema.op<…>(handler)`, else undefined. */
function asOperationCall(node: ts.Expression): ts.CallExpression | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const callee = node.expression;
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : undefined;
  return name === "op" ? node : undefined;
}

/** `file:line:col` for a node, so a warning points at real source. */
function locationOf(node: ts.Node, sourceFile: ts.SourceFile): string {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile)
  );
  return `${sourceFile.fileName}:${line + 1}:${character + 1}`;
}

/**
 * Reports a route that exists at runtime but cannot reach the document.
 * Silence is the wrong failure mode here: the server still works, so a missing
 * path would otherwise only surface as a gap in generated clients.
 */
function warnUndocumentable(
  logger: WizLogger,
  message: string,
  node: ts.Node,
  sourceFile: ts.SourceFile
): void {
  logger.warn(`[wiz] ${message}\n  at ${locationOf(node, sourceFile)}`);
}

/**
 * Harvests path descriptors from a Bun `routes` object literal. Purely a read:
 * the routes value is handed back to `Bun.serve` untouched.
 *
 * Recognised values per Bun's `Routes` type:
 *   "/p": op<S>(handler)                 -> single operation, defaults to GET
 *   "/p": { GET: op<S>(h), POST: … }     -> one operation per method key
 *   "/p": new Response(…) | handler      -> documented as a bare GET 200
 */
function collectRouteOperations(
  arg: ts.Expression | undefined,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  logger: WizLogger
): ServiceMethodIR[] {
  if (!arg) return [];
  if (!ts.isObjectLiteralExpression(arg)) {
    warnUndocumentable(
      logger,
      "routes must be an inline object literal to be documented; " +
        "this value is only known at runtime, so no paths were collected",
      arg,
      sourceFile
    );
    return [];
  }

  const methods: ServiceMethodIR[] = [];

  const push = (
    path: string,
    httpMethod: string,
    value: ts.Expression | undefined
  ) => {
    const call = value ? asOperationCall(value) : undefined;
    const spec = call
      ? readOperationSpec(call, checker, sourceFile, logger)
      : {
          request: { protocol: "http" } as ServiceMethodRequestIR,
          responses: [
            { protocol: "http", status: 204 } as ServiceMethodResponseIR,
          ],
        };
    const method = httpMethodIR(
      httpMethod,
      path,
      spec.request,
      spec.responses,
      call?.arguments[1]?.getText(sourceFile)
    );
    logger.trace(
      `[wiz] documented ${method.address.method} ${method.address.path}`
    );
    methods.push(method);
  };

  for (const property of arg.properties) {
    if (ts.isSpreadAssignment(property)) {
      warnUndocumentable(
        logger,
        "spread routes are resolved at runtime and cannot be documented; " +
          "declare these paths inline to include them",
        property,
        sourceFile
      );
      continue;
    }

    if (!ts.isPropertyAssignment(property)) {
      warnUndocumentable(
        logger,
        "only `\"/path\": value` entries can be documented",
        property,
        sourceFile
      );
      continue;
    }

    if (!ts.isStringLiteralLike(property.name)) {
      warnUndocumentable(
        logger,
        "route keys must be string literals to be documented; " +
          "a computed key has no statically known path",
        property.name,
        sourceFile
      );
      continue;
    }

    const path = property.name.text;
    const value = property.initializer;

    // Method map: every key that names an HTTP verb becomes its own operation.
    if (ts.isObjectLiteralExpression(value)) {
      for (const methodProperty of value.properties) {
        if (!ts.isPropertyAssignment(methodProperty)) {
          warnUndocumentable(
            logger,
            `route "${path}" has a method entry that cannot be documented`,
            methodProperty,
            sourceFile
          );
          continue;
        }
        const methodName = ts.isIdentifier(methodProperty.name)
          ? methodProperty.name.text
          : ts.isStringLiteralLike(methodProperty.name)
            ? methodProperty.name.text
            : undefined;
        if (!methodName || !HTTP_METHODS.has(methodName.toLowerCase())) {
          warnUndocumentable(
            logger,
            `route "${path}" has an entry that is not an HTTP method`,
            methodProperty.name,
            sourceFile
          );
          continue;
        }
        push(path, methodName.toLowerCase(), methodProperty.initializer);
      }
      continue;
    }

    // A referenced value that is not callable is almost certainly a method map
    // held in a variable; documenting it as a bare GET would be a lie.
    if (ts.isIdentifier(value) || ts.isPropertyAccessExpression(value)) {
      const valueType = checker.getTypeAtLocation(value);
      const callable = valueType.getCallSignatures().length > 0;
      const isResponse = valueType.symbol?.name === "Response";
      if (!callable && !isResponse) {
        warnUndocumentable(
          logger,
          `route "${path}" refers to a value that cannot be introspected; ` +
            "inline the handler or method map to document it",
          value,
          sourceFile
        );
        continue;
      }
    }

    push(path, "get", value);
  }

  return methods;
}
/** Reads `"3.0"` / `3.0` from the second type argument; defaults to 3.1. */
function readOpenApiVersion(call: ts.CallExpression): "3.0" | "3.1" {
  const versionNode = call.typeArguments?.[1];
  if (versionNode && ts.isLiteralTypeNode(versionNode)) {
    const text = versionNode.literal.getText().replace(/['"]/g, "");
    if (text === "3.0" || text === "3") return "3.0";
  }
  return "3.1";
}

/**
 * Reads the dialect from the base document's own `openapi` field. That field
 * has to be declared anyway, so it beats a type parameter that would collide
 * with inference of the routes map.
 */
function readVersionFromBase(base: ts.Expression | undefined): "3.0" | "3.1" {
  if (!base || !ts.isObjectLiteralExpression(base)) return "3.1";
  for (const property of base.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key = ts.isIdentifier(property.name)
      ? property.name.text
      : ts.isStringLiteralLike(property.name)
        ? property.name.text
        : undefined;
    if (key !== "openapi") continue;
    if (ts.isStringLiteralLike(property.initializer)) {
      return property.initializer.text.startsWith("3.0") ? "3.0" : "3.1";
    }
  }
  return "3.1";
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  skipLibCheck: true,
};

/**
 * Declaration files are immutable for the lifetime of a build, so their parsed
 * `SourceFile` objects are shared by every per-file program the plugin creates.
 */
const declarationFileCache = new Map<string, ts.SourceFile | undefined>();

/**
 * The program built for the previously transformed file, handed to TypeScript
 * as `oldProgram` so it can reuse the binding of everything that did not
 * change. Each file is its own root, so reuse is partial — unlike the test
 * helper, which compiles every fixture under one entry name and gains far
 * more — but a build transforms many files and the saving compounds.
 */
let lastProgram: ts.Program | undefined;

/**
 * The value of a literal expression, or undefined if it is not one.
 *
 * The base document handed to `bunRoutes` has to be known at build time now
 * that the merge happens there. Anything computed at runtime cannot be, and is
 * reported rather than guessed at.
 */
function staticValue(node: ts.Expression | undefined): unknown {
  if (!node) return undefined;

  if (ts.isParenthesizedExpression(node)) return staticValue(node.expression);
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return staticValue(node.expression);
  }
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    const inner = staticValue(node.operand);
    return typeof inner === "number" ? -inner : undefined;
  }

  if (ts.isArrayLiteralExpression(node)) {
    const items: unknown[] = [];
    for (const element of node.elements) {
      const value = staticValue(element);
      if (value === undefined) return undefined;
      items.push(value);
    }
    return items;
  }

  if (ts.isObjectLiteralExpression(node)) {
    const object: Record<string, unknown> = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) return undefined;
      const key = ts.isIdentifier(property.name)
        ? property.name.text
        : ts.isStringLiteralLike(property.name)
          ? property.name.text
          : undefined;
      if (key === undefined) return undefined;
      const value = staticValue(property.initializer);
      if (value === undefined) return undefined;
      object[key] = value;
    }
    return object;
  }

  return undefined;
}

/**
 * Runs a generated OpenAPI module and returns the document it builds.
 *
 * The generator is reused rather than reimplemented for the build-time path:
 * a second implementation of the same document is exactly the drift this
 * codebase keeps finding. The input is our own generated source, not the
 * user's.
 */
function runGeneratedDocument(
  code: string,
  base: Record<string, unknown>
): OpenApiDocument {
  const factory = new Function(
    `${code.replace(/^export /gm, "")}\nreturn openapiSchema;`
  );
  return factory()(base) as OpenApiDocument;
}

/**
 * Every route reachable from this module, merged into one document.
 *
 * `openapiDocument()` is answered at compile time, and a per-file transform
 * cannot know whether the file it is looking at is the first or the last, so
 * fragments are never accumulated as files happen to load - the answer must
 * not depend on Bun's load order.
 *
 * The scope is the import graph rather than every file in the project, because
 * that is the program being built: a module nobody imports contributes no
 * routes at runtime and should contribute none to the document either.
 */
const harvestCache = new Map<string, OpenApiDocument>();

function harvestDocument(entryPath: string, logger: WizLogger): OpenApiDocument {
  const cached = harvestCache.get(entryPath);
  if (cached) return cached;

  // Rooting the program at the entry makes TypeScript resolve the imports for
  // us, so `getSourceFiles()` is exactly the transitive closure.
  const program = ts.createProgram([entryPath], COMPILER_OPTIONS);
  const checker = program.getTypeChecker();
  const fragments: OpenApiDocument[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (sourceFile.fileName.includes("node_modules")) continue;

    const visit = (node: ts.Node): void => {
      const adapter = routeAdapterFor(node);
      if (adapter) {
        const { base, routes } = adapter;
        // Silent: every route file is transformed in its own right, and the
        // adapter reports these diagnostics there. Repeating them per harvest
        // would just duplicate them.
        const methods = collectRouteOperations(routes, checker, sourceFile, silentLogger);
        if (methods.length > 0) {
          const baseValue = base ? staticValue(base) : {};
          if (baseValue === undefined) {
            warnUndocumentable(
              logger,
              "the base document is computed at runtime, so it cannot be merged " +
                "into openapiDocument(); declare it as a literal",
              base!,
              sourceFile
            );
          }
          const code = generateOpenApiSchemaCode([], readVersionFromBase(base), {
            kind: "service",
            methods,
          });
          fragments.push(
            runGeneratedDocument(
              code,
              (baseValue as Record<string, unknown>) ?? {}
            )
          );
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  if (fragments.length === 0) {
    logger.warn(
      `[wiz] openapiDocument() found no routes reachable from ${entryPath}; ` +
        `a module declaring routes has to be imported to be documented`
    );
  }

  const document = mergeDocuments(fragments);
  harvestCache.set(entryPath, document);
  return document;
}

/** `openapiSchema.bunRoutes(base, routes)` / `.honoRoutes(app, base, routes)`. */
function routeAdapterFor(node: ts.Node):
  | { call: ts.CallExpression; base: ts.Expression | undefined; routes: ts.Expression }
  | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  if (!ts.isPropertyAccessExpression(node.expression)) return undefined;

  const name = node.expression.name.text;
  const offset = name === "bunRoutes" ? 0 : name === "honoRoutes" ? 1 : undefined;
  if (offset === undefined) return undefined;

  const routes = node.arguments[offset + 1];
  if (!routes) return undefined;
  return { call: node, base: node.arguments[offset], routes };
}

/** A plain value as an AST literal, so the document lands inline in the output. */
function jsonToExpression(
  factory: ts.NodeFactory,
  value: unknown
): ts.Expression {
  if (value === null) return factory.createNull();
  if (typeof value === "string") return factory.createStringLiteral(value);
  if (typeof value === "boolean") return value ? factory.createTrue() : factory.createFalse();
  if (typeof value === "number") {
    return value < 0
      ? factory.createPrefixUnaryExpression(
          ts.SyntaxKind.MinusToken,
          factory.createNumericLiteral(-value)
        )
      : factory.createNumericLiteral(value);
  }
  if (Array.isArray(value)) {
    return factory.createArrayLiteralExpression(
      value.map((item) => jsonToExpression(factory, item))
    );
  }
  if (typeof value === "object") {
    return factory.createObjectLiteralExpression(
      Object.entries(value as Record<string, unknown>).map(([key, item]) =>
        factory.createPropertyAssignment(
          factory.createStringLiteral(key),
          jsonToExpression(factory, item)
        )
      ),
      true
    );
  }
  return factory.createIdentifier("undefined");
}

export interface WizPluginOptions {
  /**
   * Where diagnostics go. Defaults to {@link defaultLogger}, which forwards
   * `info`/`warn`/`error` to `console` and drops `trace`. Pass
   * `consoleLogger` for verbose builds, `silentLogger` to mute the plugin, or
   * any object with the four levels to route them somewhere else.
   */
  logger?: WizLogger;
}


/**
 * Export name to local alias prefix for a generated module.
 *
 * Exported because `eject` inlines those modules and has to bind the same
 * names the rewritten code refers to; a second copy of this table would be one
 * more pair of things that can drift apart.
 */
export const VIRTUAL_EXPORTS: Record<string, string> = {
  keys: "__wiz_keys",
  requiredKeys: "__wiz_reqKeys",
  optionalKeys: "__wiz_optKeys",
  schema_draft2020: "__wiz_schema",
  schema_draft07: "__wiz_schema07",
  validate: "__wiz_validate",
  is: "__wiz_is",
  openapiSchema: "__wiz_openapiSchema",
  encodeProto: "__wiz_encodeProto",
  decodeProto: "__wiz_decodeProto",
  protobufSchema: "__wiz_protobufSchema",
  encodeAvro: "__wiz_encodeAvro",
  decodeAvro: "__wiz_decodeAvro",
  avroSchema: "__wiz_avroSchema",
  encodeArrow: "__wiz_encodeArrow",
  decodeArrow: "__wiz_decodeArrow",
  arrowSchema: "__wiz_arrowSchema",
};

export function localAlias(exportName: string, hash: string): string {
  return `${VIRTUAL_EXPORTS[exportName]}_${hash}`;
}
/** One generated module, and the names the rewritten code takes from it. */
export interface GeneratedModule {
  code: string;
  /**
   * Export names actually used, in the order they were requested. An inlining
   * caller needs these: the module defines far more than any one file uses.
   */
  exports: string[];
  hash: string;
}

/** What a transform produced, and the generated modules it now depends on. */
export interface TransformResult {
  /** The rewritten source. */
  code: string;
  /** Generated modules by import specifier, exactly as `code` refers to them. */
  modules: Map<string, GeneratedModule>;
  /** False when the file had nothing for wiz to do. */
  changed: boolean;
}

export interface TransformOptions {
  path: string;
  contents: string;
  logger?: WizLogger;
  /**
   * Refuse anything that cannot be answered from this file alone.
   *
   * `openapiDocument()` reads every route reachable from the module, so a
   * single-file eject cannot honour it; better to say so than to emit a
   * document silently missing most of the program.
   */
  isolated?: boolean;
  /**
   * Leave the generated modules out of the output's imports.
   *
   * The caller is then responsible for putting those definitions in scope,
   * which is how a single-file eject produces one self-contained file.
   */
  inline?: boolean;
}

/**
 * Rewrites one module's wiz callsites, and reports the modules it now needs.
 *
 * Shared by the Bun plugin and `wiz eject`, so what a build runs and what an
 * eject writes cannot diverge.
 */
export function transformSource(options: TransformOptions): TransformResult {
  const { path, contents, isolated = false, inline = false } = options;
  const logger = options.logger ?? defaultLogger;
  const unchanged = (code: string): TransformResult => ({
    code,
    modules: new Map(),
    changed: false,
  });

  // A second transform of one path means the build is running again over it, so
  // the document harvested for it last time describes source that may already
  // be gone. The entry is dropped before the transform can read it; what
  // survives is reuse within a single transform, where several
  // `openapiDocument()` callsites share one harvest.
  harvestCache.delete(path);

  if (
    contents.includes("@wiz-ignore") ||
    !Array.from(HELPER_FUNCTIONS).some((fn) => contents.includes(fn))
  ) {
    return unchanged(contents);
  }
  // Setup TS Compiler Program and Checker for full type checking
  const host = ts.createCompilerHost(COMPILER_OPTIONS);
  const originalReadFile = host.readFile.bind(host);
  const originalGetSourceFile = host.getSourceFile.bind(host);

  host.readFile = (fileName: string) =>
    fileName === path ? contents : originalReadFile(fileName);

  // A program is built per transformed file; without this the whole of
  // lib.d.ts is re-parsed every time, which dominates build time.
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    if (!fileName.endsWith(".d.ts")) {
      return originalGetSourceFile(
        fileName,
        languageVersion,
        onError,
        shouldCreate
      );
    }
    if (!declarationFileCache.has(fileName)) {
      declarationFileCache.set(
        fileName,
        originalGetSourceFile(fileName, languageVersion, onError, shouldCreate)
      );
    }
    return declarationFileCache.get(fileName);
  };

  const program = ts.createProgram(
    [path],
    COMPILER_OPTIONS,
    host,
    lastProgram
  );
  lastProgram = program;
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(path);

  if (!sourceFile) {
    return unchanged(contents);
  }

  const virtualImports = new Map<string, Set<string>>(); // hash -> set of export names needed
  let modified = false;

  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    const visitor: ts.Visitor = (node: ts.Node): ts.Node => {
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        let fnName: string | undefined;

        if (ts.isIdentifier(expression)) {
          fnName = expression.text;
        } else if (ts.isPropertyAccessExpression(expression)) {
          fnName = expression.name.text;
        }

        // `openapiDocument()` is answered here, from the whole program,
        // so no fragment registry survives into the bundle.
        if (fnName === "openapiDocument" && node.arguments.length === 0) {
          if (isolated) {
            throw new Error(
              `[wiz] ${path} calls openapiDocument(), which is built from every ` +
                `route reachable from the module. That needs the whole program, ` +
                `so eject it as a project rather than a single file.`
            );
          }
          modified = true;
          return jsonToExpression(
            context.factory,
            harvestDocument(path, logger)
          );
        }

        // `op(handler, options)` is a compile-time carrier; the handler is
        // the only part with runtime meaning.
        if (fnName === "op") {
          const handler = node.arguments[0];
          if (handler) {
            modified = true;
            return ts.visitNode(handler, visitor) as ts.Expression;
          }
        }
        // `bunRoutes(base, routes)` / `honoRoutes(app, base, routes)` are
        // declarations, not transformations: harvest descriptors and let
        // the original value through untouched.
        const adapter =
          fnName === "bunRoutes"
            ? { base: 0, routes: 1 }
            : fnName === "honoRoutes"
              ? { base: 1, routes: 2 }
              : undefined;

        if (adapter && ts.isPropertyAccessExpression(expression)) {
          const routesArg = node.arguments[adapter.routes];
          if (!routesArg) return ts.visitEachChild(node, visitor, context);

          // Descriptors reach the document through `harvestDocument`,
          // straight from the program, so nothing is registered here.
          // This pass runs for its diagnostics alone: a route that cannot
          // be documented is reported against the file declaring it,
          // whether or not anything asks for the document.
          collectRouteOperations(routesArg, checker, sourceFile, logger);
          modified = true;

          // Bun: the call collapses to the routes literal, which Bun.serve
          // consumes directly. Hono: the call must survive, because it is
          // what mounts the handlers onto the app.
          return fnName === "bunRoutes"
            ? (ts.visitNode(routesArg, visitor) as ts.Expression)
            : (ts.visitEachChild(node, visitor, context) as ts.Expression);
        }

        if (fnName && HELPER_FUNCTIONS.has(fnName)) {
          // Determine generic type argument T
          let typeArgNode = node.typeArguments?.[0];
          let tsType: ts.Type | undefined;

          if (typeArgNode) {
            tsType = checker.getTypeFromTypeNode(typeArgNode);
          } else if (node.arguments.length > 0) {
            // Fallback: infer from first argument if no generic provided (e.g., validate(arg))
            tsType = checker.getTypeAtLocation(node.arguments[0]!);
          }

          if (tsType) {
            const ir = extractTypeIR(tsType, checker);
            const hash = getTypeKey(tsType, checker, ir);

            /**
             * Records an export the bare type provides.
             *
             * Registration is lazy: a callsite that only wants a payload
             * module (`openapiSchema`, `protobufSchema`, …) must not also
             * emit an empty one for the type it was derived from.
             */
            const wantExport = (name: string): void => {
              registerType(hash, ir);
              if (!virtualImports.has(hash)) virtualImports.set(hash, new Set());
              virtualImports.get(hash)!.add(name);
            };

            /**
             * `f<[A, B]>()` and `f<A>()` alike: the named types a schema
             * payload carries, in declaration order.
             */
            const namedTypeArgs = (): Array<{ name: string; ir: TypeIR }> => {
              const args = checker.isTupleType(tsType!)
                ? checker.getTypeArguments(tsType as ts.TypeReference)
                : [tsType!];
              return args.map((elemType, index) => {
                const elemIR = extractTypeIR(elemType, checker);
                const symbol = elemType.aliasSymbol ?? elemType.symbol;
                return {
                  name:
                    symbol && !symbol.name.startsWith("__")
                      ? symbol.name
                      : (elemIR.name ?? `Schema_${index + 1}`),
                  ir: elemIR,
                };
              });
            };

            /**
             * Registers a module whose content depends on a generator payload
             * and returns its key. The key differs from the bare type hash,
             * because the payload changes the emitted code.
             */
            const registerPayload = (
              exportName: string,
              payload: VirtualModuleOptions
            ): string => {
              const { key } = registerType(hash, ir, payload);
              if (!virtualImports.has(key)) virtualImports.set(key, new Set());
              virtualImports.get(key)!.add(exportName);
              return key;
            };

            modified = true;

            switch (fnName) {
              case "keysOf": {
                wantExport("keys");
                return context.factory.createIdentifier(`__wiz_keys_${hash}`);
              }
              case "requiredKeysOf": {
                wantExport("requiredKeys");
                return context.factory.createIdentifier(`__wiz_reqKeys_${hash}`);
              }
              case "optionalKeysOf": {
                wantExport("optionalKeys");
                return context.factory.createIdentifier(`__wiz_optKeys_${hash}`);
              }
              case "schema": {
                // Check version parameter (type arg or value arg)
                let isDraft07 = false;
                const versionTypeArg = node.typeArguments?.[1];
                if (versionTypeArg && ts.isLiteralTypeNode(versionTypeArg)) {
                  if (versionTypeArg.literal.getText() === '"draft-07"' || versionTypeArg.literal.getText() === "'draft-07'") {
                    isDraft07 = true;
                  }
                } else if (node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0]!)) {
                  if (node.arguments[0]!.text === "draft-07") {
                    isDraft07 = true;
                  }
                }

                if (isDraft07) {
                  wantExport("schema_draft07");
                  return context.factory.createIdentifier(`__wiz_schema07_${hash}`);
                } else {
                  wantExport("schema_draft2020");
                  return context.factory.createIdentifier(`__wiz_schema_${hash}`);
                }
              }
              case "validate": {
                wantExport("validate");
                const visitedArgs = node.arguments.map((arg) => ts.visitNode(arg, visitor) as ts.Expression);
                return context.factory.createCallExpression(
                  context.factory.createIdentifier(`__wiz_validate_${hash}`),
                  undefined,
                  visitedArgs
                );
              }
              case "is": {
                wantExport("is");
                const visitedArgs = node.arguments.map((arg) => ts.visitNode(arg, visitor) as ts.Expression);
                return context.factory.createCallExpression(
                  context.factory.createIdentifier(`__wiz_is_${hash}`),
                  undefined,
                  visitedArgs
                );
              }
              case "openapiSchema": {
                const openApiVersion = readOpenApiVersion(node);

                const openApiTypes: Array<{ name: string; ir: TypeIR }> = [];
                let typeArgs: readonly ts.Type[] = [];
                if (checker.isTupleType(tsType)) {
                  typeArgs = checker.getTypeArguments(tsType as ts.TypeReference);
                } else {
                  typeArgs = [tsType];
                }

                for (const elemType of typeArgs) {
                  const elemIR = extractTypeIR(elemType, checker);
                  const sym = elemType.aliasSymbol ?? elemType.symbol;
                  const name = sym && !sym.name.startsWith("__") ? sym.name : (elemIR.name ?? `Schema_${openApiTypes.length + 1}`);
                  openApiTypes.push({ name, ir: elemIR });
                }

                const serviceMethods = collectOperations(
                  node.arguments[1],
                  checker,
                  sourceFile
                );

                const key = registerPayload("openapiSchema", {
                  openApiTypes,
                  openApiVersion,
                  service: { kind: "service", methods: serviceMethods },
                });

                // Operations are compile-time only: they are folded into
                // the virtual module, so only the base document survives.
                const baseArg = node.arguments[0]
                  ? (ts.visitNode(node.arguments[0], visitor) as ts.Expression)
                  : undefined;
                return context.factory.createCallExpression(
                  context.factory.createIdentifier(`__wiz_openapiSchema_${key}`),
                  undefined,
                  baseArg ? [baseArg] : []
                );
              }
              case "encodeProto": {
                wantExport("encodeProto");
                const visitedArgs = node.arguments.map((arg) => ts.visitNode(arg, visitor) as ts.Expression);
                return context.factory.createCallExpression(
                  context.factory.createIdentifier(`__wiz_encodeProto_${hash}`),
                  undefined,
                  visitedArgs
                );
              }
              case "decodeProto": {
                wantExport("decodeProto");
                const visitedArgs = node.arguments.map((arg) => ts.visitNode(arg, visitor) as ts.Expression);
                return context.factory.createCallExpression(
                  context.factory.createIdentifier(`__wiz_decodeProto_${hash}`),
                  undefined,
                  visitedArgs
                );
              }
              case "protobufSchema": {
                const key = registerPayload("protobufSchema", {
                  protobufSchemaTypes: namedTypeArgs(),
                });
                const visitedArgs = node.arguments.map((arg) => ts.visitNode(arg, visitor) as ts.Expression);
                return context.factory.createCallExpression(
                  context.factory.createIdentifier(`__wiz_protobufSchema_${key}`),
                  undefined,
                  visitedArgs
                );
              }
              case "encodeAvro": {
                wantExport("encodeAvro");
                const visitedArgs = node.arguments.map((arg) => ts.visitNode(arg, visitor) as ts.Expression);
                return context.factory.createCallExpression(
                  context.factory.createIdentifier(`__wiz_encodeAvro_${hash}`),
                  undefined,
                  visitedArgs
                );
              }
              case "decodeAvro": {
                wantExport("decodeAvro");
                const visitedArgs = node.arguments.map((arg) => ts.visitNode(arg, visitor) as ts.Expression);
                return context.factory.createCallExpression(
                  context.factory.createIdentifier(`__wiz_decodeAvro_${hash}`),
                  undefined,
                  visitedArgs
                );
              }
              case "avroSchema": {
                const key = registerPayload("avroSchema", {
                  avroSchemaTypes: namedTypeArgs(),
                });
                const visitedArgs = node.arguments.map((arg) => ts.visitNode(arg, visitor) as ts.Expression);
                return context.factory.createCallExpression(
                  context.factory.createIdentifier(`__wiz_avroSchema_${key}`),
                  undefined,
                  visitedArgs
                );
              }
              case "encodeArrow":
              case "decodeArrow": {
                // Arrow codegen is opt-in, because building the schema needs
                // apache-arrow; requesting it here is what turns it on.
                const key = registerPayload(fnName, { arrow: true });
                const visitedArgs = node.arguments.map((arg) => ts.visitNode(arg, visitor) as ts.Expression);
                return context.factory.createCallExpression(
                  context.factory.createIdentifier(`__wiz_${fnName}_${key}`),
                  undefined,
                  visitedArgs
                );
              }
              case "arrowSchema": {
                const key = registerPayload("arrowSchema", {
                  arrowSchemaTypes: namedTypeArgs(),
                });
                const visitedArgs = node.arguments.map((arg) => ts.visitNode(arg, visitor) as ts.Expression);
                return context.factory.createCallExpression(
                  context.factory.createIdentifier(`__wiz_arrowSchema_${key}`),
                  undefined,
                  visitedArgs
                );
              }
            }
          }
        }
      }

      return ts.visitEachChild(node, visitor, context);
    };
    return (file) => ts.visitEachChild(file, visitor, context);
  };

  const result = ts.transform(sourceFile, [transformer]);
  const transformedSourceFile = result.transformed[0]!;

  if (!modified) {
    result.dispose();
    return unchanged(contents);
  }

  // One table drives both the imports emitted here and the inlining `eject`
  // does, so the two cannot disagree about what a generated name is called.
  const importStatements: ts.Statement[] = [];
  for (const [hash, exportsSet] of virtualImports.entries()) {
    const specifiers = Object.keys(VIRTUAL_EXPORTS)
      .filter((name) => exportsSet.has(name))
      .map((name) => contextSpecifier(name, localAlias(name, hash)));

    if (specifiers.length > 0) {
      const importDecl = ts.factory.createImportDeclaration(
        undefined,
        ts.factory.createImportClause(
          false,
          undefined,
          ts.factory.createNamedImports(specifiers)
        ),
        ts.factory.createStringLiteral(`./wiz-virtual-${hash}.js`)
      );
      importStatements.push(importDecl);
    }
  }
  const finalSourceFile = ts.factory.updateSourceFile(
    transformedSourceFile,
    // Inlining puts the definitions in scope another way, so importing them
    // here as well would just shadow them.
    inline
      ? [...transformedSourceFile.statements]
      : [...importStatements, ...transformedSourceFile.statements]
  );

  const printer = ts.createPrinter({ removeComments: false });
  const transformedCode = printer.printFile(finalSourceFile);
  result.dispose();

  const modules = new Map<string, GeneratedModule>();
  for (const [hash, exportsSet] of virtualImports) {
    const entry = getRegisteredType(hash);
    if (!entry) continue;
    const exports = [...exportsSet];

    // A module handed to a bundler carries every generator, since other files
    // share it by type key and the bundler drops the rest. Inlined code is read
    // by a person, so it is regenerated with only what this file uses.
    const code = inline
      ? generateVirtualModuleCode(entry.ir, { ...entry.options, only: exports })
      : entry.generatedCode;

    modules.set(`./wiz-virtual-${hash}.js`, { code, exports, hash });
  }

  return { code: transformedCode, modules, changed: true };
}

export function wizPlugin(options: WizPluginOptions = {}): BunPlugin {
  const logger = options.logger ?? defaultLogger;
  return {
    name: "wiz-plugin",
    setup(build) {
      setupVirtualModuleLifecycle(build, logger, ({ path, contents, logger }) =>
        transformSource({ path, contents, logger })
      );
    },
  };
}

function contextSpecifier(propertyName: string, name: string): ts.ImportSpecifier {
  return ts.factory.createImportSpecifier(
    false,
    propertyName === name ? undefined : ts.factory.createIdentifier(propertyName),
    ts.factory.createIdentifier(name)
  );
}
