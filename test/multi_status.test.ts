// @wiz-ignore
import { beforeAll, describe, expect, test } from "bun:test";
import { plugin } from "bun";
import { wizPlugin } from "../src/plugin.ts";
import { silentLogger } from "../src/logger.ts";

plugin(wizPlugin({ logger: silentLogger }));

describe("multi-status responses", () => {
  let doc: Record<string, any>;

  beforeAll(async () => {
    // `openapiDocument()` is resolved at build time, so it is called inside the
    // fixture; this file is @wiz-ignore and would never be transformed.
    doc = (await import("./fixtures/errorsFixture.ts")).document as Record<string, any>;
  });

  test("every declared status reaches the document", () => {
    const get = doc.paths["/users/{id}"].get;
    expect(Object.keys(get.responses).sort()).toEqual([
      "200",
      "404",
      "429",
      "default",
    ]);
  });

  test("the response shorthand still supplies the success case", () => {
    const ok = doc.paths["/users/{id}"].get.responses["200"];
    expect(ok.content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/User",
    });
  });

  test("each error status carries its own schema", () => {
    const responses = doc.paths["/users/{id}"].get.responses;
    expect(responses["404"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/NotFound",
    });
    expect(responses["429"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/RateLimited",
    });
  });

  test("a key's JSDoc becomes the response description", () => {
    const responses = doc.paths["/users/{id}"].get.responses;
    expect(responses["404"].description).toBe("No such user");
    expect(responses["429"].description).toBe("Slow down");
    expect(responses.default.description).toBe("Anything else");
  });

  test("a never body yields a bodiless response", () => {
    const fallback = doc.paths["/users/{id}"].get.responses.default;
    expect(fallback.content).toBeUndefined();
  });

  test("error-only types are hoisted into components", () => {
    expect(Object.keys(doc.components.schemas).sort()).toEqual([
      "NotFound",
      "RateLimited",
      "User",
    ]);
  });
});
