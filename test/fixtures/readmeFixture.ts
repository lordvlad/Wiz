import { is, jsonSchema, keysOf, validate } from "../../src/index.ts";

export type User = { id: string; name: string };

export const userKeys = keysOf<User>();
export const userSchema = jsonSchema<User>();
export const goodUser = is<User>({ id: "1", name: "Ada" });
export const badUser = is<User>({ id: 1 });
export const errors = validate<User>({ id: 1 });

/**
 * `is` narrows, so `unknown` becomes `User` inside the branch. Reading
 * `value.name` here is the assertion: it does not compile without the
 * predicate, so `tsc --noEmit` guards it.
 */
export function nameOf(value: unknown): string {
    if (is<User>(value)) {
        return value.name;
    }
    return "anonymous";
}
