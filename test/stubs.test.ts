// @wiz-ignore
//
// This file asserts the *untransformed* behaviour of the wiz helpers, so it
// must not be transformed. `@wiz-ignore` above is what guarantees that, which
// is why this file does not care whether another test has already called
// `plugin(wizPlugin())` on the process. It used to be named `00_stubs` to sort
// first; that prefix suggested a load-bearing ordering dependency that never
// existed.
import { describe, expect, test } from "bun:test";
import {
    is,
    keysOf,
    openapiSchema,
    optionalKeysOf,
    PluginInactiveError,
    requiredKeysOf,
    jsonSchema,
    jsonSchemas,
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

    test("jsonSchema and jsonSchemas throw PluginInactiveError when plugin is inactive", () => {
        expect(() => jsonSchema<User>()).toThrow(PluginInactiveError);
        expect(() => jsonSchemas<[User]>()).toThrow(PluginInactiveError);
    });
    test("validate throws PluginInactiveError when plugin is inactive", () => {
        expect(() => validate<User>({ id: "1", name: "Alice" })).toThrow(PluginInactiveError);
    });

    test("is throws PluginInactiveError when plugin is inactive", () => {
        expect(() => is<User>({ id: "1", name: "Alice" })).toThrow(PluginInactiveError);
    });
    test("openapiSchema and its operation builders throw when plugin is inactive", () => {
        expect(() => openapiSchema<[User], "3.0">()).toThrow(PluginInactiveError);

        for (const method of ["get", "post", "put", "patch", "delete"] as const) {
            expect(() => openapiSchema[method]<never, never, User, never>("/users")).toThrow(`openapiSchema.${method}`);
        }
    });
});
