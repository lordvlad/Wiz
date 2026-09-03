// @wiz-ignore
import { describe, expect, test } from "bun:test";
import { generateKeysCode } from "../src/generators/keys.ts";
import { generateValidatorCode } from "../src/generators/validator.ts";
import type { TypeIR } from "../src/ir/types.ts";
import { evalModule } from "./helpers.ts";
import { transformSource } from "../src/plugin.ts";
import { silentLogger } from "../src/logger.ts";
import { assert, deepKeysOf } from "../src/index.ts";

const str = (id: string): TypeIR => ({ id, kind: "primitive", type: "string" });

const deepType: TypeIR = {
  id: "user",
  kind: "object",
  properties: [
    { name: "id", optional: false, readonly: false, type: str("p1") },
    { name: "name", optional: false, readonly: false, type: str("p2") },
    {
      name: "settings",
      optional: true,
      readonly: false,
      type: {
        id: "s",
        kind: "object",
        properties: [
          { name: "theme", optional: false, readonly: false, type: str("p3") },
          {
            name: "notifications",
            optional: true,
            readonly: false,
            type: {
              id: "n",
              kind: "object",
              properties: [
                { name: "email", optional: false, readonly: false, type: str("p4") },
              ],
            },
          },
        ],
      },
    },
  ],
};

describe("deepKeysOf extraction", () => {
  const code = generateKeysCode(deepType);
  const mod = evalModule<{
    deepKeys: (options?: { maxDepth?: number }) => string[];
  }>(code);

  test("extracts dot-separated deep keys up to default maxDepth of 5", () => {
    expect(mod.deepKeys()).toEqual([
      "id",
      "name",
      "settings.theme",
      "settings.notifications.email",
    ]);
  });

  test("maxDepth: 2 limits recursion to 2 levels and omits deeper nested children", () => {
    expect(mod.deepKeys({ maxDepth: 2 })).toEqual([
      "id",
      "name",
      "settings.theme",
      "settings.notifications",
    ]);
  });

  test("maxDepth: 1 limits recursion to top level", () => {
    expect(mod.deepKeys({ maxDepth: 1 })).toEqual(["id", "name", "settings"]);
  });

  test("handles recursive types gracefully", () => {
    const declared = new Map<string, TypeIR>();
    const nodeIR: TypeIR = {
      id: "Node",
      kind: "object",
      name: "Node",
      properties: [
        { name: "val", optional: false, readonly: false, type: str("p1") },
        {
          name: "next",
          optional: true,
          readonly: false,
          type: { id: "ref", kind: "ref", targetId: "Node" },
        },
      ],
    };
    declared.set("Node", nodeIR);

    const nodeCode = generateKeysCode(nodeIR, declared);
    const nodeMod = evalModule<{ deepKeys: () => string[] }>(nodeCode);

    expect(nodeMod.deepKeys()).toEqual(["val", "next"]);
  });
});

describe("assert validator function", () => {
  const code = generateValidatorCode(deepType);
  const mod = evalModule<{
    assert: (arg: unknown, options?: unknown) => void;
  }>(code);

  test("assert passes cleanly on valid value", () => {
    expect(() =>
      mod.assert({
        id: "u1",
        name: "Alice",
        settings: { theme: "dark", notifications: { email: "a@b.co" } },
      })
    ).not.toThrow();
  });

  test("assert throws Error with name AssertError and errors property on invalid value", () => {
    let thrown: (Error & { errors?: unknown[] }) | undefined;
    try {
      mod.assert({ id: 123 });
    } catch (err) {
      thrown = err as Error & { errors?: unknown[] };
    }

    expect(thrown).toBeDefined();
    expect(thrown!.name).toBe("AssertError");
    expect(thrown!.errors).toBeDefined();
    expect(thrown!.errors!.length).toBeGreaterThan(0);
    expect(thrown!.message).toContain("Assertion failed");
  });
});

/**
 * Both helpers are rewritten by the plugin, so nothing above reaches the
 * public entrypoint. Without a stub there, `import { assert } from "wiz"` is a
 * type error and a `ReferenceError` — documented API that cannot be imported.
 */
describe("public entrypoint", () => {
  test("deepKeysOf and assert are importable and inert without the plugin", () => {
    expect(() => deepKeysOf<{ a: string }>()).toThrow("without active Bun plugin");
    expect(() => assert<{ a: string }>({})).toThrow("without active Bun plugin");
  });

  test("the plugin rewrites both when imported from wiz", () => {
    const source = `
      import { deepKeysOf, assert } from "./src/index.ts";

      interface Settings { theme: string }
      interface User { id: string; settings: Settings }

      export const keys = deepKeysOf<User>({ maxDepth: 2 });
      export function check(value: unknown) {
        assert<User>(value);
      }
    `;

    const res = transformSource({ path: "app.ts", contents: source, logger: silentLogger });
    expect(res.code).toContain("deepKeys as __wiz_deepKeys_");
    expect(res.code).toContain("assert as __wiz_assert_");

    const mod = evalModule<{
      deepKeys(options?: { maxDepth?: number }): string[];
      assert(arg: unknown): void;
    }>(Array.from(res.modules.values())[0]!.files["index.js"]!);

    expect(mod.deepKeys({ maxDepth: 2 })).toEqual(["id", "settings.theme"]);
    expect(() => mod.assert({ id: "1", settings: { theme: "dark" } })).not.toThrow();
    expect(() => mod.assert({ id: 1 })).toThrow("Assertion failed");
  });
});
