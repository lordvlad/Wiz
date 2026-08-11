// @wiz-ignore
import { describe, expect, test } from "bun:test";
import { generateOpenApiSchemaCode } from "../src/generators/openapi.ts";
import { getIRForSource as extractIR } from "./helpers.ts";

function getIRForSource(sourceText: string, typeName: string) {
  return { name: typeName, ir: extractIR(sourceText, typeName) };
}

describe("OpenAPI Schema Generator", () => {
  test("generates OpenAPI 3.0 schema with components and merged baseSchema", () => {
    const user = getIRForSource(
      `
      export interface User {
        id: string;
        name: string;
      }
    `,
      "User"
    );

    const book = getIRForSource(
      `
      export interface Book {
        title: string;
        price: number;
      }
    `,
      "Book"
    );

    const code = generateOpenApiSchemaCode([user, book], "3.0");

    const codeWithoutExport = code.replace(/export /g, "");
    const fnModule = new Function(`${codeWithoutExport}\nreturn openapiSchema;`)();

    const result = fnModule({
      info: {
        title: "Books API",
        version: "1.0.0",
        server: "http://books.com",
      },
    });

    expect(result.openapi).toBe("3.0.3");
    expect(result.info).toEqual({
      title: "Books API",
      version: "1.0.0",
      server: "http://books.com",
    });
    expect(result.components).toBeDefined();
    expect(result.components.schemas).toBeDefined();
    expect(result.components.schemas.User).toBeDefined();
    expect(result.components.schemas.User.properties.id.type).toBe("string");
    expect(result.components.schemas.Book).toBeDefined();
    expect(result.components.schemas.Book.properties.price.type).toBe("number");
  });

  test("generates OpenAPI 3.1 schema", () => {
    const user = getIRForSource(
      `
      export interface User {
        id: string;
        bio?: string;
      }
    `,
      "User"
    );

    const code = generateOpenApiSchemaCode([user], "3.1");

    const codeWithoutExport = code.replace(/export /g, "");
    const fnModule = new Function(`${codeWithoutExport}\nreturn openapiSchema;`)();

    const result = fnModule();
    expect(result.openapi).toBe("3.1.0");
    expect(result.components.schemas.User).toBeDefined();
  });

  test("transitively includes referenced types in openapiSchema", () => {
    const sourceCode = `
      export interface Book {
        id: number;
        title: string;
      }
      export interface User {
        id: number;
        books: Book[];
      }
    `;

    const user = getIRForSource(sourceCode, "User");
    const book = getIRForSource(sourceCode, "Book");

    // openapiSchema<[User]>
    const codeUserOnly = generateOpenApiSchemaCode([user], "3.0");
    const fn1 = new Function(
      `${codeUserOnly.replace(/export /g, "")}\nreturn openapiSchema;`
    )();
    const doc1 = fn1();

    // openapiSchema<[User, Book]>
    const codeUserAndBook = generateOpenApiSchemaCode([user, book], "3.0");
    const fn2 = new Function(
      `${codeUserAndBook.replace(/export /g, "")}\nreturn openapiSchema;`
    )();
    const doc2 = fn2();

    expect(doc1).toEqual(doc2);
    expect(doc1.components.schemas.User).toBeDefined();
    expect(doc1.components.schemas.Book).toBeDefined();
    expect(doc1.components.schemas.User.properties.books.items).toEqual({
      $ref: "#/components/schemas/Book",
    });
  });
});
