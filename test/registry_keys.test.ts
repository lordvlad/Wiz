// @wiz-ignore
import { describe, expect, test } from "bun:test";
import { transformSource } from "../src/plugin.ts";
import { silentLogger } from "../src/logger.ts";

/**
 * A virtual module's identity is its type key *plus* the generator payload.
 *
 * These are regressions for a silent miscompile: the registry used to key on
 * the type alone and overwrite the entry in place when a payload arrived, so
 * two callsites that shared a type but differed in payload collided and
 * whichever was transformed last redefined the other.
 */
function transform(contents: string) {
  return transformSource({
    path: "collide.ts",
    contents,
    logger: silentLogger,
  });
}

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

    const documents = [...result.modules.values()].filter((m) =>
      m.code.includes("openapiSchema")
    );
    expect(documents).toHaveLength(2);

    const versions = documents
      .map((m) => m.code.match(/openapi:\s*"(3\.[01]\.\d)"/)?.[1])
      .sort();
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
      .filter((m) => m.code.includes("openapiSchema"))
      .map((m) => (m.code.includes('"/users"') ? "/users" : "/people"))
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
      m.code.includes("export function protobufSchema")
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
});
