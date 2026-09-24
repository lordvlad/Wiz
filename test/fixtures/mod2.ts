import { keysOf, validate, type ValidationError } from "../../src/index.ts";
import type { Item } from "./sharedType.ts";

export function getKeys(): string[] {
    return keysOf<Item>() as string[];
}

export function validateItem(item: unknown): ValidationError[] {
    return validate<Item>(item);
}
