// @wiz-ignore
import { describe, expect, test } from "bun:test";
import { generateKeysCode } from "../src/generators/keys.ts";
import { evalModule, getIRForSource } from "./helpers.ts";

describe("Key Extractor Generator", () => {
    test("generates keys, requiredKeys, optionalKeys for interface", () => {
        const ir = getIRForSource(
            `
      export interface User {
        id: string;
        name: string;
        age?: number;
      }
    `,
            "User",
        );

        const code = generateKeysCode(ir);
        const mod = evalModule<{
            keys: string[];
            requiredKeys: string[];
            optionalKeys: string[];
        }>(code);

        expect(mod.keys).toEqual(["id", "name", "age"]);
        expect(mod.requiredKeys).toEqual(["id", "name"]);
        expect(mod.optionalKeys).toEqual(["age"]);
    });

    test("generates keys for intersection of object types", () => {
        const ir = getIRForSource(
            `
      export type Base = { id: string };
      export type Meta = { createdAt: number };
      export type Entity = Base & Meta & { title: string };
    `,
            "Entity",
        );

        const code = generateKeysCode(ir);
        const mod = evalModule<{
            keys: string[];
            requiredKeys: string[];
            optionalKeys: string[];
        }>(code);

        expect(mod.keys).toEqual(["id", "createdAt", "title"]);
        expect(mod.requiredKeys).toEqual(["id", "createdAt", "title"]);
        expect(mod.optionalKeys).toEqual([]);
    });
});
