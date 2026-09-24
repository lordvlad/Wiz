import { beforeEach, describe, expect, test } from "bun:test";
// @wiz-ignore
import { plugin } from "bun";
import { VIRTUAL_ENTRY } from "../src/generators/virtualGenerator.ts";
import { silentLogger } from "../src/logger.ts";
import { transformSource, wizPlugin } from "../src/plugin.ts";
import { clearTypeRegistry } from "../src/registry.ts";

plugin(wizPlugin());

const SOURCE = `
  import { zodSchema, keysOf } from "wiz";

  export interface User {
    /** @minLength 2 */
    id: string;
  }

  export const schema = zodSchema<User>();
`;

const transform = (contents = SOURCE, path = "zod.ts") => transformSource({ path, contents, logger: silentLogger });

beforeEach(() => {
    clearTypeRegistry();
});

describe("the zodSchema callsite", () => {
    test("becomes a call carrying the loader, so zod resolves where the file is", () => {
        const { code } = transform();

        expect(code).toContain('from "./wiz-virtual/');
        // The import is written here rather than in the virtual module, which has
        // no place on disk to resolve a package from.
        expect(code).toMatch(/__wiz_zodSchema_\w+\(\(\) => import\("zod"\)\)/);
    });

    test("the module carries the zod section", () => {
        const { modules } = transform();
        const emitted = [...modules.values()].map((m) => m.files[VIRTUAL_ENTRY] ?? "");

        expect(emitted.some((code) => code.includes("export const zodSchema"))).toBe(true);
    });

    test("wanting zod is part of the module's identity", () => {
        // The bare type and the zod one share a type key and must not share a
        // module: one carries a section the other does not.
        const { modules } = transform(`
      import { zodSchema, keysOf } from "wiz";
      export interface User { id: string }
      export const keys = keysOf<User>();
      export const schema = zodSchema<User>();
    `);

        expect(modules.size).toBe(2);

        const withZod = [...modules.values()].filter((m) =>
            (m.files[VIRTUAL_ENTRY] ?? "").includes("export const zodSchema"),
        );
        expect(withZod).toHaveLength(1);
    });
});

describe("through the real plugin", () => {
    test("the emitted schema validates against the caller's own zod", async () => {
        const mod = (await import("./fixtures/zodFixture.ts")) as {
            userZod: Promise<{
                parse(value: unknown): unknown;
                safeParse(value: unknown): { success: boolean };
            }>;
        };
        const schema = await mod.userZod;

        expect(schema.parse({ id: "ab", tags: ["x"], kind: "a" })).toEqual({
            id: "ab",
            tags: ["x"],
            kind: "a",
        });
        // `@minLength 2` came from the JSDoc, through the IR, into the schema.
        expect(schema.safeParse({ id: "a", tags: [], kind: "a" }).success).toBe(false);
        expect(schema.safeParse({ id: "ab", tags: [], kind: "z" }).success).toBe(false);
        expect(schema.safeParse({ id: "ab", tags: [], kind: "b", age: 3 }).success).toBe(true);
    });
});
