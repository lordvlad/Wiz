import ts from "typescript";
import { extractTypeIR } from "../src/ir/extractor.ts";
import type { TypeIR } from "../src/types.ts";

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
  ];

  const collected = exportNames
    .map((name) => `${name}: typeof ${name} !== "undefined" ? ${name} : undefined`)
    .join(", ");

  return new Function(
    `${code.replace(/export /g, "")}\nreturn { ${collected} };`
  )() as T;
}
