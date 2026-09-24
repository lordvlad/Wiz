// @wiz-ignore
import { beforeEach, describe, expect, test } from "bun:test";
import { VIRTUAL_ENTRY } from "../src/generators/virtualGenerator.ts";
import { silentLogger } from "../src/logger.ts";
import { transformSource, type TransformResult } from "../src/plugin.ts";
import { clearTypeRegistry } from "../src/registry.ts";

/**
 * A virtual module's identity is its type key *plus* the generator payload.
 *
 * These are regressions for a silent miscompile: the registry used to key on
 * the type alone and overwrite the entry in place when a payload arrived, so
 * two callsites that shared a type but differed in payload collided and
 * whichever was transformed last redefined the other.
 */
function transform(contents: string, path = "collide.ts") {
    return transformSource({ path, contents, logger: silentLogger });
}

/** The registry outlives one transform, so each test starts from an empty one. */
beforeEach(() => {
    clearTypeRegistry();
});

const moduleCode = (result: TransformResult, marker: string): string => {
    const found = [...result.modules.values()].find((m) => m.files[VIRTUAL_ENTRY]?.includes(marker));
    if (!found) {
        throw new Error(`no generated module contains ${marker}`);
    }
    return found.files[VIRTUAL_ENTRY]!;
};

const USER = `
  export interface User {
    id: string;
    name: string;
  }
`;

describe("virtual module identity", () => {
    test("two OpenAPI dialects of one type are two modules", () => {
        const result = transform(`
      import { openapiSchema } from "wiz";
      ${USER}
      export const v30 = openapiSchema<[User], "3.0">();
      export const v31 = openapiSchema<[User], "3.1">();
    `);

        const documents = [...result.modules.values()].filter((m) => m.files[VIRTUAL_ENTRY]?.includes("openapiSchema"));
        expect(documents).toHaveLength(2);

        const versions = documents.map((m) => m.files[VIRTUAL_ENTRY]?.match(/openapi:\s*"(3\.[01]\.\d)"/)?.[1]).sort();
        expect(versions).toEqual(["3.0.3", "3.1.0"]);
    });

    test("the same type with different operations is two modules", () => {
        const result = transform(`
      import { openapiSchema } from "wiz";
      ${USER}
      export const a = openapiSchema<[]>({}, [
        openapiSchema.get<never, never, User, never>("/users"),
      ]);
      export const b = openapiSchema<[]>({}, [
        openapiSchema.get<never, never, User, never>("/people"),
      ]);
    `);

        const paths = [...result.modules.values()]
            .filter((m) => m.files[VIRTUAL_ENTRY]?.includes("openapiSchema"))
            .map((m) => (m.files[VIRTUAL_ENTRY]?.includes('"/users"') ? "/users" : "/people"))
            .sort();
        expect(paths).toEqual(["/people", "/users"]);
    });

    test("a codec and a schema of one type share the type key, not the module", () => {
        const result = transform(`
      import { encodeProto, protobufSchema } from "wiz";
      ${USER}
      export const proto = protobufSchema<[User]>();
      export const encode = (v: User, b: Uint8Array) => encodeProto<User>(v, b);
    `);

        // The schema payload earns its own module; the codec keeps the bare type
        // key. Both must exist, and only one may carry the .proto text.
        const withSchema = [...result.modules.values()].filter((m) =>
            m.files[VIRTUAL_ENTRY]?.includes("export function protobufSchema"),
        );
        expect(withSchema).toHaveLength(1);
        expect(result.modules.size).toBe(2);
    });

    test("identical callsites still share one module", () => {
        const result = transform(`
      import { openapiSchema } from "wiz";
      ${USER}
      export const a = openapiSchema<[User], "3.1">();
      export const b = openapiSchema<[User], "3.1">();
    `);
        expect(result.modules.size).toBe(1);
    });

    /**
     * Everything below differs only in a field the key used to drop, so the
     * second transform was handed the first one's module.
     */
    test("a changed doc comment is a new module, not the old one", () => {
        const source = (doc: string) => `
      import { schema } from "wiz";
      /** ${doc} */
      export interface Doc {
        id: string;
      }
      export const s = jsonSchema<Doc>();
    `;

        const first = transform(source("first revision"));
        const second = transform(source("second revision"));

        expect(moduleCode(first, "schema_draft2020")).toContain("first revision");
        expect(moduleCode(second, "schema_draft2020")).toContain("second revision");
    });

    test("a nested component name is part of the document's identity", () => {
        const source = (name: string) => `
      import { openapiSchema } from "wiz";
      export interface ${name} {
        id: string;
      }
      export const doc = openapiSchema<{ profile: ${name} }>({});
    `;

        // Same path and same structure: only the nested schema name differs, and
        // it decides both the `$ref` and the `components.schemas` key.
        const users = transform(source("User"));
        const admins = transform(source("Admin"));

        expect(moduleCode(users, "openapiSchema")).toContain('"User"');
        const adminDoc = moduleCode(admins, "openapiSchema");
        expect(adminDoc).toContain('"Admin"');
        expect(adminDoc).not.toContain('"User"');
    });

    test("a changed field number is a new protobuf schema", () => {
        const source = (fieldNumber: number) => `
      import { protobufSchema } from "wiz";
      export interface Wire {
        /** @fieldNumber ${fieldNumber} */
        id: string;
      }
      export const proto = protobufSchema<[Wire]>();
    `;

        const one = transform(source(1));
        const two = transform(source(2));

        // The schema module carries the wire numbers as data and renders the
        // `.proto` text from them, so that is where the contract is observable.
        const marker = "export function protobufSchema";
        expect(moduleCode(one, marker)).toContain('"fieldNumber": 1');
        expect(moduleCode(two, marker)).toContain('"fieldNumber": 2');
    });
});
