import type { BunPlugin } from "bun";
import ts from "typescript";
import { extractTypeIR } from "./extractors/typescript.ts";
import {
  collectOperations,
  collectRouteOperations,
  COMPILER_OPTIONS,
  harvestDocument,
  invalidateHarvest,
  readOpenApiVersion,
} from "./harvest.ts";
import { defaultLogger, type WizLogger } from "./logger.ts";
import { getRegisteredType, registerType } from "./registry.ts";
import {
  VIRTUAL_ENTRY,
  virtualGenerator,
  type VirtualModuleOptions,
} from "./generators/virtualGenerator.ts";
import { generate, type GeneratedFiles } from "./generators/generator.ts";
import { setupVirtualModuleLifecycle } from "./virtualPlugin.ts";
import { getTypeKey, type TypeIR } from "./types.ts";

const HELPER_FUNCTIONS = new Set([
  "openapiDocument",
  "keysOf",
  "requiredKeysOf",
  "optionalKeysOf",
  "deepKeysOf",
  "schema",
  "validate",
  "parseQuery",
  "is",
  "assert",
  "openapiSchema",
  "openRPCSchema",
  "encodeProto",
  "decodeProto",
  "protobufSchema",
  "encodeAvro",
  "decodeAvro",
  "avroSchema",
  "encodeArrow",
  "decodeArrow",
  "arrowSchema",
  "zodSchema",
  "encodeJson",
  "decodeJson",
]);

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
  deepKeys: "__wiz_deepKeys",
  schema_draft2020: "__wiz_schema",
  schema_draft07: "__wiz_schema07",
  validate: "__wiz_validate",
  parseQuery: "__wiz_parseQuery",
  is: "__wiz_is",
  assert: "__wiz_assert",
  openapiSchema: "__wiz_openapiSchema",
  openRPCSchema: "__wiz_openRPCSchema",
  encodeProto: "__wiz_encodeProto",
  decodeProto: "__wiz_decodeProto",
  protobufSchema: "__wiz_protobufSchema",
  encodeAvro: "__wiz_encodeAvro",
  decodeAvro: "__wiz_decodeAvro",
  avroSchema: "__wiz_avroSchema",
  encodeArrow: "__wiz_encodeArrow",
  decodeArrow: "__wiz_decodeArrow",
  arrowSchema: "__wiz_arrowSchema",
  zodSchema: "__wiz_zodSchema",
  encodeJson: "__wiz_encodeJson",
  decodeJson: "__wiz_decodeJson",
};

export function localAlias(exportName: string, hash: string): string {
  return `${VIRTUAL_EXPORTS[exportName]}_${hash}`;
}
/** One generated module, and the names the rewritten code takes from it. */
export interface GeneratedModule {
  /**
   * The generator's file map, keyed by mount root - the directory prefix the
   * rewritten import lives under. `index.js` is the entry whose exports the
   * callsites bind; any other file is the generator's own to import from it.
   */
  files: GeneratedFiles;
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
  /** Generated modules by mount root, the prefix `code`'s imports start with. */
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
  invalidateHarvest(path);

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
          const targetObj = expression.expression;
          if (ts.isIdentifier(targetObj) && targetObj.text === "openapiSchema") {
            fnName = expression.name.text;
          }
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
              case "deepKeysOf": {
                wantExport("deepKeys");
                const visitedArgs = node.arguments.map((arg) => ts.visitNode(arg, visitor) as ts.Expression);
                return context.factory.createCallExpression(
                  context.factory.createIdentifier(`__wiz_deepKeys_${hash}`),
                  undefined,
                  visitedArgs
                );
              }
              case "zodSchema": {
                // A payload, not a bare export: the module's content depends
                // on wanting zod at all, so the key must too.
                const key = registerPayload("zodSchema", { zod: true });
                // The loader is written here, in the consumer's own file,
                // because that is where `zod` resolves: a virtual module has
                // no place on disk to resolve a package from. It stays a
                // dynamic import, so zod loads on first use and never if the
                // schema goes unused.
                const loader = context.factory.createArrowFunction(
                  undefined,
                  undefined,
                  [],
                  undefined,
                  context.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
                  context.factory.createCallExpression(
                    context.factory.createToken(
                      ts.SyntaxKind.ImportKeyword
                    ) as unknown as ts.Expression,
                    undefined,
                    [context.factory.createStringLiteral("zod")]
                  )
                );
                return context.factory.createCallExpression(
                  context.factory.createIdentifier(`__wiz_zodSchema_${key}`),
                  undefined,
                  [loader]
                );
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
              case "parseQuery": {
                wantExport("parseQuery");
                const visitedArgs = node.arguments.map((arg) => ts.visitNode(arg, visitor) as ts.Expression);
                return context.factory.createCallExpression(
                  context.factory.createIdentifier(`__wiz_parseQuery_${hash}`),
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
              case "assert": {
                wantExport("assert");
                const visitedArgs = node.arguments.map((arg) => ts.visitNode(arg, visitor) as ts.Expression);
                return context.factory.createCallExpression(
                  context.factory.createIdentifier(`__wiz_assert_${hash}`),
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
              case "openRPCSchema": {
                const openRpcTypes: Array<{ name: string; ir: TypeIR }> = [];
                let typeArgs: readonly ts.Type[] = [];
                if (checker.isTupleType(tsType)) {
                  typeArgs = checker.getTypeArguments(tsType as ts.TypeReference);
                } else if (tsType) {
                  typeArgs = [tsType];
                }

                for (const elemType of typeArgs) {
                  const elemIR = extractTypeIR(elemType, checker);
                  const sym = elemType.aliasSymbol ?? elemType.symbol;
                  const name = sym && !sym.name.startsWith("__") ? sym.name : (elemIR.name ?? `Schema_${openRpcTypes.length + 1}`);
                  openRpcTypes.push({ name, ir: elemIR });
                }

                const key = registerPayload("openRPCSchema", {
                  openRpcTypes,
                });

                const baseArg = node.arguments[0]
                  ? (ts.visitNode(node.arguments[0], visitor) as ts.Expression)
                  : undefined;
                return context.factory.createCallExpression(
                  context.factory.createIdentifier(`__wiz_openRPCSchema_${key}`),
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
              case "encodeJson": {
                wantExport("encodeJson");
                const visitedArgs = node.arguments.map((arg) => ts.visitNode(arg, visitor) as ts.Expression);
                return context.factory.createCallExpression(
                  context.factory.createIdentifier(`__wiz_encodeJson_${hash}`),
                  undefined,
                  visitedArgs
                );
              }
              case "decodeJson": {
                wantExport("decodeJson");
                const visitedArgs = node.arguments.map((arg) => ts.visitNode(arg, visitor) as ts.Expression);
                return context.factory.createCallExpression(
                  context.factory.createIdentifier(`__wiz_decodeJson_${hash}`),
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
        ts.factory.createStringLiteral(`./wiz-virtual/${hash}/${VIRTUAL_ENTRY}`)
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
    // by a person, so it is regenerated with only what this file uses - through
    // the same generator the registry ran, not a second emission path.
    const files = inline
      ? generate(entry.ir, virtualGenerator, { ...entry.options, only: exports })
      : entry.files;

    modules.set(`./wiz-virtual/${hash}`, { files, exports, hash });
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
