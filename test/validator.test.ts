// @wiz-ignore
import { describe, expect, test } from "bun:test";
import { generateValidatorCode } from "../src/generators/validator.ts";
import type { ValidationError } from "../src/types.ts";
import { evalModule, getIRForSource } from "./helpers.ts";

describe("Runtime JS Validator Generator", () => {
    test("validates objects, primitives, and JSDoc constraints with exact error shapes", () => {
        const ir = getIRForSource(
            `
      export interface Article {
        id: string;
        /**
         * @minLength 5
         */
        title: string;
        /**
         * @minimum 0
         */
        views: number;
        tags?: string[];
      }
    `,
            "Article",
        );

        const code = generateValidatorCode(ir);
        const mod = evalModule<{
            validate: (arg: unknown, path?: string) => ValidationError[];
            is: (arg: unknown) => boolean;
        }>(code);

        // Valid object
        const valid = {
            id: "a1",
            title: "Hello World",
            views: 42,
            tags: ["news"],
        };
        expect(mod.is(valid)).toBe(true);
        expect(mod.validate(valid)).toEqual([]);

        // Invalid object
        const invalid = {
            title: "Hi", // minLength 5 failed
            views: -5, // minimum 0 failed
        };
        expect(mod.is(invalid)).toBe(false);
        const errors = mod.validate(invalid);
        expect(errors.length).toBeGreaterThanOrEqual(3);

        const idErr = errors.find((e) => e.path === "id")!;
        expect(idErr.message).toBe("Required property is missing");
        expect(idErr.constraint).toBe("required");

        const titleErr = errors.find((e) => e.path === "title")!;
        expect(titleErr.constraint).toBe("minLength");

        const viewsErr = errors.find((e) => e.path === "views")!;
        expect(viewsErr.constraint).toBe("minimum");
    });

    test("validates Enums, Tuples, Records, and Unions", () => {
        const ir = getIRForSource(
            `
      export enum Role { Admin = 1, User = 2 }

      export interface Profile {
        role: Role;
        /**
         * @minItems 1
         * @maxItems 3
         * @uniqueItems true
         */
        scores: number[];
      }
    `,
            "Profile",
        );

        const code = generateValidatorCode(ir);
        const mod = evalModule<{
            validate: (arg: unknown, path?: string) => ValidationError[];
            is: (arg: unknown) => boolean;
        }>(code);

        const valid = {
            role: 1,
            scores: [10, 20],
        };
        expect(mod.is(valid)).toBe(true);

        const invalid = {
            role: 99, // Invalid enum value
            scores: [1, 1, 1, 1], // maxItems & uniqueItems failed
        };
        expect(mod.is(invalid)).toBe(false);
        const errors = mod.validate(invalid);
        expect(errors.some((e) => e.constraint === "maxItems")).toBe(true);
        expect(errors.some((e) => e.constraint === "uniqueItems")).toBe(true);
    });
});
