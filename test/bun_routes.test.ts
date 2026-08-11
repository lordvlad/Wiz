// @wiz-ignore
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { plugin } from "bun";
import { wizPlugin } from "../src/plugin.ts";
import { silentLogger } from "../src/logger.ts";
import {
  clearDocumentFragments,
  mergeDocumentFragment,
  mergedDocument,
} from "../src/document.ts";

plugin(wizPlugin({ logger: silentLogger }));

describe("merged document registry", () => {
  beforeEach(() => clearDocumentFragments());

  test("merges paths per method and components per name across fragments", () => {
    mergeDocumentFragment({
      openapi: "3.0.3",
      info: { title: "A", version: "1" },
      paths: { "/users": { get: { operationId: "list" } } },
      components: { schemas: { User: { type: "object" } } },
    });
    mergeDocumentFragment({
      paths: {
        "/users": { post: { operationId: "create" } },
        "/health": { get: { operationId: "health" } },
      },
      components: { schemas: { Order: { type: "object" } } },
    });

    const doc = mergedDocument();

    // Same path contributed by two fragments keeps both methods.
    expect(Object.keys(doc.paths as object).sort()).toEqual(["/health", "/users"]);
    expect(Object.keys((doc.paths as any)["/users"]).sort()).toEqual(["get", "post"]);
    expect(Object.keys((doc.components as any).schemas).sort()).toEqual([
      "Order",
      "User",
    ]);
    // Scalars from the first fragment survive.
    expect(doc.info).toEqual({ title: "A", version: "1" });
  });

  test("concatenates tags rather than overwriting them", () => {
    mergeDocumentFragment({ tags: [{ name: "a" }] });
    mergeDocumentFragment({ tags: [{ name: "b" }] });
    expect(mergedDocument().tags).toEqual([{ name: "a" }, { name: "b" }]);
  });
});
describe("bunRoutes end-to-end", () => {
  // Fragments register during module evaluation, and module init happens once,
  // so the registry must be cleared before the fixture is first imported.
  let fixture: typeof import("./fixtures/serverFixture.ts");

  beforeAll(async () => {
    clearDocumentFragments();
    fixture = await import("./fixtures/serverFixture.ts");
  });

  test("returns the routes value verbatim", async () => {
    const routes = fixture.routes as Record<string, any>;
    // Runtime behaviour must be indistinguishable from the raw literal.
    expect(Object.keys(routes).sort()).toEqual([
      "/api/status",
      "/users",
      "/users/:id",
    ]);
    expect(routes["/api/status"]).toBeInstanceOf(Response);
    expect(typeof routes["/users"].GET).toBe("function");
    expect(typeof routes["/users"].POST).toBe("function");
    expect(typeof routes["/users/:id"].DELETE).toBe("function");

    // op() is identity: the handler still runs and still returns a Response.
    const res = routes["/users"].GET();
    expect(res).toBeInstanceOf(Response);
    expect(await res.json()).toEqual([]);
  });

  test("collects one merged document from the route descriptors", async () => {
    const { openapiDocument } = await import("../src/index.ts");
    const doc = openapiDocument() as Record<string, any>;

    expect(doc.openapi).toBe("3.0.3");
    expect(doc.info).toEqual({ title: "Users API", version: "1.0.0" });

    // `:id` becomes `{id}`; every route key is documented.
    expect(Object.keys(doc.paths).sort()).toEqual([
      "/api/status",
      "/users",
      "/users/{id}",
    ]);

    // Method maps yield one operation per verb.
    expect(Object.keys(doc.paths["/users"]).sort()).toEqual(["get", "post"]);
    expect(Object.keys(doc.paths["/users/{id}"]).sort()).toEqual(["delete", "get"]);

    // A bare Response is documented as GET with a plain success response.
    expect(doc.paths["/api/status"].get.responses["204"]).toBeDefined();

    // query slot -> query parameters, optionality preserved, no bogus nullable.
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

    // response slot -> 200 content, named types hoisted to components.
    expect(
      doc.paths["/users"].get.responses["200"].content["application/json"].schema
    ).toEqual({ type: "array", items: { $ref: "#/components/schemas/User" } });

    // body + status slots.
    const post = doc.paths["/users"].post;
    expect(post.requestBody.content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/NewUser",
    });
    expect(post.responses["201"]).toBeDefined();
    expect(post.tags).toEqual(["User"]);

    // path slot -> required path parameter carrying the declared type.
    expect(doc.paths["/users/{id}"].get.parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "number" } },
    ]);

    // Omitted response slot -> 204.
    expect(doc.paths["/users/{id}"].delete.responses["204"]).toBeDefined();

    expect(doc.components.schemas.User.properties.name.minLength).toBe(2);
    expect(doc.components.schemas.NewUser).toBeDefined();
  });
});
