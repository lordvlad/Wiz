import ts from "typescript";
import { mergeDocuments, type OpenApiDocument } from "./document.ts";
import {
  extractJSDocInfo,
  extractTypeIR,
  type JSDocInfo,
} from "./extractors/typescript.ts";
import { generateOpenApiSchemaCode } from "./generators/openapi.ts";
import {
  type AsyncApiServiceMethodIR,
  type GrpcServiceMethodIR,
  type HttpMethodName,
  type HttpRequestIR,
  type HttpResponseIR,
  type HttpServiceMethodIR,
  type McpServiceMethodIR,
  type McpToolAnnotationsIR,
  type OpenRpcServiceMethodIR,
  type ParameterIR,
  type ServiceMethodIR,
} from "./ir/service.ts";
import { silentLogger, type WizLogger } from "./logger.ts";
import { flattenObjectProperties, isUserNamedType, type TypeIR } from "./types.ts";

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


function toSnakeCase(str: string): string {
  return str
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

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
  request: HttpRequestIR,
  responses: HttpResponseIR[],
  overrides?: string
): HttpServiceMethodIR {
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
): HttpServiceMethodIR[] {
  if (!arg || !ts.isArrayLiteralExpression(arg)) return [];

  const methods: HttpServiceMethodIR[] = [];
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

    const request: HttpRequestIR = { protocol: "http" };
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

    const responses: HttpResponseIR[] =
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
  request: HttpRequestIR;
  responses: HttpResponseIR[];
}

/**
 * Reads the single named-member type argument of `op<{ query: Q; … }>()` into
 * the request/response halves of a service method. Named slots beat positional
 * generics: callers omit what they do not use and new slots can be added
 * without shifting anyone's arguments.
 */

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
): HttpServiceMethodIR[] {
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

  const methods: HttpServiceMethodIR[] = [];

  const push = (
    path: string,
    httpMethod: string,
    value: ts.Expression | undefined
  ) => {
    const request: HttpRequestIR = { protocol: "http" };
    const responses: HttpResponseIR[] = [{ protocol: "http", status: 204 }];
    const method = httpMethodIR(
      httpMethod,
      path,
      request,
      responses,
      undefined
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
      } else if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const fnName = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : undefined;
        if (fnName === "openapiSchema" || fnName === "openapiDocument") {
          const typeNode = node.typeArguments?.[0];
          if (typeNode) {
            const tsType = checker.getTypeFromTypeNode(typeNode);
            let elemTypes: readonly ts.Type[] = [];
            if (checker.isTupleType(tsType)) {
              elemTypes = checker.getTypeArguments(tsType as ts.TypeReference);
            } else {
              elemTypes = [tsType];
            }
            const methods = harvestOpenApiOperationsFromTypeArgs(elemTypes, checker, sourceFile, node, silentLogger);
            if (methods.length > 0) {
              const base = node.arguments[0];
              const baseValue = base ? staticValue(base) : {};
              const openApiTypes: Array<{ name: string; ir: TypeIR }> = [];
              for (const elemType of elemTypes) {
                if (isServiceLikeType(elemType, checker)) continue;
                const elemIR = extractTypeIR(elemType, checker);
                const sym = elemType.aliasSymbol ?? elemType.symbol;
                const name = sym && !sym.name.startsWith("__") ? sym.name : (elemIR.name ?? `Schema_${openApiTypes.length + 1}`);
                openApiTypes.push({ name, ir: elemIR });
              }
              const code = generateOpenApiSchemaCode(openApiTypes, readVersionFromBase(base), {
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
function parseAudience(val: unknown): Array<"user" | "assistant"> | undefined {
  if (Array.isArray(val)) {
    const list = val.filter((v) => v === "user" || v === "assistant") as Array<"user" | "assistant">;
    return list.length > 0 ? list : undefined;
  }
  if (typeof val === "string") {
    const parts = val.split(/[,\s]+/).map((s) => s.trim().toLowerCase());
    const list = parts.filter((v) => v === "user" || v === "assistant") as Array<"user" | "assistant">;
    return list.length > 0 ? list : undefined;
  }
  return undefined;
}

/** One callable member of an interface/class the harvesters read as a method. */
export interface ObjectTypeMethod {
  symbol: ts.Symbol;
  name: string;
  type: ts.Type;
  declaration: ts.Declaration | undefined;
  signatures: readonly ts.Signature[];
}


export function extractMethodsFromObjectType(
  type: ts.Type,
  checker: ts.TypeChecker
): ObjectTypeMethod[] {
  const props = checker.getPropertiesOfType(type);
  const methods: ObjectTypeMethod[] = [];
  for (const prop of props) {
    if (prop.name.startsWith("__")) continue;
    const decl = prop.valueDeclaration ?? prop.declarations?.[0];
    const propType = decl
      ? checker.getTypeOfSymbolAtLocation(prop, decl)
      : checker.getTypeOfSymbol(prop);
    const signatures = propType.getCallSignatures();
    if (signatures.length > 0) {
      methods.push({
        symbol: prop,
        name: prop.name,
        type: propType,
        declaration: decl,
        signatures,
      });
    }
  }
  return methods;
}

/**
 * A type that describes operations rather than a payload: either a callable
 * signature or an interface/class whose members are all callable. Those never
 * belong in `components.schemas`.
 */
export function isServiceLikeType(
  type: ts.Type,
  checker: ts.TypeChecker
): boolean {
  if (type.getCallSignatures().length > 0) return true;
  return extractMethodsFromObjectType(type, checker).length > 0;
}

function unwrapOptionalTypeIR(ir: TypeIR): TypeIR {
  if (ir.kind === "union") {
    const nonNullables = ir.types.filter(
      (t) => !(t.kind === "primitive" && (t.type === "undefined" || t.type === "null" || t.type === "void" || t.type === "never"))
    );
    if (nonNullables.length === 1) {
      return nonNullables[0]!;
    }
  }
  return ir;
}

/**
 * The type a `@response`/`@body` tag names, resolved in the scope of the
 * declaration that carries the tag.
 *
 * A model is normally imported rather than declared beside the service, so the
 * symbol in scope is an *alias* whose first declaration is the `ImportSpecifier`
 * — not the interface. Unwrapping that is what makes `@response 200 Pet` work
 * for a `Pet` from `./model.ts`.
 */
function resolveTypeByName(
  typeName: string,
  checker: ts.TypeChecker,
  sourceFile?: ts.SourceFile,
  sig?: ts.Signature
): TypeIR | undefined {
  if (!typeName || typeName === "never" || typeName === "void" || typeName === "undefined") {
    return undefined;
  }

  // The tag's own scope first: the service interface's file is where the name
  // was written, and the callsite's file may not import it at all.
  const scopes: ts.Node[] = [];
  if (sig?.declaration) scopes.push(sig.declaration as ts.Node);
  if (sourceFile) scopes.push(sourceFile);

  // `Alias` as well as `Type`: an imported model is an alias symbol, and a
  // service normally imports its model rather than declaring it alongside.
  const meaning = ts.SymbolFlags.Type | ts.SymbolFlags.Alias;

  let sym: ts.Symbol | undefined;
  for (const scope of scopes) {
    sym = checker
      .getSymbolsInScope(scope, meaning)
      .find((candidate) => candidate.name === typeName);
    if (sym) break;
  }
  if (!sym && sourceFile) {
    sym =
      (sourceFile as any).locals?.get(typeName) ??
      (sourceFile as any).symbol?.exports?.get(typeName as any);
  }
  if (!sym) return undefined;

  if (sym.flags & ts.SymbolFlags.Alias) {
    const aliased = checker.getAliasedSymbol(sym);
    if (aliased && aliased !== sym) sym = aliased;
  }

  const symDecl = sym.declarations?.[0] ?? sym.valueDeclaration;
  let type: ts.Type | undefined;
  if (
    symDecl &&
    (ts.isInterfaceDeclaration(symDecl) ||
      ts.isClassDeclaration(symDecl) ||
      ts.isTypeAliasDeclaration(symDecl) ||
      ts.isEnumDeclaration(symDecl))
  ) {
    type = checker.getTypeAtLocation(symDecl);
  }
  if (!type || type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
    const declared = checker.getDeclaredTypeOfSymbol(sym);
    if (declared && !(declared.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) {
      type = declared;
    }
  }
  if (!type && symDecl) {
    type = checker.getTypeOfSymbolAtLocation(sym, symDecl);
  }
  if (!type || type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
    return undefined;
  }

  const res = extractTypeIR(type, checker);
  if (!res.name && isUserNamedType(typeName)) res.name = typeName;
  return res;
}

export function harvestOpenApiOperationsFromTypeArgs(
  typeArgs: readonly ts.Type[],
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  logger?: WizLogger
): HttpServiceMethodIR[] {
  const methods: HttpServiceMethodIR[] = [];
  for (const elemType of typeArgs) {
    const signatures = elemType.getCallSignatures();
    if (signatures.length > 0) {
      const sig = signatures[0]!;
      const sym = elemType.aliasSymbol ?? elemType.symbol ?? (sig.declaration as any)?.symbol;
      const jsDoc = sym ? extractJSDocInfo(sym, checker) : undefined;
      const method = parseOpenApiMethodFromSignature(sig, sym, jsDoc, checker, undefined, undefined, undefined, sourceFile);
      if (method) methods.push(method);
    } else {
      const objectMethods = extractMethodsFromObjectType(elemType, checker);
      const sym = elemType.aliasSymbol ?? elemType.symbol;
      const typeName = sym && !sym.name.startsWith("__") ? sym.name : "Service";
      const jsDocType = sym ? extractJSDocInfo(sym, checker) : undefined;
      const pkgOverride = jsDocType?.meta?.["package"]?.[0] ?? jsDocType?.meta?.["Package"]?.[0];
      const svcOverride = jsDocType?.meta?.["service"]?.[0] ?? jsDocType?.meta?.["Service"]?.[0];
      const pkg = typeof pkgOverride === "string" ? pkgOverride : undefined;
      const svc = typeof svcOverride === "string" ? svcOverride : typeName;

      if (objectMethods.length === 0) {
        // A plain payload type is a legitimate `openapiSchema` argument: it
        // contributes a component schema and no operation. Only a type with
        // nothing at all on it is undocumentable.
        if (logger && checker.getPropertiesOfType(elemType).length === 0) {
          warnUndocumentable(
            logger,
            `no methods found on object type '${typeName}' for openapiSchema`,
            node,
            sourceFile
          );
        }
        continue;
      }

      for (const m of objectMethods) {
        const sig = m.signatures[0]!;
        const mSym = m.symbol;
        const jsDoc = extractJSDocInfo(mSym, checker);
        const method = parseOpenApiMethodFromSignature(sig, mSym, jsDoc, checker, pkg, svc, m.name, sourceFile);
        if (method) methods.push(method);
      }
    }
  }
  return methods;
}


function parseOpenApiMethodFromSignature(
  sig: ts.Signature,
  sym: ts.Symbol | undefined,
  jsDoc: JSDocInfo | undefined,
  checker: ts.TypeChecker,
  defaultPkg: string | undefined,
  defaultSvc: string | undefined,
  methodNameOverride?: string,
  sourceFile?: ts.SourceFile
): HttpServiceMethodIR {
  const rawName = jsDoc?.meta?.["name"]?.[0] ?? jsDoc?.meta?.["Name"]?.[0];
  const name = typeof rawName === "string" && rawName ? rawName : (methodNameOverride ?? sym?.name ?? "method");
  const pkgMeta = jsDoc?.meta?.["package"]?.[0] ?? jsDoc?.meta?.["Package"]?.[0];
  const svcMeta = jsDoc?.meta?.["service"]?.[0] ?? jsDoc?.meta?.["Service"]?.[0];
  const pkg = typeof pkgMeta === "string" ? pkgMeta : defaultPkg;
  const svc = typeof svcMeta === "string" ? svcMeta : defaultSvc;

  let httpVerb: HttpMethodName = "GET";
  let openApiPath = "/" + (name !== "method" ? toSnakeCase(name) : "");

  const verbTags: Array<[string, HttpMethodName]> = [
    ["get", "GET"],
    ["post", "POST"],
    ["put", "PUT"],
    ["delete", "DELETE"],
    ["patch", "PATCH"],
    ["head", "HEAD"],
    ["options", "OPTIONS"],
    ["trace", "TRACE"],
  ];

  let foundVerb = false;
  if (jsDoc?.meta) {
    for (const [tag, verb] of verbTags) {
      const val = jsDoc.meta[tag] ?? jsDoc.meta[tag.toUpperCase()];
      if (val) {
        httpVerb = verb;
        foundVerb = true;
        if (typeof val[0] === "string" && val[0].length > 0) {
          openApiPath = toOpenApiPath(val[0]);
        }
        break;
      }
    }
    if (!foundVerb) {
      const httpTag = jsDoc.meta["http"] ?? jsDoc.meta["HTTP"];
      if (httpTag && typeof httpTag[0] === "string") {
        const parts = httpTag[0].split(/\s+/);
        if (parts[0] && HTTP_METHODS.has(parts[0].toLowerCase())) {
          httpVerb = parts[0].toUpperCase() as HttpMethodName;
          foundVerb = true;
          if (parts[1]) openApiPath = toOpenApiPath(parts[1]);
        }
      }
    }
  }

  if (!foundVerb && name) {
    const lowerName = name.toLowerCase();
    if (lowerName.startsWith("create") || lowerName.startsWith("post") || lowerName.startsWith("add")) httpVerb = "POST";
    else if (lowerName.startsWith("update") || lowerName.startsWith("put")) httpVerb = "PUT";
    else if (lowerName.startsWith("delete") || lowerName.startsWith("remove")) httpVerb = "DELETE";
    else if (lowerName.startsWith("patch")) httpVerb = "PATCH";
  }

  const jsDocSummary = jsDoc?.meta?.["summary"]?.[0] ?? jsDoc?.meta?.["Summary"]?.[0];
  const summary = typeof jsDocSummary === "string" ? jsDocSummary : undefined;
  const request: HttpRequestIR = { protocol: "http" };
  const parameters: ParameterIR[] = [];

  for (const p of sig.getParameters()) {
    const pDecl = p.valueDeclaration ?? p.declarations?.[0];
    const pType = pDecl
      ? checker.getTypeOfSymbolAtLocation(p, pDecl)
      : checker.getTypeOfSymbol(p);
    const rawPIR = extractTypeIR(pType, checker);
    const pIR = unwrapOptionalTypeIR(rawPIR);
    const isOpt = (p.flags & ts.SymbolFlags.Optional) !== 0;
    const pJsDoc = extractJSDocInfo(p, checker);
    const pName = p.name;
    if (pIR.kind === "object") {
      const subProps = pIR.properties;
      const hasKnownSlots = subProps.some((sp) =>
        sp.name === "path" || sp.name === "query" || sp.name === "header" || sp.name === "cookie" || sp.name === "body"
      );

      if (hasKnownSlots) {
        for (const sp of subProps) {
          if (sp.name === "path") {
            const flattened = flattenObjectProperties(sp.type);
            for (const prop of flattened) {
              parameters.push({
                name: prop.name,
                in: "path",
                required: true,
                type: prop.type,
                ...(prop.description ? { description: prop.description } : {}),
              });
            }
          } else if (sp.name === "query") {
            const flattened = flattenObjectProperties(sp.type);
            for (const prop of flattened) {
              parameters.push({
                name: prop.name,
                in: "query",
                required: !prop.optional,
                type: prop.type,
                ...(prop.description ? { description: prop.description } : {}),
              });
            }
          } else if (sp.name === "header") {
            const flattened = flattenObjectProperties(sp.type);
            for (const prop of flattened) {
              parameters.push({
                name: prop.name,
                in: "header",
                required: !prop.optional,
                type: prop.type,
                ...(prop.description ? { description: prop.description } : {}),
              });
            }
          } else if (sp.name === "cookie") {
            const flattened = flattenObjectProperties(sp.type);
            for (const prop of flattened) {
              parameters.push({
                name: prop.name,
                in: "cookie",
                required: !prop.optional,
                type: prop.type,
                ...(prop.description ? { description: prop.description } : {}),
              });
            }
          } else if (sp.name === "body") {
            request.body = [{ mimetype: JSON_MIME, content: sp.type }];
          }
        }
        continue;
      }
    }

    if (pName === "body" || pJsDoc.meta?.["body"] || pJsDoc.meta?.["Body"]) {
      request.body = [{ mimetype: JSON_MIME, content: pIR }];
    } else if (
      pName === "query" ||
      pJsDoc.meta?.["queryParams"] ||
      pJsDoc.meta?.["queryparams"] ||
      (pIR.kind === "object" && !openApiPath.includes(`{${pName}}`))
    ) {
      const flattened = flattenObjectProperties(pIR);
      for (const prop of flattened) {
        parameters.push({
          name: prop.name,
          in: "query",
          required: !prop.optional,
          type: prop.type,
          ...(prop.description ? { description: prop.description } : {}),
        });
      }
    } else if (pName === "path" || pJsDoc.meta?.["pathParams"] || pJsDoc.meta?.["pathparams"]) {
      const flattened = flattenObjectProperties(pIR);
      for (const prop of flattened) {
        parameters.push({
          name: prop.name,
          in: "path",
          required: true,
          type: prop.type,
          ...(prop.description ? { description: prop.description } : {}),
        });
      }
    } else {
      const loc: ParameterIR["in"] = openApiPath.includes(`{${pName}}`) ? "path" : "query";
      parameters.push({
        name: pName,
        in: loc,
        required: loc === "path" ? true : !isOpt,
        type: pIR,
        ...(pJsDoc.description ? { description: pJsDoc.description } : {}),
      });
    }
  }
  if (parameters.length > 0) request.parameters = parameters;

  const responses: HttpResponseIR[] = [];
  const responseTags = jsDoc?.meta?.["response"] ?? jsDoc?.meta?.["Response"];
  if (responseTags && responseTags.length > 0) {
    for (const tagVal of responseTags) {
      if (typeof tagVal === "string") {
        const parts = tagVal.trim().split(/\s+/);
        let status: number | "default" = 200;
        let mimetype = JSON_MIME;
        let bodyIR: TypeIR | undefined;
        const descParts: string[] = [];

        for (const part of parts) {
          if (part === "default") {
            status = "default";
          } else if (/^\d{3}$/.test(part)) {
            status = parseInt(part, 10);
          } else if (part.includes("/")) {
            mimetype = part;
          } else {
            let typeStr = part;
            let isArray = false;
            if (typeStr.endsWith("[]")) {
              isArray = true;
              typeStr = typeStr.slice(0, -2);
            }
            const resolved = resolveTypeByName(typeStr, checker, sourceFile, sig);
            if (resolved && !bodyIR) {
              bodyIR = isArray ? { id: "t_arr", kind: "array", element: resolved } : resolved;
            } else if (part !== "never" && part !== "void") {
              descParts.push(part);
            }
          }
        }
        const description = descParts.length > 0 ? descParts.join(" ") : undefined;
        responses.push({
          protocol: "http",
          status,
          ...(description ? { description } : {}),
          ...(bodyIR ? { body: [{ mimetype, content: bodyIR }] } : {}),
        });
      }
    }
  }

  if (responses.length === 0) {
    const returnType = sig.getReturnType();
    let targetType = returnType;
    if (
      (returnType.symbol?.name === "Promise" || returnType.aliasSymbol?.name === "Promise") &&
      (returnType as ts.TypeReference).typeArguments?.length
    ) {
      targetType = (returnType as ts.TypeReference).typeArguments![0]!;
    }
    if (targetType.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Never)) {
      responses.push({ protocol: "http", status: 204 });
    } else {
      const resIR = extractTypeIR(targetType, checker);
      responses.push({
        protocol: "http",
        status: 200,
        body: [{ mimetype: JSON_MIME, content: resIR }],
      });
    }
  }

  return {
    kind: "serviceMethod",
    protocol: "http",
    address: {
      protocol: "http",
      method: httpVerb,
      path: openApiPath,
      ...(pkg ? { package: pkg } : {}),
      ...(svc ? { service: svc } : {}),
      ...(name ? { methodName: name } : {}),
    },
    operationId: name,
    ...(summary ? { summary } : {}),
    ...(jsDoc?.description ? { description: jsDoc.description } : {}),
    ...(jsDoc?.deprecated ? { deprecated: true } : {}),
    request,
    responses,
  };
}

export function harvestAsyncApiOperationsFromTypeArgs(
  typeArgs: readonly ts.Type[],
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  logger?: WizLogger
): AsyncApiServiceMethodIR[] {
  const methods: AsyncApiServiceMethodIR[] = [];
  for (const elemType of typeArgs) {
    const signatures = elemType.getCallSignatures();
    if (signatures.length > 0) {
      const sig = signatures[0]!;
      const sym = elemType.aliasSymbol ?? elemType.symbol ?? (sig.declaration as any)?.symbol;
      const jsDoc = sym ? extractJSDocInfo(sym, checker) : undefined;
      const method = parseAsyncApiMethodFromSignature(sig, sym, jsDoc, checker, undefined, undefined);
      if (method) methods.push(method);
    } else {
      const objectMethods = extractMethodsFromObjectType(elemType, checker);
      const sym = elemType.aliasSymbol ?? elemType.symbol;
      const typeName = sym && !sym.name.startsWith("__") ? sym.name : "Service";
      const jsDocType = sym ? extractJSDocInfo(sym, checker) : undefined;
      const pkgOverride = jsDocType?.meta?.["package"]?.[0] ?? jsDocType?.meta?.["Package"]?.[0];
      const svcOverride = jsDocType?.meta?.["service"]?.[0] ?? jsDocType?.meta?.["Service"]?.[0];
      const pkg = typeof pkgOverride === "string" ? pkgOverride : undefined;
      const svc = typeof svcOverride === "string" ? svcOverride : typeName;

      if (objectMethods.length === 0) {
        // A plain message type is a legitimate `asyncapiSchema` argument: it
        // contributes a component schema and no channel operation.
        if (logger && checker.getPropertiesOfType(elemType).length === 0) {
          warnUndocumentable(
            logger,
            `no methods found on object type '${typeName}' for asyncapiSchema`,
            node,
            sourceFile
          );
        }
        continue;
      }

      for (const m of objectMethods) {
        const sig = m.signatures[0]!;
        const mSym = m.symbol;
        const jsDoc = extractJSDocInfo(mSym, checker);
        const method = parseAsyncApiMethodFromSignature(sig, mSym, jsDoc, checker, pkg, svc, m.name);
        if (method) methods.push(method);
      }
    }
  }
  return methods;
}

function parseAsyncApiMethodFromSignature(
  sig: ts.Signature,
  sym: ts.Symbol | undefined,
  jsDoc: JSDocInfo | undefined,
  checker: ts.TypeChecker,
  defaultPkg: string | undefined,
  defaultSvc: string | undefined,
  methodNameOverride?: string
): AsyncApiServiceMethodIR {
  const rawName = jsDoc?.meta?.["name"]?.[0] ?? jsDoc?.meta?.["Name"]?.[0];
  const name = typeof rawName === "string" && rawName ? rawName : (methodNameOverride ?? sym?.name ?? "channel");
  const pkgMeta = jsDoc?.meta?.["package"]?.[0] ?? jsDoc?.meta?.["Package"]?.[0];
  const svcMeta = jsDoc?.meta?.["service"]?.[0] ?? jsDoc?.meta?.["Service"]?.[0];
  const pkg = typeof pkgMeta === "string" ? pkgMeta : defaultPkg;
  const svc = typeof svcMeta === "string" ? svcMeta : defaultSvc;
  const channelTag = jsDoc?.meta?.["channel"]?.[0] ?? jsDoc?.meta?.["Channel"]?.[0];
  const channel = typeof channelTag === "string" ? channelTag : name;

  let action = "send";
  if (jsDoc?.meta?.["consumer"] || jsDoc?.meta?.["subscribe"] || jsDoc?.meta?.["receive"]) {
    action = "receive";
  } else if (jsDoc?.meta?.["producer"] || jsDoc?.meta?.["publish"] || jsDoc?.meta?.["send"]) {
    action = "send";
  } else if (jsDoc?.meta?.["action"]) {
    const actTag = String(jsDoc.meta["action"][0]);
    if (actTag === "subscribe" || actTag === "receive") action = "receive";
    else action = "send";
  }

  const jsDocSummary = jsDoc?.meta?.["summary"]?.[0] ?? jsDoc?.meta?.["Summary"]?.[0];
  const summary = typeof jsDocSummary === "string" ? jsDocSummary : undefined;
  const params = sig.getParameters();
  const first = params[0];
  let msgType = first
    ? checker.getTypeOfSymbolAtLocation(first, first.valueDeclaration ?? first.declarations?.[0]!)
    : sig.getReturnType();

  // An application produces events by handing them to a listener, so the
  // payload of `onPetChanged(listener: (event: E) => void)` is `E`: the
  // listener's own parameter, not the function type it is declared as.
  const listener = msgType.getCallSignatures()[0];
  if (listener) {
    const handled = listener.getParameters()[0];
    msgType = handled
      ? checker.getTypeOfSymbolAtLocation(
          handled,
          handled.valueDeclaration ?? handled.declarations?.[0]!
        )
      : listener.getReturnType();
  }

  // `petChangedEvents(): AsyncIterable<E>` says the same thing as a stream of
  // one payload rather than a callback, and both spellings mean the channel
  // carries `E`.
  msgType = unwrapStreamingType(unwrapPromiseType(msgType)).type;
  const msgIR = extractTypeIR(msgType, checker);

  return {
    kind: "serviceMethod",
    protocol: "asyncapi",
    address: {
      protocol: "asyncapi",
      channel,
      action,
      ...(pkg ? { package: pkg } : {}),
      ...(svc ? { service: svc } : {}),
    },
    operationId: name,
    ...(summary ? { summary } : {}),
    ...(jsDoc?.description ? { description: jsDoc.description } : {}),
    ...(jsDoc?.deprecated ? { deprecated: true } : {}),
    request: {
      protocol: "asyncapi",
      body: [{ mimetype: JSON_MIME, content: msgIR }],
    },
    responses: [],
  };
}

export function harvestOpenRpcOperationsFromTypeArgs(
  typeArgs: readonly ts.Type[],
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  logger?: WizLogger
): OpenRpcServiceMethodIR[] {
  const methods: OpenRpcServiceMethodIR[] = [];

  for (const elemType of typeArgs) {
    const signatures = elemType.getCallSignatures();
    if (signatures.length > 0) {
      const sig = signatures[0]!;
      const sym =
        elemType.aliasSymbol ??
        elemType.symbol ??
        (sig.declaration as any)?.symbol;
      const jsDoc = sym ? extractJSDocInfo(sym, checker) : undefined;
      const rawName = jsDoc?.meta?.["name"]?.[0] ?? jsDoc?.meta?.["Name"]?.[0];
      const name =
        (typeof rawName === "string" && rawName ? rawName : undefined) ??
        (sym && !sym.name.startsWith("__") ? sym.name : undefined) ??
        "method";

      const pkgMeta = jsDoc?.meta?.["package"]?.[0] ?? jsDoc?.meta?.["Package"]?.[0];
      const svcMeta = jsDoc?.meta?.["service"]?.[0] ?? jsDoc?.meta?.["Service"]?.[0];
      const pkg = typeof pkgMeta === "string" ? pkgMeta : undefined;
      const svc = typeof svcMeta === "string" ? svcMeta : undefined;

      const jsDocSummary = jsDoc?.meta?.["summary"]?.[0] ?? jsDoc?.meta?.["Summary"]?.[0];
      const summary = typeof jsDocSummary === "string" ? jsDocSummary : undefined;

      const params: ParameterIR[] = sig.getParameters().map((p) => {
        const pDecl = p.valueDeclaration ?? p.declarations?.[0];
        const pType = pDecl
          ? checker.getTypeOfSymbolAtLocation(p, pDecl)
          : checker.getTypeOfSymbol(p);
        const pIR = extractTypeIR(pType, checker);
        const isOpt = (p.flags & ts.SymbolFlags.Optional) !== 0;
        const pJsDoc = extractJSDocInfo(p, checker);
        return {
          name: p.name,
          in: "rpc",
          required: !isOpt,
          type: pIR,
          ...(pJsDoc.description ? { description: pJsDoc.description } : {}),
        };
      });

      const returnType = sig.getReturnType();
      let targetType = returnType;
      if (
        (returnType.symbol?.name === "Promise" ||
          returnType.aliasSymbol?.name === "Promise") &&
        (returnType as ts.TypeReference).typeArguments?.length
      ) {
        targetType = (returnType as ts.TypeReference).typeArguments![0]!;
      }
      const resultIR = extractTypeIR(targetType, checker);

      const methodIR: OpenRpcServiceMethodIR = {
        kind: "serviceMethod",
        protocol: "openrpc",
        address: {
          protocol: "openrpc",
          ...(pkg ? { package: pkg } : {}),
          ...(svc ? { service: svc } : {}),
          method: name,
        },
        ...(summary ? { summary } : {}),
        ...(jsDoc?.description ? { description: jsDoc.description } : {}),
        ...(jsDoc?.deprecated ? { deprecated: true } : {}),
        request: {
          protocol: "openrpc",
          params,
          paramsByName: true,
        },
        responses: [
          {
            protocol: "openrpc",
            result: resultIR,
          },
        ],
      };
      methods.push(methodIR);
    } else {
      const objectMethods = extractMethodsFromObjectType(elemType, checker);
      const sym = elemType.aliasSymbol ?? elemType.symbol;
      const typeName =
        sym && !sym.name.startsWith("__") ? sym.name : "Service";
      const jsDocType = sym ? extractJSDocInfo(sym, checker) : undefined;
      const pkgOverride = jsDocType?.meta?.["package"]?.[0] ?? jsDocType?.meta?.["Package"]?.[0];
      const svcOverride = jsDocType?.meta?.["service"]?.[0] ?? jsDocType?.meta?.["Service"]?.[0];
      const pkg = typeof pkgOverride === "string" ? pkgOverride : undefined;
      const svc = typeof svcOverride === "string" ? svcOverride : typeName;

      if (objectMethods.length === 0) {
        if (logger) {
          warnUndocumentable(
            logger,
            `no methods found on object type '${typeName}' for openRPCSchema`,
            node,
            sourceFile
          );
        }
        continue;
      }

      for (const m of objectMethods) {
        const sig = m.signatures[0]!;
        const mSym = m.symbol;
        const jsDoc = extractJSDocInfo(mSym, checker);
        const rawName = jsDoc.meta?.["name"]?.[0] ?? jsDoc.meta?.["Name"]?.[0];
        const hasOverride = typeof rawName === "string" && rawName.length > 0;
        const methodName = hasOverride ? rawName : m.name;

        const jsDocSummary = jsDoc.meta?.["summary"]?.[0] ?? jsDoc.meta?.["Summary"]?.[0];
        const summary = typeof jsDocSummary === "string" ? jsDocSummary : undefined;

        const params: ParameterIR[] = sig.getParameters().map((p) => {
          const pDecl = p.valueDeclaration ?? p.declarations?.[0];
          const pType = pDecl
            ? checker.getTypeOfSymbolAtLocation(p, pDecl)
            : checker.getTypeOfSymbol(p);
          const pIR = extractTypeIR(pType, checker);
          const isOpt = (p.flags & ts.SymbolFlags.Optional) !== 0;
          const pJsDoc = extractJSDocInfo(p, checker);
          return {
            name: p.name,
            in: "rpc",
            required: !isOpt,
            type: pIR,
            ...(pJsDoc.description ? { description: pJsDoc.description } : {}),
          };
        });

        const returnType = sig.getReturnType();
        let targetType = returnType;
        if (
          (returnType.symbol?.name === "Promise" ||
            returnType.aliasSymbol?.name === "Promise") &&
          (returnType as ts.TypeReference).typeArguments?.length
        ) {
          targetType = (returnType as ts.TypeReference).typeArguments![0]!;
        }
        const resultIR = extractTypeIR(targetType, checker);

        const methodIR: OpenRpcServiceMethodIR = {
          kind: "serviceMethod",
          protocol: "openrpc",
          address: {
            protocol: "openrpc",
            ...(pkg ? { package: pkg } : {}),
            ...(hasOverride ? {} : { service: svc }),
            method: methodName,
          },
          ...(summary ? { summary } : {}),
          ...(jsDoc.description ? { description: jsDoc.description } : {}),
          ...(jsDoc.deprecated ? { deprecated: true } : {}),
          request: {
            protocol: "openrpc",
            params,
            paramsByName: true,
          },
          responses: [
            {
              protocol: "openrpc",
              result: resultIR,
            },
          ],
        };
        methods.push(methodIR);
      }
    }
  }

  return methods;
}

export function harvestMcpOperationsFromTypeArgs(
  typeArgs: readonly ts.Type[],
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  logger?: WizLogger
): McpServiceMethodIR[] {
  const methods: McpServiceMethodIR[] = [];

  for (const elemType of typeArgs) {
    const signatures = elemType.getCallSignatures();
    if (signatures.length > 0) {
      const sig = signatures[0]!;
      const sym =
        elemType.aliasSymbol ??
        elemType.symbol ??
        (sig.declaration as any)?.symbol;
      const jsDoc = sym ? extractJSDocInfo(sym, checker) : undefined;
      const rawName = jsDoc?.meta?.["name"]?.[0] ?? jsDoc?.meta?.["Name"]?.[0];
      const symName = sym && !sym.name.startsWith("__") ? sym.name : undefined;
      const toolName =
        (typeof rawName === "string" && rawName ? rawName : undefined) ??
        (symName ? toSnakeCase(symName) : "tool");

      const jsDocSummary = jsDoc?.meta?.["summary"]?.[0] ?? jsDoc?.meta?.["Summary"]?.[0];
      const jsDocTitle = jsDoc?.meta?.["title"]?.[0] ?? jsDoc?.meta?.["Title"]?.[0] ?? jsDocSummary;
      const title = typeof jsDocTitle === "string" ? jsDocTitle : undefined;
      const description = jsDoc?.description;

      const rawAudience = jsDoc?.meta?.["audience"] ?? jsDoc?.meta?.["Audience"];
      const jsDocAudience = rawAudience
        ? parseAudience(rawAudience.filter((a): a is string => typeof a === "string"))
        : undefined;

      const rawPriority = jsDoc?.meta?.["priority"]?.[0] ?? jsDoc?.meta?.["Priority"]?.[0];
      let jsDocPriority: number | undefined;
      if (typeof rawPriority === "string") {
        const parsedP = parseFloat(rawPriority);
        if (!Number.isNaN(parsedP)) jsDocPriority = parsedP;
      }

      const annotations: McpToolAnnotationsIR | undefined =
        jsDocAudience || jsDocPriority !== undefined
          ? {
              ...(jsDocAudience ? { audience: jsDocAudience } : {}),
              ...(jsDocPriority !== undefined ? { priority: jsDocPriority } : {}),
            }
          : undefined;

      const params = sig.getParameters();
      let inputIR: TypeIR;
      if (params.length === 1) {
        const pDecl = params[0]!.valueDeclaration ?? params[0]!.declarations?.[0];
        const pType = pDecl
          ? checker.getTypeOfSymbolAtLocation(params[0]!, pDecl)
          : checker.getTypeOfSymbol(params[0]!);
        const pIR = extractTypeIR(pType, checker);
        if (pIR.kind === "object") {
          inputIR = pIR;
        } else {
          const isOpt = (params[0]!.flags & ts.SymbolFlags.Optional) !== 0;
          inputIR = {
            id: "t_input",
            kind: "object",
            properties: [{ name: params[0]!.name, type: pIR, optional: isOpt, readonly: false }],
          };
        }
      } else if (params.length > 1) {
        const properties = params.map((p) => {
          const pDecl = p.valueDeclaration ?? p.declarations?.[0];
          const pType = pDecl
            ? checker.getTypeOfSymbolAtLocation(p, pDecl)
            : checker.getTypeOfSymbol(p);
          const pIR = extractTypeIR(pType, checker);
          const isOpt = (p.flags & ts.SymbolFlags.Optional) !== 0;
          return { name: p.name, type: pIR, optional: isOpt, readonly: false };
        });
        inputIR = { id: "t_input", kind: "object", properties };
      } else {
        inputIR = { id: "t_input", kind: "object", properties: [] };
      }

      const returnType = sig.getReturnType();
      let targetType = returnType;
      if (
        (returnType.symbol?.name === "Promise" ||
          returnType.aliasSymbol?.name === "Promise") &&
        (returnType as ts.TypeReference).typeArguments?.length
      ) {
        targetType = (returnType as ts.TypeReference).typeArguments![0]!;
      }
      const outputIR = extractTypeIR(targetType, checker);

      const methodIR: McpServiceMethodIR = {
        kind: "serviceMethod",
        protocol: "mcp",
        address: {
          protocol: "mcp",
          name: toolName,
        },
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        ...(annotations ? { annotations } : {}),
        request: {
          protocol: "mcp",
          input: inputIR,
        },
        responses: [
          {
            protocol: "mcp",
            ...(!isAbsent(outputIR) ? { output: outputIR } : {}),
          },
        ],
      };
      methods.push(methodIR);
    } else {
      const objectMethods = extractMethodsFromObjectType(elemType, checker);
      const sym = elemType.aliasSymbol ?? elemType.symbol;
      const typeName =
        sym && !sym.name.startsWith("__") ? sym.name : "Service";

      if (objectMethods.length === 0) {
        if (logger) {
          warnUndocumentable(
            logger,
            `no methods found on object type '${typeName}' for mcpSchema`,
            node,
            sourceFile
          );
        }
        continue;
      }

      for (const m of objectMethods) {
        const sig = m.signatures[0]!;
        const mSym = m.symbol;
        const jsDoc = extractJSDocInfo(mSym, checker);
        const rawName = jsDoc.meta?.["name"]?.[0] ?? jsDoc.meta?.["Name"]?.[0];
        const hasOverride = typeof rawName === "string" && rawName.length > 0;
        const toolName = hasOverride
          ? rawName
          : `${typeName}.${toSnakeCase(m.name)}`;

        const jsDocSummary = jsDoc.meta?.["summary"]?.[0] ?? jsDoc.meta?.["Summary"]?.[0];
        const jsDocTitle = jsDoc.meta?.["title"]?.[0] ?? jsDoc.meta?.["Title"]?.[0] ?? jsDocSummary;
        const title = typeof jsDocTitle === "string" ? jsDocTitle : undefined;
        const description = jsDoc.description;

        const rawAudience = jsDoc.meta?.["audience"] ?? jsDoc.meta?.["Audience"];
        const jsDocAudience = rawAudience
          ? parseAudience(rawAudience.filter((a): a is string => typeof a === "string"))
          : undefined;

        const rawPriority = jsDoc.meta?.["priority"]?.[0] ?? jsDoc.meta?.["Priority"]?.[0];
        let jsDocPriority: number | undefined;
        if (typeof rawPriority === "string") {
          const parsedP = parseFloat(rawPriority);
          if (!Number.isNaN(parsedP)) jsDocPriority = parsedP;
        }

        const annotations: McpToolAnnotationsIR | undefined =
          jsDocAudience || jsDocPriority !== undefined
            ? {
                ...(jsDocAudience ? { audience: jsDocAudience } : {}),
                ...(jsDocPriority !== undefined ? { priority: jsDocPriority } : {}),
              }
            : undefined;

        const params = sig.getParameters();
        let inputIR: TypeIR;
        if (params.length === 1) {
          const pDecl = params[0]!.valueDeclaration ?? params[0]!.declarations?.[0];
          const pType = pDecl
            ? checker.getTypeOfSymbolAtLocation(params[0]!, pDecl)
            : checker.getTypeOfSymbol(params[0]!);
          const pIR = extractTypeIR(pType, checker);
          if (pIR.kind === "object") {
            inputIR = pIR;
          } else {
            const isOpt = (params[0]!.flags & ts.SymbolFlags.Optional) !== 0;
            inputIR = {
              id: "t_input",
              kind: "object",
              properties: [{ name: params[0]!.name, type: pIR, optional: isOpt, readonly: false }],
            };
          }
        } else if (params.length > 1) {
          const properties = params.map((p) => {
            const pDecl = p.valueDeclaration ?? p.declarations?.[0];
            const pType = pDecl
              ? checker.getTypeOfSymbolAtLocation(p, pDecl)
              : checker.getTypeOfSymbol(p);
            const pIR = extractTypeIR(pType, checker);
            const isOpt = (p.flags & ts.SymbolFlags.Optional) !== 0;
            return { name: p.name, type: pIR, optional: isOpt, readonly: false };
          });
          inputIR = { id: "t_input", kind: "object", properties };
        } else {
          inputIR = { id: "t_input", kind: "object", properties: [] };
        }

        const returnType = sig.getReturnType();
        let targetType = returnType;
        if (
          (returnType.symbol?.name === "Promise" ||
            returnType.aliasSymbol?.name === "Promise") &&
          (returnType as ts.TypeReference).typeArguments?.length
        ) {
          targetType = (returnType as ts.TypeReference).typeArguments![0]!;
        }
        const outputIR = extractTypeIR(targetType, checker);

        const methodIR: McpServiceMethodIR = {
          kind: "serviceMethod",
          protocol: "mcp",
          address: {
            protocol: "mcp",
            name: toolName,
          },
          ...(title ? { title } : {}),
          ...(description ? { description } : {}),
          ...(annotations ? { annotations } : {}),
          request: {
            protocol: "mcp",
            input: inputIR,
          },
          responses: [
            {
              protocol: "mcp",
              ...(!isAbsent(outputIR) ? { output: outputIR } : {}),
            },
          ],
        };
        methods.push(methodIR);
      }
    }
  }

  return methods;
}

/**
 * A stream of `T` unwrapped to `T`, in every spelling TypeScript offers for
 * one: this is how a `stream` rpc side and an event channel's payload are
 * both read off a signature.
 */
function unwrapStreamingType(type: ts.Type): { streaming: boolean; type: ts.Type } {
  const symName = type.aliasSymbol?.name ?? type.symbol?.name;
  if (
    symName === "AsyncIterable" ||
    symName === "AsyncIterator" ||
    symName === "AsyncIterableIterator" ||
    symName === "AsyncGenerator" ||
    symName === "ReadableStream"
  ) {
    const typeArgs = (type as ts.TypeReference).typeArguments;
    if (typeArgs && typeArgs.length > 0) {
      return { streaming: true, type: typeArgs[0]! };
    }
  }
  return { streaming: false, type };
}

function unwrapPromiseType(type: ts.Type): ts.Type {
  const symName = type.aliasSymbol?.name ?? type.symbol?.name;
  if (symName === "Promise") {
    const typeArgs = (type as ts.TypeReference).typeArguments;
    if (typeArgs && typeArgs.length > 0) {
      return typeArgs[0]!;
    }
  }
  return type;
}

export function harvestGrpcOperationsFromTypeArgs(
  typeArgs: readonly ts.Type[],
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  logger?: WizLogger
): GrpcServiceMethodIR[] {
  const methods: GrpcServiceMethodIR[] = [];

  for (const elemType of typeArgs) {
    const signatures = elemType.getCallSignatures();
    if (signatures.length > 0) {
      const sig = signatures[0]!;
      const sym =
        elemType.aliasSymbol ??
        elemType.symbol ??
        (sig.declaration as any)?.symbol;
      const jsDoc = sym ? extractJSDocInfo(sym, checker) : undefined;
      const rawName = jsDoc?.meta?.["name"]?.[0] ?? jsDoc?.meta?.["Name"]?.[0];
      const name =
        (typeof rawName === "string" && rawName ? rawName : undefined) ??
        (sym && !sym.name.startsWith("__") ? sym.name : undefined) ??
        "method";

      const pkgMeta = jsDoc?.meta?.["package"]?.[0] ?? jsDoc?.meta?.["Package"]?.[0];
      const svcMeta = jsDoc?.meta?.["service"]?.[0] ?? jsDoc?.meta?.["Service"]?.[0];
      const pkg = typeof pkgMeta === "string" ? pkgMeta : undefined;
      const svc = typeof svcMeta === "string" ? svcMeta : "Service";

      const jsDocSummary = jsDoc?.meta?.["summary"]?.[0] ?? jsDoc?.meta?.["Summary"]?.[0];
      const summary = typeof jsDocSummary === "string" ? jsDocSummary : undefined;

      const params = sig.getParameters();
      let reqIR: TypeIR;
      let reqStreaming = false;
      if (params.length > 0) {
        const p = params[0]!;
        const pDecl = p.valueDeclaration ?? p.declarations?.[0];
        const pType = pDecl
          ? checker.getTypeOfSymbolAtLocation(p, pDecl)
          : checker.getTypeOfSymbol(p);
        const { streaming, type: unwrappedReqType } = unwrapStreamingType(pType);
        reqStreaming = streaming;
        reqIR = extractTypeIR(unwrappedReqType, checker);
      } else {
        reqIR = extractTypeIR(checker.getVoidType(), checker);
      }

      const returnType = sig.getReturnType();
      const unwrappedPromise = unwrapPromiseType(returnType);
      const { streaming: resStreaming, type: unwrappedResType } = unwrapStreamingType(unwrappedPromise);
      const resIR = extractTypeIR(unwrappedResType, checker);

      const methodIR: GrpcServiceMethodIR = {
        kind: "serviceMethod",
        protocol: "grpc",
        address: {
          protocol: "grpc",
          ...(pkg ? { package: pkg } : {}),
          service: svc,
          method: name,
        },
        ...(summary ? { summary } : {}),
        ...(jsDoc?.description ? { description: jsDoc.description } : {}),
        ...(jsDoc?.deprecated ? { deprecated: true } : {}),
        request: {
          protocol: "grpc",
          message: reqIR,
          streaming: reqStreaming,
        },
        responses: [
          {
            protocol: "grpc",
            message: resIR,
            streaming: resStreaming,
          },
        ],
      };
      methods.push(methodIR);
    } else {
      const objectMethods = extractMethodsFromObjectType(elemType, checker);
      const sym = elemType.aliasSymbol ?? elemType.symbol;
      const typeName =
        sym && !sym.name.startsWith("__") ? sym.name : "Service";
      const jsDocType = sym ? extractJSDocInfo(sym, checker) : undefined;
      const pkgOverride = jsDocType?.meta?.["package"]?.[0] ?? jsDocType?.meta?.["Package"]?.[0];
      const svcOverride = jsDocType?.meta?.["service"]?.[0] ?? jsDocType?.meta?.["Service"]?.[0];
      const pkg = typeof pkgOverride === "string" ? pkgOverride : undefined;
      const svc = typeof svcOverride === "string" ? svcOverride : typeName;

      if (objectMethods.length === 0) {
        if (logger) {
          warnUndocumentable(
            logger,
            `no methods found on object type '${typeName}' for grpcSchema`,
            node,
            sourceFile
          );
        }
        continue;
      }

      for (const m of objectMethods) {
        const sig = m.signatures[0]!;
        const mSym = m.symbol;
        const jsDoc = extractJSDocInfo(mSym, checker);
        const rawName = jsDoc.meta?.["name"]?.[0] ?? jsDoc.meta?.["Name"]?.[0];
        const hasOverride = typeof rawName === "string" && rawName.length > 0;
        const methodName = hasOverride ? rawName : m.name;

        const mPkgMeta = jsDoc.meta?.["package"]?.[0] ?? jsDoc.meta?.["Package"]?.[0];
        const mSvcMeta = jsDoc.meta?.["service"]?.[0] ?? jsDoc.meta?.["Service"]?.[0];
        const methodPkg = (typeof mPkgMeta === "string" && mPkgMeta) ? mPkgMeta : pkg;
        const methodSvc = (typeof mSvcMeta === "string" && mSvcMeta) ? mSvcMeta : svc;

        const jsDocSummary = jsDoc.meta?.["summary"]?.[0] ?? jsDoc.meta?.["Summary"]?.[0];
        const summary = typeof jsDocSummary === "string" ? jsDocSummary : undefined;

        const params = sig.getParameters();
        let reqIR: TypeIR;
        let reqStreaming = false;
        if (params.length > 0) {
          const p = params[0]!;
          const pDecl = p.valueDeclaration ?? p.declarations?.[0];
          const pType = pDecl
            ? checker.getTypeOfSymbolAtLocation(p, pDecl)
            : checker.getTypeOfSymbol(p);
          const { streaming, type: unwrappedReqType } = unwrapStreamingType(pType);
          reqStreaming = streaming;
          reqIR = extractTypeIR(unwrappedReqType, checker);
        } else {
          reqIR = extractTypeIR(checker.getVoidType(), checker);
        }

        const returnType = sig.getReturnType();
        const unwrappedPromise = unwrapPromiseType(returnType);
        const { streaming: resStreaming, type: unwrappedResType } = unwrapStreamingType(unwrappedPromise);
        const resIR = extractTypeIR(unwrappedResType, checker);

        const methodIR: GrpcServiceMethodIR = {
          kind: "serviceMethod",
          protocol: "grpc",
          address: {
            protocol: "grpc",
            ...(methodPkg ? { package: methodPkg } : {}),
            service: methodSvc,
            method: methodName,
          },
          ...(summary ? { summary } : {}),
          ...(jsDoc.description ? { description: jsDoc.description } : {}),
          ...(jsDoc.deprecated ? { deprecated: true } : {}),
          request: {
            protocol: "grpc",
            message: reqIR,
            streaming: reqStreaming,
          },
          responses: [
            {
              protocol: "grpc",
              message: resIR,
              streaming: resStreaming,
            },
          ],
        };
        methods.push(methodIR);
      }
    }
  }

  return methods;
}
