// @wiz-ignore
import { describe, expect, test } from "bun:test";
import { mergeDocuments } from "../src/document.ts";

describe("merging document fragments", () => {
    test("merges paths per method and components per name across fragments", () => {
        const doc = mergeDocuments([
            {
                openapi: "3.0.3",
                info: { title: "A", version: "1" },
                paths: { "/users": { get: { operationId: "list" } } },
                components: { schemas: { User: { type: "object" } } },
            },
            {
                paths: {
                    "/users": { post: { operationId: "create" } },
                    "/health": { get: { operationId: "health" } },
                },
                components: { schemas: { Order: { type: "object" } } },
            },
        ]);

        // Same path contributed by two fragments keeps both methods.
        expect(Object.keys(doc.paths as object).sort()).toEqual(["/health", "/users"]);
        expect(Object.keys((doc.paths as any)["/users"]).sort()).toEqual(["get", "post"]);
        expect(Object.keys((doc.components as any).schemas).sort()).toEqual(["Order", "User"]);
        // Scalars from the first fragment survive.
        expect(doc.info).toEqual({ title: "A", version: "1" });
    });

    test("concatenates tags rather than overwriting them", () => {
        const doc = mergeDocuments([{ tags: [{ name: "a" }] }, { tags: [{ name: "b" }] }]);
        expect(doc.tags).toEqual([{ name: "a" }, { name: "b" }]);
    });

    test("preserves existing rich response definition when new fragment provides void 204", () => {
        const doc = mergeDocuments([
            {
                openapi: "3.1.0",
                info: { title: "API", version: "1" },
                paths: {
                    "/items": {
                        get: {
                            operationId: "getItems",
                            responses: {
                                "200": {
                                    description: "Items list",
                                    content: { "application/json": { schema: { type: "array" } } },
                                },
                            },
                        },
                    },
                },
            },
            {
                paths: {
                    "/items": {
                        get: {
                            summary: "Updated summary",
                            responses: {
                                "204": { description: "No content" },
                            },
                        },
                    },
                },
            },
        ]);

        const getOp = (doc.paths as Record<string, any>)["/items"].get;
        expect(getOp.summary).toBe("Updated summary");
        expect(getOp.responses["200"]).toBeDefined();
        expect(getOp.responses["204"]).toBeUndefined();
    });
});
