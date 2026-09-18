// @wiz-ignore
import { describe, expect, test } from "bun:test";
import ts from "typescript";
import {
  getSourceFileInternalSymbol,
  getSignatureSymbol,
  type InternalSourceFile,
  type InternalDeclaration,
} from "../src/tsInternal.ts";

describe("TypeScript internal property quarantine", () => {
  test("asserts internal SourceFile and Declaration symbol properties exist on a real TypeScript program", () => {
    const sourceText = `
      export interface User {
        id: string;
      }
      export function getUser(id: string): User {
        return { id };
      }
    `;

    const sourceFile = ts.createSourceFile(
      "test.ts",
      sourceText,
      ts.ScriptTarget.Latest,
      true
    );

    const compilerHost = {
      getSourceFile: (fileName: string) =>
        fileName === "test.ts" ? sourceFile : undefined,
      writeFile: () => {},
      getDefaultLibFileName: () => "lib.d.ts",
      useCaseSensitiveFileNames: () => true,
      getCanonicalFileName: (fileName: string) => fileName,
      getCurrentDirectory: () => "",
      getNewLine: () => "\n",
      fileExists: (fileName: string) => fileName === "test.ts",
      readFile: (fileName: string) =>
        fileName === "test.ts" ? sourceText : undefined,
    };

    const program = ts.createProgram(["test.ts"], {}, compilerHost);
    const checker = program.getTypeChecker();

    const sf = program.getSourceFile("test.ts") as InternalSourceFile;
    expect(sf).toBeDefined();

    // Verify SourceFile.locals or symbol lookup
    const userSym = getSourceFileInternalSymbol(sf, "User");
    expect(userSym).toBeDefined();
    expect(userSym?.name).toBe("User");

    // Verify Signature.declaration symbol extraction
    const getUserSym = getSourceFileInternalSymbol(sf, "getUser");
    expect(getUserSym).toBeDefined();
    const decl = getUserSym?.declarations?.[0];
    expect(decl).toBeDefined();

    const getUserType = checker.getTypeOfSymbolAtLocation(getUserSym!, decl!);
    const signatures = getUserType.getCallSignatures();
    expect(signatures.length).toBeGreaterThan(0);

    const sigSym = getSignatureSymbol(signatures[0]!, checker);
    expect(sigSym).toBeDefined();
    expect(sigSym?.name).toBe("getUser");
  });
});
