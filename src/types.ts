import type * as ts from "typescript";
import { computeTypeIRHash, type TypeIR } from "./ir/types.ts";

export * from "./ir/types.ts";

/**
 * Derives a deterministic virtual module key for a type.
 *
 * Primary Strategy: Symbol Identity for named/alias types.
 * Form: fnv1a(sourceFileName + ":" + symbolName [+ "<" + argKeys + ">"])
 *
 * Secondary Strategy: Structural Fallback for anonymous/inline types using computeTypeIRHash(ir).
 */
export function getTypeKey(type: ts.Type, checker: ts.TypeChecker, ir: TypeIR): string {
  const symbol = type.aliasSymbol ?? type.symbol;
  if (symbol && symbol.name && !symbol.name.startsWith("__")) {
    const decls = symbol.getDeclarations();
    if (decls && decls.length > 0) {
      const sourceFile = decls[0]!.getSourceFile();
      const fileName = sourceFile ? sourceFile.fileName : "";
      if (fileName && !fileName.includes("node_modules/typescript/lib")) {
        let keyStr = `${fileName}:${symbol.name}`;
        // Handle generic type arguments
        const typeArgs = type.aliasTypeArguments ?? (type as ts.TypeReference).typeArguments;
        if (typeArgs && typeArgs.length > 0) {
          const argKeys = typeArgs.map((arg) => {
            const argSym = arg.aliasSymbol ?? arg.symbol;
            if (argSym && argSym.name && argSym.getDeclarations()?.[0]) {
              const sf = argSym.getDeclarations()![0]!.getSourceFile();
              return `${sf ? sf.fileName : ""}:${argSym.name}`;
            }
            return checker.typeToString(arg);
          });
          keyStr += `<${argKeys.join(",")}>`;
        }
        return computeTypeIRHash(ir) + "_" + keyStr.replace(/[^a-zA-Z0-9_]/g, "_");
      }
    }
  }

  return computeTypeIRHash(ir);
}
