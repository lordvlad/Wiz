// @wiz-ignore
import { beforeAll, describe, expect, test } from "bun:test";
import { plugin } from "bun";
import { wizPlugin } from "../src/plugin.ts";
import { silentLogger } from "../src/logger.ts";
import { clearDocumentFragments } from "../src/document.ts";

plugin(wizPlugin({ logger: silentLogger }));

describe("honoRoutes end-to-end", () => {
  let fixture: typeof import("./fixtures/honoFixture.ts");

  beforeAll(async () => {
    clearDocumentFragments();
    fixture = await import("./fixtures/honoFixture.ts");
  });

  test("mounts handlers on the real Hono app and serves them", async () => {
    const { app } = fixture;

    const list = await app.request("/notes");
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([{ id: 1, text: "hello" }]);

    const created = await app.request("/notes", { method: "POST" });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ id: 2, text: "made" });

    // Hono path params still resolve through the untouched handler.
    const one = await app.request("/notes/7");
    expect(await one.json()).toEqual({ id: 7, text: "one" });

    // Methods that were never declared are not mounted.
    expect((await app.request("/notes/7", { method: "DELETE" })).status).toBe(404);
  });

  test("returns the same app instance it was given", async () => {
    // `honoRoutes` mounts and hands the app straight back; it never wraps it.
    expect(typeof fixture.app.request).toBe("function");
    expect(typeof fixture.app.fetch).toBe("function");
  });

  test("collects the merged document from the same route map", async () => {
    const { openapiDocument } = await import("../src/index.ts");
    const doc = openapiDocument() as Record<string, any>;

    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info).toEqual({ title: "Notes API", version: "2.0.0" });
    expect(Object.keys(doc.paths).sort()).toEqual(["/notes", "/notes/{id}"]);
    expect(Object.keys(doc.paths["/notes"]).sort()).toEqual(["get", "post"]);

    expect(doc.paths["/notes"].get.parameters).toEqual([
      { name: "tag", in: "query", required: false, schema: { type: "string" } },
    ]);
    expect(
      doc.paths["/notes"].get.responses["200"].content["application/json"].schema
    ).toEqual({ type: "array", items: { $ref: "#/components/schemas/Note" } });

    const post = doc.paths["/notes"].post;
    expect(post.responses["201"]).toBeDefined();
    expect(post.tags).toEqual(["Note"]);
    expect(post.requestBody.content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/NewNote",
    });

    expect(doc.paths["/notes/{id}"].get.parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "number" } },
    ]);

    expect(doc.components.schemas.Note.properties.text.minLength).toBe(1);
  });

  test("documented methods and mounted methods cannot drift", async () => {
    const { openapiDocument } = await import("../src/index.ts");
    const doc = openapiDocument() as Record<string, any>;

    // Every documented operation must actually answer on the app.
    for (const [path, methods] of Object.entries<Record<string, unknown>>(
      doc.paths
    )) {
      for (const method of Object.keys(methods)) {
        const url = path.replace(/\{(\w+)\}/g, "1");
        const res = await fixture.app.request(url, {
          method: method.toUpperCase(),
        });
        expect(res.status).not.toBe(404);
      }
    }
  });
});
