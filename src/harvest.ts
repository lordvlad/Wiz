import ts from "typescript";
import { mergeDocuments, type OpenApiDocument } from "./document.ts";
import { extractTypeIR } from "./extractors/typescript.ts";
import { generateOpenApiSchemaCode } from "./generators/openapi.ts";
import {
  type HttpMethodName,
  type ParameterIR,
  type ServiceMethodIR,
  type ServiceMethodRequestIR,
  type ServiceMethodResponseIR,
} from "./ir/service.ts";
import { silentLogger, type WizLogger } from "./logger.ts";
import { flattenObjectProperties, type TypeIR } from "./types.ts";

/**
 * Reading routes out of source: `op<{ … }>` descriptors, Bun and Hono route
 * maps, and the merged document `openapiDocument()` is replaced with.
 *
 * Everything here is a read. Nothing is registered, nothing is rewritten, and
 * the routes value the user wrote reaches the router untouched — the plugin
 * calls in, gets `ServiceMethodIR`s or a finished document back, and does the
 * rewriting itself.
 */

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

export const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  skipLibCheck: true,
};

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

function isAbsent(ir: TypeIR | undefined): boolean {
  if (!ir) return true;
  return (
    ir.kind === "primitive" &&
    (ir.type === "never" || ir.type === "void" || ir.type === "undefined")
  );
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
 * Reads the `[openapiSchema.get<...>("/users"), ...]` argument.
 * Only inline array literals of direct builder calls are folded; anything else
 * is left alone so the runtime stub reports it loudly.
 *
 * This builder is positional by design (path, query, response, body); the
 * route-map form uses the named `op<{ … }>` slots instead.
 */
export function collectOperations(
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

interface OperationSpec {
  request: ServiceMethodRequestIR;
  responses: ServiceMethodResponseIR[];
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

/**
 * Harvests path descriptors from a Bun `routes` object literal. Purely a read:
 * the routes value is handed back to `Bun.serve` untouched.
 *
 * Recognised values per Bun's `Routes` type:
 *   "/p": op<S>(handler)                 -> single operation, defaults to GET
 *   "/p": { GET: op<S>(h), POST: … }     -> one operation per method key
 *   "/p": new Response(…) | handler      -> documented as a bare GET 200
 */
export function collectRouteOperations(
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
export function readOpenApiVersion(call: ts.CallExpression): "3.0" | "3.1" {
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

/**
 * Forgets the document harvested for one entry.
 *
 * The cache is keyed by path and the source behind it is read from disk, so a
 * caller about to transform that path again has to drop the previous answer
 * first: the routes it described may already be gone.
 */
export function invalidateHarvest(entryPath: string): void {
  harvestCache.delete(entryPath);
}

export function harvestDocument(
  entryPath: string,
  logger: WizLogger
): OpenApiDocument {
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
