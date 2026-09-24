// @wiz-ignore
import { describe, expect, test } from "bun:test";
import { plugin } from "bun";
import { generateOpenApiSchemaCode } from "../src/generators/openapi.ts";
import { wizPlugin } from "../src/plugin.ts";
import { evalModule, getIRsForSource, httpMethod, params, service } from "./helpers.ts";

plugin(wizPlugin());

const sourceCode = `
  export interface User {
    id: number;
    name: string;
  }

  export interface UserQuery {
    q?: string;
    limit?: number;
  }

  export interface PathParams {
    id: number;
  }

  export type UserList = User[];
`;

describe("OpenAPI path builder (generator)", () => {
    test("emits path items, parameters, request bodies and responses", () => {
        const irs = getIRsForSource(sourceCode, ["User", "UserQuery", "PathParams", "UserList"]);

        const code = generateOpenApiSchemaCode(
            [],
            "3.0",
            service([
                httpMethod({
                    method: "get",
                    path: "/users",
                    parameters: params(irs.UserQuery.ir, "query"),
                    response: irs.UserList.ir,
                }),
                httpMethod({
                    method: "patch",
                    path: "/users/{id}",
                    parameters: params(irs.PathParams.ir, "path"),
                    response: irs.User.ir,
                    body: irs.User.ir,
                    overrides: `{ tags: ["User"], description: "Patch a user" }`,
                }),
            ]),
        );

        const doc = evalModule<{ openapiSchema: (base?: unknown) => any }>(code).openapiSchema();

        // GET /users — query parameters carry optionality from the type.
        const list = doc.paths["/users"].get;
        expect(list.parameters).toEqual([
            { name: "q", in: "query", required: false, schema: { type: "string" } },
            { name: "limit", in: "query", required: false, schema: { type: "number" } },
        ]);
        // `UserList` is a named alias, so it is hoisted and referenced rather than
        // inlined; the inline `User[]` case is covered by the end-to-end test.
        expect(list.responses["200"].content["application/json"].schema).toEqual({
            $ref: "#/components/schemas/UserList",
        });
        expect(doc.components.schemas.UserList).toEqual({
            type: "array",
            items: { $ref: "#/components/schemas/User" },
        });

        // PATCH /users/{id} — path params are always required; options merge in.
        const patch = doc.paths["/users/{id}"].patch;
        expect(patch.parameters).toEqual([{ name: "id", in: "path", required: true, schema: { type: "number" } }]);
        expect(patch.requestBody).toEqual({
            required: true,
            content: {
                "application/json": { schema: { $ref: "#/components/schemas/User" } },
            },
        });
        expect(patch.tags).toEqual(["User"]);
        expect(patch.description).toBe("Patch a user");

        // Referenced types are hoisted into components even with no type argument.
        expect(doc.components.schemas.User).toBeDefined();
        expect(doc.components.schemas.User.required).toEqual(["id", "name"]);
    });

    test("collapses several methods onto one path item and defaults empty responses to 204", () => {
        const irs = getIRsForSource(sourceCode, ["PathParams", "User"]);

        const code = generateOpenApiSchemaCode(
            [],
            "3.1",
            service([
                httpMethod({
                    method: "get",
                    path: "/users/{id}",
                    parameters: params(irs.PathParams.ir, "path"),
                    response: irs.User.ir,
                }),
                httpMethod({
                    method: "delete",
                    path: "/users/{id}",
                    parameters: params(irs.PathParams.ir, "path"),
                }),
            ]),
        );

        const doc = evalModule<{ openapiSchema: (base?: unknown) => any }>(code).openapiSchema();

        expect(Object.keys(doc.paths)).toEqual(["/users/{id}"]);
        expect(Object.keys(doc.paths["/users/{id}"]).sort()).toEqual(["delete", "get"]);
        expect(doc.paths["/users/{id}"].delete.responses).toEqual({
            "204": { description: "No content" },
        });
    });

    test("merges generated paths with paths supplied on the base document", () => {
        const irs = getIRsForSource(sourceCode, ["User"]);

        const code = generateOpenApiSchemaCode(
            [],
            "3.0",
            service([httpMethod({ method: "get", path: "/users", response: irs.User.ir })]),
        );

        const doc = evalModule<{ openapiSchema: (base?: unknown) => any }>(code).openapiSchema({
            info: { title: "Users API", version: "2.0.0" },
            paths: {
                "/health": { get: { responses: { "200": { description: "OK" } } } },
                "/users": { post: { responses: { "201": { description: "Created" } } } },
            },
        });

        expect(doc.info.version).toBe("2.0.0");
        expect(doc.paths["/health"].get).toBeDefined();
        // Hand-written sibling method survives alongside the generated one.
        expect(doc.paths["/users"].post).toBeDefined();
        expect(doc.paths["/users"].get.responses["200"]).toBeDefined();
    });

    test("omits paths entirely when no operations and no base paths exist", () => {
        const irs = getIRsForSource(sourceCode, ["User"]);
        const code = generateOpenApiSchemaCode([irs.User], "3.1");
        const doc = evalModule<{ openapiSchema: (base?: unknown) => any }>(code).openapiSchema();

        expect(doc.paths).toBeUndefined();
        expect(doc.components.schemas.User).toBeDefined();
    });
});

describe("OpenAPI path builder (plugin end-to-end)", () => {
    test("transforms openapiSchema.<method> callsites into a static document", async () => {
        const fixture = await import("./fixtures/apiFixture.ts");
        const doc = fixture.apiDoc as any;

        expect(doc.openapi).toBe("3.0.3");
        expect(doc.info).toEqual({ title: "Users API", version: "1.0.0" });
        expect(doc.servers).toEqual([{ url: "http://books.com" }]);

        // `:id` is rewritten to the OpenAPI `{id}` template form.
        expect(Object.keys(doc.paths).sort()).toEqual(["/users", "/users/{id}"]);

        expect(doc.paths["/users"].get.parameters).toEqual([
            {
                name: "q",
                in: "query",
                required: false,
                description: "Free text search",
                schema: { type: "string" },
            },
            { name: "limit", in: "query", required: false, schema: { type: "number" } },
        ]);
        expect(doc.paths["/users"].get.responses["200"].content["application/json"].schema).toEqual({
            type: "array",
            items: { $ref: "#/components/schemas/User" },
        });

        // `Partial<User>` is a mapped type: inlined, never a named component, and
        // it must not inherit `Partial`'s own lib documentation.
        const patchBody = doc.paths["/users/{id}"].patch.requestBody.content["application/json"].schema;
        expect(patchBody.type).toBe("object");
        expect(patchBody.required).toBeUndefined();
        expect(patchBody.description).toBeUndefined();
        expect(Object.keys(patchBody.properties).sort()).toEqual(["email", "id", "name"]);
        expect(doc.components.schemas.Partial).toBeUndefined();

        expect(doc.paths["/users/{id}"].patch.tags).toEqual(["User"]);
        expect(doc.paths["/users/{id}"].delete.responses["204"]).toBeDefined();

        // Named payload types reached only through operations still get components.
        expect(doc.components.schemas.User.properties.name.minLength).toBe(2);
        // A parameter container has no name in the IR any more — parameters are a
        // flat list — so it is no longer hoisted as an orphan component.
        expect(doc.components.schemas.UserQuery).toBeUndefined();
    });
});
