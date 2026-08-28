import ts from "typescript";
import { extractTypeIR } from "../src/extractors/typescript.ts";
import { flattenObjectProperties, type TypeIR } from "../src/types.ts";
import type {
  HttpMethodName,
  ParameterIR,
  ServiceIR,
  ServiceMethodIR,
  ServiceMethodRequestIR,
} from "../src/ir/service.ts";

const VIRTUAL_ENTRY = "test.ts";

const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  strict: true,
  skipLibCheck: true,
};

/**
 * Parsing `lib.d.ts` dominates the cost of `ts.createProgram`, and every test
 * fixture would otherwise pay it again. Declaration files never change during a
 * run, so their `SourceFile` objects are shared across every program we build.
 */
const libFileCache = new Map<string, ts.SourceFile | undefined>();
const programCache = new Map<string, ts.Program>();
process.on('exit', () => { if ((globalThis as any).__progs) console.error(`__PROGRAMS__ ${(globalThis as any).__progs} ${programCache.size}`); });

function programFor(sourceText: string): ts.Program {
  const cached = programCache.get(sourceText);
  if (cached) return cached;

  const host = ts.createCompilerHost(compilerOptions);
  const originalReadFile = host.readFile.bind(host);
  const originalGetSourceFile = host.getSourceFile.bind(host);

  host.readFile = (fileName: string) =>
    fileName === VIRTUAL_ENTRY ? sourceText : originalReadFile(fileName);

  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    // Only declaration files are shareable; the entry differs per fixture.
    if (fileName === VIRTUAL_ENTRY) {
      return originalGetSourceFile(
        fileName,
        languageVersion,
        onError,
        shouldCreate
      );
    }
    if (!libFileCache.has(fileName)) {
      libFileCache.set(
        fileName,
        originalGetSourceFile(fileName, languageVersion, onError, shouldCreate)
      );
    }
    return libFileCache.get(fileName);
  };

  (globalThis as any).__progs = ((globalThis as any).__progs ?? 0) + 1;
  process.on?.('exit', () => {});
  const program = ts.createProgram([VIRTUAL_ENTRY], compilerOptions, host);
  programCache.set(sourceText, program);
  return program;
}

function declarationNamed(sourceFile: ts.SourceFile, typeName: string) {
  return sourceFile.statements.find(
    (s) =>
      (ts.isInterfaceDeclaration(s) ||
        ts.isTypeAliasDeclaration(s) ||
        ts.isEnumDeclaration(s)) &&
      s.name.text === typeName
  );
}

export function getIRForSource(sourceText: string, typeName: string): TypeIR {
  const program = programFor(sourceText);
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(VIRTUAL_ENTRY)!;

  const statement = declarationNamed(sourceFile, typeName);
  if (!statement) {
    throw new Error(`Type '${typeName}' not found in source text.`);
  }

  return extractTypeIR(checker.getTypeAtLocation(statement), checker);
}

export function getIRsForSource<T extends string>(
  sourceText: string,
  typeNames: T[]
): Record<T, { name: string; ir: TypeIR }> {
  const program = programFor(sourceText);
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(VIRTUAL_ENTRY)!;

  const result: Record<string, { name: string; ir: TypeIR }> = {};
  for (const name of typeNames) {
    const statement = declarationNamed(sourceFile, name);
    if (!statement) {
      throw new Error(`Type '${name}' not found in source text.`);
    }
    result[name] = {
      name,
      ir: extractTypeIR(checker.getTypeAtLocation(statement), checker),
    };
  }

  return result as Record<T, { name: string; ir: TypeIR }>;
}

/**
 * Runs a generated virtual module and hands back its exports. Generators emit
 * ESM source, which `new Function` cannot parse, so `export` is stripped and the
 * known export names are collected explicitly.
 */
export function evalModule<T>(code: string): T {
  const exportNames = [
    "keys",
    "requiredKeys",
    "optionalKeys",
    "schema_draft2020",
    "schema_draft07",
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
  ];

  const collected = exportNames
    .map((name) => `${name}: typeof ${name} !== "undefined" ? ${name} : undefined`)
    .join(", ");

  return new Function(
    `${code.replace(/export /g, "")}\nreturn { ${collected} };`
  )() as T;
}
/**
 * Turns a fixture interface's IR into the flat `ParameterIR[]` the IR now
 * carries, the same way `src/plugin.ts` does for `op<{ … }>` slots.
 */
export function params(
  ir: TypeIR,
  location: ParameterIR["in"]
): ParameterIR[] {
  return flattenObjectProperties(ir).map((property) => ({
    name: property.name,
    in: location,
    required: location === "path" ? true : !property.optional,
    type: property.type,
  }));
}

/** Concise `ServiceMethodIR` builder for generator tests. */
export function httpMethod(spec: {
  method: string;
  path: string;
  parameters?: ParameterIR[];
  body?: TypeIR;
  response?: TypeIR;
  status?: number;
  overrides?: string;
}): ServiceMethodIR {
  const request: ServiceMethodRequestIR = { protocol: "http" };
  if (spec.parameters && spec.parameters.length > 0) {
    request.parameters = spec.parameters;
  }
  if (spec.body) {
    request.body = [{ mimetype: "application/json", content: spec.body }];
  }

  return {
    kind: "serviceMethod",
    protocol: "http",
    address: {
      protocol: "http",
      method: spec.method.toUpperCase() as HttpMethodName,
      path: spec.path,
    },
    request,
    responses: [
      spec.response
        ? {
            protocol: "http",
            status: spec.status ?? 200,
            body: [{ mimetype: "application/json", content: spec.response }],
          }
        : { protocol: "http", status: spec.status ?? 204 },
    ],
    overrides: spec.overrides,
  };
}

export function service(methods: ServiceMethodIR[]): ServiceIR {
  return { kind: "service", methods };
}
