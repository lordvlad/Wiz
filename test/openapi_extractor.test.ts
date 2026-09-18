// @wiz-ignore
import { beforeAll, describe, expect, test } from "bun:test";
import { Validator } from "@seriousme/openapi-schema-validator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractApiIR,
  extractApiIRFromFile,
  parseApiDocument,
} from "../src/extractors/openapi.ts";
import { generateOpenApiSchemaCode } from "../src/generators/openapi.ts";
import { isHttpMethod } from "../src/ir/service.ts";
import { asHttp, evalModule } from "./helpers.ts";

/** Fails with the validator's own messages, which name the offending path. */
async function expectValid(document: unknown) {
  const result = await new Validator().validate(document as never);
  if (!result.valid) {
    throw new Error(
      `document is not valid OpenAPI:\n${JSON.stringify(result.errors, null, 2)}`
    );
  }
  expect(result.valid).toBe(true);
}

/** Extracts, then runs the IR straight back through the forward generator. */
function regenerate(document: unknown) {
  const ir = extractApiIR(JSON.stringify(document));
  if (ir.version !== "3.0" && ir.version !== "3.1") {
    throw new Error(`expected an OpenAPI document, got '${ir.version}'`);
  }
  const types = [...ir.types].map(([name, typeIR]) => ({ name, ir: typeIR }));
  const code = generateOpenApiSchemaCode(types, ir.version, ir.service);
  const regenerated = evalModule<{
    openapiSchema: (base?: unknown) => Record<string, any>;
  }>(code).openapiSchema({
    info: (document as Record<string, any>).info,
  });
  return { ir, regenerated };
}

/**
 * One document per dialect, spelled the way that dialect's forward mapping
 * emits it, covering every row of the schema mapping. `format: int32` and
 * friends are deliberately absent: the generator derives `minimum`/`maximum`
 * from an integer format, so those cannot be byte-identical either way.
 */
function roundTripDocument(version: "3.0" | "3.1") {
  const v30 = version === "3.0";
  return {
    openapi: v30 ? "3.0.3" : "3.1.0",
    info: { title: "Round Trip", version: "2.0.0" },
    paths: {
      "/users/{id}": {
        get: {
          tags: ["Users"],
          summary: "Fetch a user",
          description: "Reads one user by id.",
          operationId: "getUser",
          deprecated: true,
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            {
              name: "expand",
              in: "query",
              required: false,
              description: "Expand nested objects.",
              schema: { type: "boolean" },
            },
            {
              name: "X-Trace",
              in: "header",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "session",
              in: "cookie",
              required: false,
              deprecated: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "The user.",
              headers: {
                "X-Rate-Limit": {
                  description: "Calls left.",
                  required: true,
                  schema: { type: "number" },
                },
              },
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/User" },
                },
              },
            },
            "404": { description: "No such user." },
            default: {
              description: "Unexpected error.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Address" },
                },
              },
            },
          },
        },
        put: {
          operationId: "replaceUser",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/User" },
              },
            },
          },
          responses: { "204": { description: "No content" } },
        },
      },
    },
    components: {
      schemas: {
        User: {
          type: "object",
          description: "A person.",
          deprecated: true,
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string", minLength: 2, maxLength: 64 },
            age: {
              type: "number",
              minimum: 0,
              maximum: 150,
              default: 30,
              ...(v30 ? { example: 42 } : { examples: [42] }),
            },
            // Nullability: `nullable` in 3.0, a type array in 3.1.
            nickname: v30
              ? { type: "string", nullable: true }
              : { type: ["string", "null"] },
            // bigint, bytes and date are all `type: string` plus a format.
            visits: { type: "string", format: "int64", pattern: "^-?\\d+$" },
            avatar: v30
              ? { type: "string", format: "byte" }
              : { type: "string", contentEncoding: "base64" },
            createdAt: { type: "string", format: "date-time" },
            tags: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              maxItems: 5,
              uniqueItems: true,
            },
            role: { type: "string", enum: ["admin", "user"] },
            kind: v30
              ? { type: "string", enum: ["person"] }
              : { const: "person" },
            // A `$ref` between two schemas, and a self reference.
            home: { $ref: "#/components/schemas/Address" },
            manager: { $ref: "#/components/schemas/User" },
            labels: { $ref: "#/components/schemas/Labels" },
            shape: { $ref: "#/components/schemas/Shape" },
            ...(v30 ? {} : { pair: { $ref: "#/components/schemas/Pair" } }),
            bounded: { $ref: "#/components/schemas/Bounded" },
            answer: { $ref: "#/components/schemas/Answer" },
            deprecatedField: { type: "string", deprecated: true },
          },
          required: [
            "id",
            "name",
            "visits",
            "avatar",
            "createdAt",
            "tags",
            "role",
            "kind",
            "home",
            "labels",
          ],
        },
        Address: {
          type: "object",
          properties: { street: { type: "string" } },
          required: ["street"],
          additionalProperties: false,
        },
        // `additionalProperties` with no `properties` is how a record is spelled.
        Labels: { type: "object", additionalProperties: { type: "string" } },
        Shape: {
          oneOf: [
            { $ref: "#/components/schemas/Circle" },
            { $ref: "#/components/schemas/Square" },
          ],
          discriminator: { propertyName: "kind" },
        },
        Circle: {
          type: "object",
          properties: { radius: { type: "number" } },
          required: ["radius"],
        },
        Square: {
          type: "object",
          properties: { side: { type: "number" } },
          required: ["side"],
        },
        Audited: {
          allOf: [
            { $ref: "#/components/schemas/User" },
            {
              type: "object",
              properties: { at: { type: "string", format: "date-time" } },
              required: ["at"],
            },
          ],
        },
        // OpenAPI 3.0 forbids an array-valued `items`, so the 3.0 tuple form
        // gets its own round-trip assertion below rather than a place in a
        // document that also has to validate.
        ...(v30
          ? {}
          : {
              Pair: {
                type: "array",
                prefixItems: [{ type: "string" }, { type: "number" }],
              },
            }),
        // Each dialect's own spelling of an exclusive bound: a boolean
        // modifier in 3.0, a numeric keyword in 3.1.
        Bounded: v30
          ? {
              type: "number",
              minimum: 0,
              exclusiveMinimum: true,
              maximum: 10,
              exclusiveMaximum: true,
              multipleOf: 2,
            }
          : {
              type: "number",
              exclusiveMinimum: 0,
              exclusiveMaximum: 10,
              multipleOf: 2,
            },
        // An integer format states its own range, and the extractor knows not
        // to read that range back as an author-written constraint.
        Counter: {
          type: "number",
          format: "int32",
          minimum: -2147483648,
          maximum: 2147483647,
        },
        // The generator spells a bigint literal as a string enum + int64.
        Answer: { type: "string", format: "int64", enum: ["42"] },
      },
    },
  };
}

// The OpenAPI schema validator compiles its own meta-schemas on first use,
// which costs more than the default per-test timeout on a cold cache.
beforeAll(async () => {
  await expectValid({
    openapi: "3.1.0",
    info: { title: "warm", version: "1" },
    paths: {},
  });
}, 60_000);

describe.each(["3.0", "3.1"] as const)(
  "the OpenAPI extractor inverts the generator (%s)",
  (version) => {
    test("a document survives extraction and regeneration", async () => {
      const document = roundTripDocument(version);
      const { ir, regenerated } = regenerate(document);

      expect(ir.kind).toBe("api");
      expect(ir.version).toBe(version);
      expect(ir.diagnostics).toEqual([]);

      expect(regenerated.components.schemas).toEqual(
        document.components.schemas
      );
      expect(regenerated.paths).toEqual(document.paths);

      await expectValid({
        ...regenerated,
        openapi: version === "3.0" ? "3.0.3" : "3.1.0",
      });
    });

    test("info becomes the service identity", () => {
      const { ir } = regenerate(roundTripDocument(version));
      expect(ir.service.name).toBe("Round Trip");
      expect(ir.service.version).toBe("2.0.0");
      expect(
        ir.service.methods
          .filter(isHttpMethod)
          .map((m) => m.address.method)
      ).toEqual(["GET", "PUT"]);
    });
  }
);

describe("individual schema mappings", () => {
  const wrap = (schema: unknown, version: "3.0" | "3.1" = "3.1") => ({
    openapi: version === "3.0" ? "3.0.3" : "3.1.0",
    info: { title: "t", version: "1" },
    paths: {},
    components: { schemas: { X: schema } },
  });

  test("a date-time string is a date primitive, byte-identical on the way out", () => {
    const document = wrap({ type: "string", format: "date-time" });
    const { ir, regenerated } = regenerate(document);
    expect(ir.types.get("X")).toMatchObject({
      kind: "primitive",
      type: "date",
    });
    expect(regenerated.components.schemas.X).toEqual({
      type: "string",
      format: "date-time",
    });
  });

  test("a 3.0 boolean exclusiveMinimum is one bound, and round-trips", () => {
    const { ir, regenerated } = regenerate(
      wrap({ type: "integer", minimum: 5, exclusiveMinimum: true }, "3.0")
    );
    const x = ir.types.get("X")!;
    expect(x.constraints).toEqual([{ kind: "exclusiveMinimum", value: 5 }]);
    // Back out as the 3.0 pair, which is the only spelling that dialect's own
    // schema accepts. `integer` has no IR of its own, so it becomes `number`.
    expect(regenerated.components.schemas.X).toEqual({
      type: "number",
      minimum: 5,
      exclusiveMinimum: true,
    });
  });

  test("a 3.0 boolean exclusiveMaximum is one bound", () => {
    const { ir } = regenerate(
      wrap({ type: "number", maximum: 9, exclusiveMaximum: true }, "3.0")
    );
    expect(ir.types.get("X")!.constraints).toEqual([
      { kind: "exclusiveMaximum", value: 9 },
    ]);
  });

  test("a 3.1 numeric exclusiveMinimum passes straight through", () => {
    const { ir, regenerated } = regenerate(
      wrap({ type: "number", exclusiveMinimum: 5 })
    );
    expect(ir.types.get("X")!.constraints).toEqual([
      { kind: "exclusiveMinimum", value: 5 },
    ]);
    expect(regenerated.components.schemas.X).toEqual({
      type: "number",
      exclusiveMinimum: 5,
    });
  });

  test("a range an integer format implies is not read back as a constraint", () => {
    // The generator derives minimum/maximum from the format to make the
    // document enforceable. Reading those back would invent constraints the
    // author never wrote, and the pair would never round-trip.
    const { ir, regenerated } = regenerate(
      wrap({ type: "integer", format: "int32" })
    );
    expect(ir.types.get("X")!.constraints).toEqual([
      { kind: "format", value: "int32" },
    ]);
    expect(regenerated.components.schemas.X).toEqual({
      type: "number",
      format: "int32",
      minimum: -2147483648,
      maximum: 2147483647,
    });
  });

  test("a bound the author wrote alongside an integer format survives", () => {
    const { ir } = regenerate(
      wrap({ type: "integer", format: "int32", minimum: 10 })
    );
    expect(ir.types.get("X")!.constraints).toEqual([
      { kind: "minimum", value: 10 },
      { kind: "format", value: "int32" },
    ]);
  });

  test("a multi-entry enum keeps synthesised member names", () => {
    const { ir } = regenerate(wrap({ type: "string", enum: ["ok", "not ok"] }));
    expect(ir.types.get("X")).toMatchObject({
      kind: "enum",
      members: [
        { name: "ok", value: "ok" },
        { name: "VALUE_1", value: "not ok" },
      ],
    });
  });

  test("a mixed-type enum is a union of literals, not an enum node", () => {
    const { ir } = regenerate(wrap({ enum: ["a", 1] }));
    const x = ir.types.get("X")!;
    expect(x.kind).toBe("union");
    expect(x.kind === "union" && x.types.map((t) => t.kind)).toEqual([
      "literal",
      "literal",
    ]);
  });

  test("a record keeps a string key type", () => {
    const { ir } = regenerate(
      wrap({ type: "object", additionalProperties: { type: "number" } })
    );
    expect(ir.types.get("X")).toMatchObject({
      kind: "record",
      keyType: { kind: "primitive", type: "string" },
      valueType: { kind: "primitive", type: "number" },
    });
  });

  test("the 3.0 array-of-items tuple form round-trips", () => {
    // OpenAPI 3.0 does not actually permit this shape, so it is checked on its
    // own rather than inside a document that has to validate.
    const items = [{ type: "string" }, { type: "number" }];
    const rawDoc = wrap({ type: "array", items }, "3.0");
    const ir = extractApiIR(JSON.stringify(rawDoc));
    expect(ir.types.get("X")).toMatchObject({ kind: "tuple" });
    const types = [...ir.types].map(([name, typeIR]) => ({ name, ir: typeIR }));
    const code = generateOpenApiSchemaCode(types, ir.version as "3.0" | "3.1", ir.service, { validate: false });
    const regenerated = evalModule<{
      openapiSchema: (base?: unknown) => Record<string, any>;
    }>(code).openapiSchema({
      info: (rawDoc as Record<string, any>).info,
    });
    expect(regenerated.components.schemas.X).toEqual({
      type: "array",
      items,
    });
  });

  test("a $ref is a ref node, so recursion costs nothing", () => {
    const { ir } = regenerate(
      wrap({
        type: "object",
        properties: { self: { $ref: "#/components/schemas/X" } },
      })
    );
    const x = ir.types.get("X")!;
    expect(x.kind === "object" && x.properties[0]!.type).toMatchObject({
      kind: "ref",
      targetId: "X",
      name: "X",
    });
  });

  test("allOf siblings are kept as an extra intersection member", () => {
    const { ir } = regenerate(
      wrap({
        allOf: [{ type: "object", properties: { a: { type: "string" } } }],
        type: "object",
        properties: { b: { type: "number" } },
      })
    );
    const x = ir.types.get("X")!;
    expect(x.kind).toBe("intersection");
    expect(x.kind === "intersection" && x.types.length).toBe(2);
  });

  test("a format that picked the primitive is not also a constraint", () => {
    const { ir } = regenerate(
      wrap({ type: "string", format: "int64", pattern: "^-?\\d+$" })
    );
    const x = ir.types.get("X")!;
    expect(x).toMatchObject({ kind: "primitive", type: "bigint" });
    expect(x.constraints).toEqual([{ kind: "pattern", value: "^-?\\d+$" }]);
  });

  test("readOnly reaches the property, uniqueItems the array", () => {
    const { ir } = regenerate(
      wrap({
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "string" },
            uniqueItems: true,
            readOnly: true,
          },
        },
      })
    );
    const x = ir.types.get("X")!;
    expect(x.kind === "object" && x.properties[0]).toMatchObject({
      name: "ids",
      optional: true,
      readonly: true,
    });
  });
});

describe("component names survive extraction", () => {
  const document = {
    openapi: "3.1.0",
    info: { title: "Components", version: "1.0.0" },
    paths: {
      "/users": {
        post: {
          operationId: "createUser",
          parameters: [{ $ref: "#/components/parameters/ApiKey" }],
          requestBody: { $ref: "#/components/requestBodies/CreateUser" },
          responses: {
            "201": {
              description: "Created",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/User" },
                },
              },
            },
            "404": { $ref: "#/components/responses/NotFound" },
          },
        },
      },
    },
    components: {
      schemas: {
        User: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        Problem: {
          type: "object",
          properties: { detail: { type: "string" } },
          required: ["detail"],
        },
      },
      parameters: {
        ApiKey: {
          name: "X-Api-Key",
          in: "header",
          required: true,
          schema: { type: "string" },
        },
      },
      headers: {
        RetryAfter: { required: true, schema: { type: "number" } },
      },
      requestBodies: {
        CreateUser: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/User" },
            },
          },
        },
      },
      responses: {
        NotFound: {
          description: "Nothing there.",
          headers: { "Retry-After": { $ref: "#/components/headers/RetryAfter" } },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Problem" },
            },
          },
        },
      },
    },
  };

  test("all four registries are populated", () => {
    const ir = extractApiIR(JSON.stringify(document));
    expect(ir.diagnostics).toEqual([]);
    expect(ir.components.parameters.get("ApiKey")).toMatchObject({
      name: "X-Api-Key",
      in: "header",
      required: true,
    });
    // The registry entry is the definition; only a use site names the component.
    expect(ir.components.parameters.get("ApiKey")!.component).toBeUndefined();
    expect(ir.components.headers.get("RetryAfter")).toMatchObject({
      in: "header",
      required: true,
    });
    expect(ir.components.requestBodies.get("CreateUser")).toMatchObject({
      required: true,
    });
    expect(
      ir.components.requestBodies.get("CreateUser")!.bodies[0]!.mimetype
    ).toBe("application/json");
    expect(ir.components.responses.get("NotFound")).toMatchObject({
      status: "default",
      description: "Nothing there.",
    });
  });

  test("use sites carry the component name alongside the resolved value", () => {
    const ir = extractApiIR(JSON.stringify(document));
    const method = asHttp(ir.service.methods[0]!);

    expect(method.request.parameters).toEqual([
      {
        name: "X-Api-Key",
        in: "header",
        required: true,
        type: expect.objectContaining({ kind: "primitive", type: "string" }),
        component: "ApiKey",
      },
    ]);

    expect(method.request.bodyComponent).toBe("CreateUser");
    expect(method.request.bodyRequired).toBe(true);
    expect(method.request.body).toEqual([
      {
        mimetype: "application/json",
        content: expect.objectContaining({ kind: "ref", name: "User" }),
      },
    ]);

    const notFound = method.responses.find((r) => r.status === 404)!;
    expect(notFound.component).toBe("NotFound");
    expect(notFound.description).toBe("Nothing there.");
    expect(notFound.headers).toEqual([
      {
        name: "Retry-After",
        in: "header",
        required: true,
        type: expect.objectContaining({ kind: "primitive", type: "number" }),
        component: "RetryAfter",
      },
    ]);
  });

  test("regeneration inlines the components, losslessly", async () => {
    const { regenerated } = regenerate(document);

    // The generator has no component-emitting path, so the `$ref`s become the
    // values they resolved to. That is the observable proof of resolution.
    expect(regenerated.paths).toEqual({
      "/users": {
        post: {
          operationId: "createUser",
          parameters: [
            {
              name: "X-Api-Key",
              in: "header",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/User" },
              },
            },
          },
          responses: {
            "201": {
              description: "Created",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/User" },
                },
              },
            },
            "404": {
              description: "Nothing there.",
              headers: {
                "Retry-After": { required: true, schema: { type: "number" } },
              },
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Problem" },
                },
              },
            },
          },
        },
      },
    });

    await expectValid({ ...regenerated, openapi: "3.1.0" });
  });

  test("a component that is itself a $ref resolves through the chain", () => {
    const chained = {
      ...document,
      components: {
        ...document.components,
        parameters: {
          ...document.components.parameters,
          Alias: { $ref: "#/components/parameters/ApiKey" },
        },
      },
    };
    const ir = extractApiIR(JSON.stringify(chained));
    expect(ir.components.parameters.get("Alias")).toMatchObject({
      name: "X-Api-Key",
      in: "header",
    });
  });

  test("a cycle among component definitions throws", () => {
    const cyclic = {
      ...document,
      components: {
        ...document.components,
        parameters: {
          A: { $ref: "#/components/parameters/B" },
          B: { $ref: "#/components/parameters/A" },
        },
      },
    };
    expect(() => extractApiIR(JSON.stringify(cyclic))).toThrow(
      /circular component reference at #\/components\/parameters\/[AB]/
    );
  });
});

describe("path-item parameters merge with operation parameters", () => {
  const document = {
    openapi: "3.1.0",
    info: { title: "Merge", version: "1" },
    paths: {
      "/things/{id}": {
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "trace", in: "query", schema: { type: "string" } },
        ],
        get: {
          parameters: [
            // Same name and location: replaces the path-item entry in place.
            {
              name: "trace",
              in: "query",
              required: true,
              schema: { type: "boolean" },
            },
            { name: "page", in: "query", schema: { type: "number" } },
          ],
          responses: { "204": { description: "No content" } },
        },
      },
    },
  };

  test("an operation parameter replaces the path-item one of the same name", () => {
    const ir = extractApiIR(JSON.stringify(document));
    const parameters = asHttp(ir.service.methods[0]!).request.parameters!;
    expect(
      parameters.map((p) => [p.name, p.in, p.required, p.type.kind])
    ).toEqual([
      ["id", "path", true, "primitive"],
      ["trace", "query", true, "primitive"],
      ["page", "query", false, "primitive"],
    ]);
    const trace = parameters[1]!;
    expect(trace.type).toMatchObject({ kind: "primitive", type: "boolean" });
  });
});

describe("every parser reaches the same IR", () => {
  const json = `{
    "openapi": "3.1.0",
    "info": { "title": "Parsers", "version": "1.0.0" },
    "paths": {
      "/ping": {
        "get": {
          "operationId": "ping",
          "parameters": [
            { "name": "loud", "in": "query", "schema": { "type": "boolean" } }
          ],
          "responses": {
            "200": {
              "description": "pong",
              "content": {
                "application/json": {
                  "schema": { "$ref": "#/components/schemas/Pong" }
                }
              }
            }
          }
        }
      }
    },
    "components": {
      "schemas": {
        "Pong": {
          "type": "object",
          "properties": { "at": { "type": "string", "format": "date-time" } },
          "required": ["at"]
        }
      }
    }
  }`;

  const jsonc = `{
    // The service version, as a comment JSON would reject.
    "openapi": "3.1.0",
    "info": { "title": "Parsers", "version": "1.0.0" },
    "paths": {
      "/ping": {
        "get": {
          "operationId": "ping",
          "parameters": [
            { "name": "loud", "in": "query", "schema": { "type": "boolean" } }
          ],
          "responses": {
            "200": {
              "description": "pong",
              "content": {
                "application/json": {
                  "schema": { "$ref": "#/components/schemas/Pong" }
                }
              }
            }
          }
        }
      }
    },
    "components": {
      "schemas": {
        "Pong": {
          "type": "object",
          "properties": { "at": { "type": "string", "format": "date-time" } },
          "required": ["at"],
        }
      }
    },
  }`;

  const json5 = `{
    openapi: '3.1.0',
    info: { title: 'Parsers', version: '1.0.0' },
    paths: {
      '/ping': {
        get: {
          operationId: 'ping',
          parameters: [
            { name: 'loud', in: 'query', schema: { type: 'boolean' } },
          ],
          responses: {
            '200': {
              description: 'pong',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Pong' },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Pong: {
          type: 'object',
          properties: { at: { type: 'string', format: 'date-time' } },
          required: ['at'],
        },
      },
    },
  }`;

  const yaml = `openapi: "3.1.0"
info:
  title: Parsers
  version: "1.0.0"
paths:
  /ping:
    get:
      operationId: ping
      parameters:
        - name: loud
          in: query
          schema:
            type: boolean
      responses:
        "200":
          description: pong
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Pong"
components:
  schemas:
    Pong:
      type: object
      properties:
        at:
          type: string
          format: date-time
      required:
        - at
`;

  const sources: Array<[string, string, "json" | "jsonc" | "json5" | "yaml"]> = [
    ["json", json, "json"],
    ["jsonc", jsonc, "jsonc"],
    ["json5", json5, "json5"],
    ["yaml", yaml, "yaml"],
  ];

  test.each(sources)("%s parses to the same ApiIR", (_label, text, format) => {
    const expected = extractApiIR(json, { format: "json" });
    // Node ids come from a per-extraction counter, so two runs must agree.
    expect(extractApiIR(text, { format })).toEqual(expected);
    // Sniffing must reach the same document without being told the format.
    expect(extractApiIR(text)).toEqual(expected);
  });

  test("parseApiDocument sniffs each dialect", () => {
    for (const [, text] of sources) {
      expect((parseApiDocument(text) as Record<string, unknown>).openapi).toBe(
        "3.1.0"
      );
    }
  });

  test("a document that is no dialect at all reports as malformed YAML", () => {
    expect(() => parseApiDocument("{ this is: not: valid")).toThrow();
  });

  test("the file entry point picks the parser from the extension", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wiz-openapi-"));
    try {
      const expected = extractApiIR(json, { format: "json" });
      for (const [label, text] of sources) {
        const extension = label === "yaml" ? "yml" : label;
        const path = join(dir, `api.${extension}`);
        await Bun.write(path, text);
        expect(await extractApiIRFromFile(path)).toEqual(expected);
      }
      // An unknown extension falls back to sniffing rather than failing.
      const odd = join(dir, "api.spec");
      await Bun.write(odd, yaml);
      expect(await extractApiIRFromFile(odd)).toEqual(expected);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("diagnostics and refusals", () => {
  const wrap = (schemas: Record<string, unknown>) =>
    JSON.stringify({
      openapi: "3.1.0",
      info: { title: "d", version: "1" },
      paths: {},
      components: { schemas },
    });

  test("an unrepresentable keyword is reported and dropped", () => {
    const text = wrap({ X: { type: "string", not: { const: "no" } } });
    const ir = extractApiIR(text);
    expect(ir.diagnostics).toEqual([
      {
        pointer: "#/components/schemas/X/not",
        keyword: "not",
        message: "dropped unrepresentable schema keyword 'not'",
      },
    ]);
    expect(ir.types.get("X")).toMatchObject({
      kind: "primitive",
      type: "string",
    });
  });

  test("strict turns the same diagnostic into a throw", () => {
    const text = wrap({ X: { type: "string", not: { const: "no" } } });
    expect(() => extractApiIR(text, { strict: true })).toThrow(
      "[wiz] dropped unrepresentable schema keyword 'not' at #/components/schemas/X/not"
    );
  });

  test("a discriminator mapping is reported", () => {
    const ir = extractApiIR(
      wrap({
        X: {
          oneOf: [{ type: "string" }, { type: "number" }],
          discriminator: { propertyName: "kind", mapping: { a: "#/x" } },
        },
      })
    );
    expect(ir.diagnostics.map((d) => d.keyword)).toEqual([
      "discriminator.mapping",
    ]);
    expect(ir.types.get("X")).toMatchObject({
      kind: "union",
      discriminator: { propertyName: "kind" },
    });
  });

  test("an external $ref is refused by name", () => {
    expect(() =>
      extractApiIR(wrap({ X: { $ref: "other.yaml#/x" } }))
    ).toThrow(
      "[wiz] unsupported $ref 'other.yaml#/x' at #/components/schemas/X; a schema may only reference #/components/schemas/*"
    );
  });

  test("a $ref into a non-schema component section is refused", () => {
    expect(() =>
      extractApiIR(wrap({ X: { $ref: "#/components/parameters/ApiKey" } }))
    ).toThrow(/unsupported \$ref '#\/components\/parameters\/ApiKey'/);
  });

  test("a Swagger 2.0 document is refused by version", () => {
    expect(() =>
      extractApiIR(
        JSON.stringify({ swagger: "2.0", info: { title: "s", version: "1" } })
      )
    ).toThrow(
      "[wiz] unsupported OpenAPI version '2.0'; 3.0 and 3.1 are supported"
    );
  });

  test("an unsupported openapi version is refused by value", () => {
    expect(() =>
      extractApiIR(JSON.stringify({ openapi: "4.0.0", paths: {} }))
    ).toThrow(
      "[wiz] unsupported OpenAPI version '4.0.0'; 3.0 and 3.1 are supported"
    );
  });

  test("a range status key is reported and skipped", () => {
    const ir = extractApiIR(
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "r", version: "1" },
        paths: {
          "/x": {
            get: {
              responses: {
                "200": { description: "ok" },
                "2XX": { description: "range" },
              },
            },
          },
        },
      })
    );
    expect(ir.diagnostics).toEqual([
      {
        pointer: "#/paths/~1x/get/responses/2XX",
        keyword: "2XX",
        message: "skipped response with range status key '2XX'",
      },
    ]);
    expect(asHttp(ir.service.methods[0]!).responses.map((r) => r.status)).toEqual([200]);
  });

  test("a parameter using content instead of schema is reported and skipped", () => {
    const ir = extractApiIR(
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "c", version: "1" },
        paths: {
          "/x": {
            get: {
              parameters: [
                {
                  name: "filter",
                  in: "query",
                  content: { "application/json": { schema: { type: "string" } } },
                },
              ],
              responses: { "204": { description: "none" } },
            },
          },
        },
      })
    );
    expect(ir.diagnostics.map((d) => d.keyword)).toEqual(["content"]);
    expect(asHttp(ir.service.methods[0]!).request.parameters).toBeUndefined();
  });
  test("a duplicate operationId is reported as a diagnostic", () => {
    const ir = extractApiIR(
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "dup", version: "1" },
        paths: {
          "/a": {
            get: {
              operationId: "getThing",
              responses: { "204": { description: "none" } },
            },
          },
          "/b": {
            get: {
              operationId: "getThing",
              responses: { "204": { description: "none" } },
            },
          },
        },
      })
    );
    expect(ir.diagnostics).toEqual([
      {
        pointer: "#/paths/~1b/get/operationId",
        keyword: "operationId",
        message: "duplicate operationId 'getThing'",
      },
    ]);
  });

  test("unsupported/mismatched constraints are reported as diagnostics", () => {
    const ir = extractApiIR(
      wrap({
        StringWithMin: { type: "string", minimum: 5 },
        NumberWithMinLength: { type: "number", minLength: 3 },
        ObjectWithMinItems: { type: "object", minItems: 2 },
      })
    );
    expect(ir.diagnostics).toEqual([
      {
        pointer: "#/components/schemas/StringWithMin/minimum",
        keyword: "minimum",
        message: "unsupported constraint 'minimum' on non-numeric type 'string'",
      },
      {
        pointer: "#/components/schemas/NumberWithMinLength/minLength",
        keyword: "minLength",
        message: "unsupported constraint 'minLength' on non-string type 'number'",
      },
      {
        pointer: "#/components/schemas/ObjectWithMinItems/minItems",
        keyword: "minItems",
        message: "unsupported constraint 'minItems' on non-array type 'object'",
      },
    ]);
  });
});
