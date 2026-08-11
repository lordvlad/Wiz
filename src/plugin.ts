import type { BunPlugin } from "bun";
import ts from "typescript";
import { extractTypeIR } from "./ir/extractor.ts";
import type { OpenApiOperationIR } from "./generators/openapi.ts";
import { defaultLogger, type WizLogger } from "./logger.ts";
import { registerType, getTypeModule } from "./registry.ts";
import {
  flattenObjectProperties,
  fnv1a,
  getTypeKey,
  normalizeTypeIR,
  type TypeIR,
} from "./types.ts";

const HELPER_FUNCTIONS = new Set([
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
 * Reads the `[openapiSchema.get<...>("/users"), ...]` argument.
 * Only inline array literals of direct builder calls are folded; anything else
 * is left alone so the runtime stub reports it loudly.
 */
function collectOperations(
  arg: ts.Expression | undefined,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile
): OpenApiOperationIR[] {
  if (!arg || !ts.isArrayLiteralExpression(arg)) return [];

  const operations: OpenApiOperationIR[] = [];
  for (const element of arg.elements) {
    if (!ts.isCallExpression(element)) continue;
    if (!ts.isPropertyAccessExpression(element.expression)) continue;

    const method = element.expression.name.text.toLowerCase();
    if (!HTTP_METHODS.has(method)) continue;

    const pathArg = element.arguments[0];
    if (!pathArg || !ts.isStringLiteralLike(pathArg)) continue;

    const optionsArg = element.arguments[1];
    const [pathParams, queryParams, response, requestBody] =
      (element.typeArguments ?? []).map((typeNode) =>
        extractTypeIR(checker.getTypeFromTypeNode(typeNode), checker)
      );

    operations.push({
      method,
      path: toOpenApiPath(pathArg.text),
      optionsSource: optionsArg ? optionsArg.getText(sourceFile) : undefined,
      pathParams,
      queryParams,
      response,
      requestBody,
    });
  }
  return operations;
}

/** Stable, content-addressable projection of an operation for hashing. */
function operationKeyPart(op: OpenApiOperationIR): unknown {
  return {
    m: op.method,
    p: op.path,
    o: op.optionsSource ?? null,
    t: [op.pathParams, op.queryParams, op.response, op.requestBody].map((ir) =>
      ir ? normalizeTypeIR(ir) : null
    ),
  };
}
/** Slots understood inside an `op<{ … }>()` type argument. */
const SPEC_SLOTS = ["path", "query", "body", "response"] as const;

/**
 * Reads the single named-member type argument of `op<{ query: Q; … }>()`.
 * Named slots beat positional generics: callers omit what they do not use and
 * new slots can be added without shifting anyone's arguments.
 */
function readOperationSpec(
  call: ts.CallExpression,
  checker: ts.TypeChecker
): Partial<OpenApiOperationIR> {
  const specNode = call.typeArguments?.[0];
  if (!specNode) return {};

  const specIR = extractTypeIR(checker.getTypeFromTypeNode(specNode), checker);
  const slots = new Map(
    flattenObjectProperties(specIR).map((p) => [p.name, p])
  );

  const spec: Partial<OpenApiOperationIR> = {};
  for (const slot of SPEC_SLOTS) {
    const property = slots.get(slot);
    if (!property) continue;
    if (slot === "path") spec.pathParams = property.type;
    else if (slot === "query") spec.queryParams = property.type;
    else if (slot === "body") spec.requestBody = property.type;
    else spec.response = property.type;
  }

  // `status: 201` is a numeric literal type, not a payload schema.
  const status = slots.get("status");
  if (status?.type.kind === "literal" && typeof status.type.value === "number") {
    spec.status = status.type.value;
  }

  return spec;
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
): OpenApiOperationIR[] {
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

  const operations: OpenApiOperationIR[] = [];

  const push = (
    path: string,
    method: string,
    value: ts.Expression | undefined
  ) => {
    const call = value ? asOperationCall(value) : undefined;
    const optionsArg = call?.arguments[1];
    const openApiPath = toOpenApiPath(path);
    logger.trace(`[wiz] documented ${method.toUpperCase()} ${openApiPath}`);
    operations.push({
      method,
      path: openApiPath,
      optionsSource: optionsArg ? optionsArg.getText(sourceFile) : undefined,
      ...(call ? readOperationSpec(call, checker) : {}),
    });
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

  return operations;
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
export interface WizPluginOptions {
  /**
   * Where diagnostics go. Defaults to {@link defaultLogger}, which forwards
   * `info`/`warn`/`error` to `console` and drops `trace`. Pass
   * `consoleLogger` for verbose builds, `silentLogger` to mute the plugin, or
   * any object with the four levels to route them somewhere else.
   */
  logger?: WizLogger;
}

export function wizPlugin(options: WizPluginOptions = {}): BunPlugin {
  const logger = options.logger ?? defaultLogger;
  return {
    name: "wiz-plugin",
    setup(build) {
      // Resolve virtual module paths
      build.onResolve({ filter: /wiz-virtual/ }, (args) => {
        return {
          path: args.path,
          namespace: "wiz-virtual",
        };
      });

      // Load content for virtual modules
      build.onLoad({ filter: /.*/, namespace: "wiz-virtual" }, (args) => {
        const hash = args.path
          .replace(/^.*wiz-virtual-?/, "")
          .replace(/^\//, "")
          .replace(/\.js$/, "");
        const contents = getTypeModule(hash);
        if (!contents) {
          const message = `[wiz] Virtual module for hash '${hash}' not found in registry.`;
          logger.error(message);
          throw new Error(message);
        }
        return {
          contents,
          loader: "js",
        };
      });

      build.onLoad({ filter: /\.[jt]sx?$/ }, async (args) => {
        // Bun's runtime loader rejects an `undefined` onLoad result, so every
        // bail-out below hands back the untouched source instead.
        const loader: "ts" | "tsx" = args.path.endsWith(".tsx") ? "tsx" : "ts";
        const passthrough = async () => ({
          contents: await Bun.file(args.path).text(),
          loader,
        });

        if (args.path.includes("node_modules")) {
          return passthrough();
        }

        const fileContents = await Bun.file(args.path).text();

        // Skip files marked with @wiz-ignore or without helper calls
        if (
          fileContents.includes("@wiz-ignore") ||
          !Array.from(HELPER_FUNCTIONS).some((fn) => fileContents.includes(fn))
        ) {
          return { contents: fileContents, loader };
        }
        // Setup TS Compiler Program and Checker for full type checking
        const host = ts.createCompilerHost(COMPILER_OPTIONS);
        const originalReadFile = host.readFile.bind(host);
        const originalGetSourceFile = host.getSourceFile.bind(host);

        host.readFile = (fileName: string) =>
          fileName === args.path ? fileContents : originalReadFile(fileName);

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

        const program = ts.createProgram([args.path], COMPILER_OPTIONS, host);
        const checker = program.getTypeChecker();
        const sourceFile = program.getSourceFile(args.path);

        if (!sourceFile) {
          return { contents: fileContents, loader };
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

                const routeOperations = collectRouteOperations(
                  routesArg,
                  checker,
                  sourceFile,
                  logger
                );
                const callIR = extractTypeIR(
                  checker.getTypeAtLocation(node),
                  checker
                );
                const routesHash = `routes_${fnv1a(
                  JSON.stringify(routeOperations.map(operationKeyPart))
                )}`;

                registerType(routesHash, callIR, {
                  openApiTypes: [],
                  openApiVersion: readVersionFromBase(node.arguments[adapter.base]),
                  openApiOperations: routeOperations,
                });

                if (!virtualImports.has(routesHash)) {
                  virtualImports.set(routesHash, new Set());
                }
                virtualImports.get(routesHash)!.add("openapiSchema");
                modified = true;

                const baseArg = node.arguments[adapter.base]
                  ? (ts.visitNode(
                      node.arguments[adapter.base],
                      visitor
                    ) as ts.Expression)
                  : context.factory.createObjectLiteralExpression([]);

                const register = context.factory.createCallExpression(
                  context.factory.createPropertyAccessExpression(
                    expression.expression,
                    "__mergeDocument"
                  ),
                  undefined,
                  [
                    context.factory.createCallExpression(
                      context.factory.createIdentifier(
                        `__wiz_openapiSchema_${routesHash}`
                      ),
                      undefined,
                      [baseArg]
                    ),
                  ]
                );

                // Bun: the call collapses to the routes literal, which Bun.serve
                // consumes directly. Hono: the call must survive, because it is
                // what mounts the handlers onto the app.
                const value =
                  fnName === "bunRoutes"
                    ? (ts.visitNode(routesArg, visitor) as ts.Expression)
                    : (ts.visitEachChild(node, visitor, context) as ts.Expression);

                return context.factory.createParenthesizedExpression(
                  context.factory.createCommaListExpression([register, value])
                );
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

                  registerType(hash, ir);

                  if (!virtualImports.has(hash)) {
                    virtualImports.set(hash, new Set());
                  }
                  const exportSet = virtualImports.get(hash)!;

                  modified = true;

                  switch (fnName) {
                    case "keysOf": {
                      exportSet.add("keys");
                      return context.factory.createIdentifier(`__wiz_keys_${hash}`);
                    }
                    case "requiredKeysOf": {
                      exportSet.add("requiredKeys");
                      return context.factory.createIdentifier(`__wiz_reqKeys_${hash}`);
                    }
                    case "optionalKeysOf": {
                      exportSet.add("optionalKeys");
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
                        exportSet.add("schema_draft07");
                        return context.factory.createIdentifier(`__wiz_schema07_${hash}`);
                      } else {
                        exportSet.add("schema_draft2020");
                        return context.factory.createIdentifier(`__wiz_schema_${hash}`);
                      }
                    }
                    case "validate": {
                      exportSet.add("validate");
                      const visitedArgs = node.arguments.map((arg) => ts.visitNode(arg, visitor) as ts.Expression);
                      return context.factory.createCallExpression(
                        context.factory.createIdentifier(`__wiz_validate_${hash}`),
                        undefined,
                        visitedArgs
                      );
                    }
                    case "is": {
                      exportSet.add("is");
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

                      const openApiOperations = collectOperations(
                        node.arguments[1],
                        checker,
                        sourceFile
                      );

                      // The leading type argument is often `[]` when every type
                      // arrives through operations, so the operations must take
                      // part in the module key or distinct documents collide.
                      const opHash = openApiOperations.length > 0
                        ? `${hash}_ops_${fnv1a(JSON.stringify(openApiOperations.map(operationKeyPart)))}`
                        : hash;

                      registerType(opHash, ir, {
                        openApiTypes,
                        openApiVersion,
                        openApiOperations,
                      });

                      if (!virtualImports.has(opHash)) {
                        virtualImports.set(opHash, new Set());
                      }
                      virtualImports.get(opHash)!.add("openapiSchema");

                      // Operations are compile-time only: they are folded into
                      // the virtual module, so only the base document survives.
                      const baseArg = node.arguments[0]
                        ? (ts.visitNode(node.arguments[0], visitor) as ts.Expression)
                        : undefined;
                      return context.factory.createCallExpression(
                        context.factory.createIdentifier(`__wiz_openapiSchema_${opHash}`),
                        undefined,
                        baseArg ? [baseArg] : []
                      );
                    }
                    case "encodeProto": {
                      exportSet.add("encodeProto");
                      const visitedArgs = node.arguments.map((arg) => ts.visitNode(arg, visitor) as ts.Expression);
                      return context.factory.createCallExpression(
                        context.factory.createIdentifier(`__wiz_encodeProto_${hash}`),
                        undefined,
                        visitedArgs
                      );
                    }
                    case "decodeProto": {
                      exportSet.add("decodeProto");
                      const visitedArgs = node.arguments.map((arg) => ts.visitNode(arg, visitor) as ts.Expression);
                      return context.factory.createCallExpression(
                        context.factory.createIdentifier(`__wiz_decodeProto_${hash}`),
                        undefined,
                        visitedArgs
                      );
                    }
                    case "protobufSchema": {
                      exportSet.add("protobufSchema");

                      const protobufSchemaTypes: Array<{ name: string; ir: ReturnType<typeof extractTypeIR> }> = [];
                      let typeArgs: readonly ts.Type[] = [];
                      if (checker.isTupleType(tsType)) {
                        typeArgs = checker.getTypeArguments(tsType as ts.TypeReference);
                      } else {
                        typeArgs = [tsType];
                      }

                      for (const elemType of typeArgs) {
                        const elemIR = extractTypeIR(elemType, checker);
                        const sym = elemType.aliasSymbol ?? elemType.symbol;
                        const name = sym && !sym.name.startsWith("__") ? sym.name : (elemIR.name ?? `Schema_${protobufSchemaTypes.length + 1}`);
                        protobufSchemaTypes.push({ name, ir: elemIR });
                      }

                      registerType(hash, ir, { protobufSchemaTypes });

                      const visitedArgs = node.arguments.map((arg) => ts.visitNode(arg, visitor) as ts.Expression);
                      return context.factory.createCallExpression(
                        context.factory.createIdentifier(`__wiz_protobufSchema_${hash}`),
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
          return { contents: fileContents, loader };
        }

        // Generate import statements for virtual modules
        const importStatements: ts.Statement[] = [];
        for (const [hash, exportsSet] of virtualImports.entries()) {
          const specifiers: ts.ImportSpecifier[] = [];

          if (exportsSet.has("keys")) {
            specifiers.push(
              contextSpecifier("keys", `__wiz_keys_${hash}`)
            );
          }
          if (exportsSet.has("requiredKeys")) {
            specifiers.push(
              contextSpecifier("requiredKeys", `__wiz_reqKeys_${hash}`)
            );
          }
          if (exportsSet.has("optionalKeys")) {
            specifiers.push(
              contextSpecifier("optionalKeys", `__wiz_optKeys_${hash}`)
            );
          }
          if (exportsSet.has("schema_draft2020")) {
            specifiers.push(
              contextSpecifier("schema_draft2020", `__wiz_schema_${hash}`)
            );
          }
          if (exportsSet.has("schema_draft07")) {
            specifiers.push(
              contextSpecifier("schema_draft07", `__wiz_schema07_${hash}`)
            );
          }
          if (exportsSet.has("validate")) {
            specifiers.push(
              contextSpecifier("validate", `__wiz_validate_${hash}`)
            );
          }
          if (exportsSet.has("is")) {
            specifiers.push(
              contextSpecifier("is", `__wiz_is_${hash}`)
            );
          }
          if (exportsSet.has("openapiSchema")) {
            specifiers.push(
              contextSpecifier("openapiSchema", `__wiz_openapiSchema_${hash}`)
            );
          }
          if (exportsSet.has("encodeProto")) {
            specifiers.push(
              contextSpecifier("encodeProto", `__wiz_encodeProto_${hash}`)
            );
          }
          if (exportsSet.has("decodeProto")) {
            specifiers.push(
              contextSpecifier("decodeProto", `__wiz_decodeProto_${hash}`)
            );
          }
          if (exportsSet.has("protobufSchema")) {
            specifiers.push(
              contextSpecifier("protobufSchema", `__wiz_protobufSchema_${hash}`)
            );
          }

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
          [...importStatements, ...transformedSourceFile.statements]
        );

        const printer = ts.createPrinter({ removeComments: false });
        const transformedCode = printer.printFile(finalSourceFile);
        result.dispose();

        return { contents: transformedCode, loader };
      });
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
