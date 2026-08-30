import ts from "typescript";
import { extractTypeIR } from "../src/extractors/typescript.ts";
import { flattenObjectProperties, type TypeIR } from "../src/types.ts";
import { isHttpMethod } from "../src/ir/service.ts";
import type {
  HttpMethodName,
  HttpRequestIR,
  HttpServiceMethodIR,
  ParameterIR,
  ServiceIR,
  ServiceMethodIR,
} from "../src/ir/service.ts";

/**
 * Narrows an extracted method to the HTTP shape.
 *
 * `ServiceMethodIR` covers gRPC too now, and a test asserting on paths, query
 * parameters or status codes is asserting about HTTP; this fails loudly rather
 * than letting an assertion read `undefined` off the wrong protocol.
 */
export function asHttp(method: ServiceMethodIR): HttpServiceMethodIR {
  if (!isHttpMethod(method)) {
    throw new Error(`expected an HTTP method, got '${method.protocol}'`);
  }
  return method;
}

const VIRTUAL_ENTRY = "test.ts";

const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  strict: true,
  skipLibCheck: true,
};

/**
 * Building a `ts.Program` is what this suite actually spends its time on, so
 * two caches sit in front of it.
 *
 * `libFileCache` shares parsed declaration files: the first program in a
 * process spends ~1.3s on `lib.d.ts` alone, and every fixture would otherwise
 * pay it again. `lastProgram` goes further — handing the previous program to
 * TypeScript as `oldProgram` lets it reuse the binding of every file that did
 * not change, which is all of them but the fixture entry. Measured on this
 * suite: 126ms per program without it, 10ms with. It only works because every
 * fixture compiles under the same entry name.
 */
const libFileCache = new Map<string, ts.SourceFile | undefined>();
const programCache = new Map<string, ts.Program>();
let lastProgram: ts.Program | undefined;

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

  const program = ts.createProgram(
    [VIRTUAL_ENTRY],
    compilerOptions,
    host,
    lastProgram
  );
  lastProgram = program;
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
}): HttpServiceMethodIR {
  const request: HttpRequestIR = { protocol: "http" };
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
