// @wiz-ignore
import { describe, expect, test } from "bun:test";
import {
  is,
  keysOf,
  openapiSchema,
  optionalKeysOf,
  PluginInactiveError,
  requiredKeysOf,
  schema,
  validate,
} from "../src/index.ts";

interface User {
  id: string;
  name: string;
  age?: number;
}

describe("wiz plugin inactive stubs", () => {
  test("keysOf throws PluginInactiveError when plugin is inactive", () => {
    expect(() => keysOf<User>()).toThrow(PluginInactiveError);
  });

  test("requiredKeysOf throws PluginInactiveError when plugin is inactive", () => {
    expect(() => requiredKeysOf<User>()).toThrow(PluginInactiveError);
  });

  test("optionalKeysOf throws PluginInactiveError when plugin is inactive", () => {
    expect(() => optionalKeysOf<User>()).toThrow(PluginInactiveError);
  });

  test("schema throws PluginInactiveError when plugin is inactive", () => {
    expect(() => schema<User>()).toThrow(PluginInactiveError);
  });

  test("validate throws PluginInactiveError when plugin is inactive", () => {
    expect(() => validate<User>({ id: "1", name: "Alice" })).toThrow(
      PluginInactiveError
    );
  });

  test("is throws PluginInactiveError when plugin is inactive", () => {
    expect(() => is<User>({ id: "1", name: "Alice" })).toThrow(
      PluginInactiveError
    );
  });
  test("openapiSchema and its operation builders throw when plugin is inactive", () => {
    expect(() => openapiSchema<[User], "3.0">()).toThrow(PluginInactiveError);

    for (const method of ["get", "post", "put", "patch", "delete"] as const) {
      expect(() => openapiSchema[method]<never, never, User, never>("/users")).toThrow(
        `openapiSchema.${method}`
      );
    }
  });
});
