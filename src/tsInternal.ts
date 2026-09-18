import ts from "typescript";

/**
 * Declares TypeScript compiler internal interfaces that are not part of the
 * public `typescript` .d.ts surface, so accesses are isolated, strictly typed,
 * and guarded by tests.
 */

export interface InternalSourceFile extends ts.SourceFile {
  locals?: ts.SymbolTable;
  symbol?: ts.Symbol;
}

export interface InternalDeclaration extends ts.Declaration {
  symbol?: ts.Symbol;
}

/**
 * Looks up a symbol in a SourceFile's internal locals or exports table.
 */
export function getSourceFileInternalSymbol(
  sourceFile: ts.SourceFile,
  name: string
): ts.Symbol | undefined {
  const internalSf = sourceFile as InternalSourceFile;
  const escapedName = ts.escapeLeadingUnderscores(name);
  return (
    internalSf.locals?.get(escapedName) ??
    internalSf.symbol?.exports?.get(escapedName)
  );
}

/**
 * Resolves a symbol for a signature declaration, using public API first
 * (`checker.getSymbolAtLocation`) before falling back to `Declaration.symbol`.
 */
export function getSignatureSymbol(
  sig: ts.Signature,
  checker: ts.TypeChecker
): ts.Symbol | undefined {
  const decl = sig.declaration;
  if (!decl) return undefined;

  const nameNode = ts.getNameOfDeclaration(decl);
  if (nameNode) {
    const sym = checker.getSymbolAtLocation(nameNode);
    if (sym) return sym;
  }

  const internalDecl = decl as InternalDeclaration;
  return internalDecl.symbol;
}
