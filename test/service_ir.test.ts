// @wiz-ignore
import { describe, expect, test } from "bun:test";
import { generateOpenApiSchemaCode } from "../src/generators/openapi.ts";
import type { ServiceIR, ServiceMethodIR } from "../src/ir/service.ts";
import { evalModule, getIRsForSource } from "./helpers.ts";

const sourceCode = `
  export interface User { id: number; name: string }
  export interface NotFound { message: string }
  export interface ValidationError { field: string; reason: string }
  export interface NewUser { name: string }
  export type PathParams = { id: number };
`;

describe("ServiceIR shape", () => {
  test("a method reads as address / request / responses", () => {
    const irs = getIRsForSource(sourceCode, ["User", "PathParams"]);

    const method: ServiceMethodIR = {
      kind: "serviceMethod",
      protocol: "http",
      address: { protocol: "http", method: "GET", path: "/users/{id}" },
      request: {
        protocol: "http",
        pathParameters: irs.PathParams.ir,
      },
      responses: [
        {
          protocol: "http",
          status: 200,
          body: [{ mimetype: "application/json", content: irs.User.ir }],
        },
      ],
    };

    // The discriminators are what make a method narrowable on its own.
    expect(method.kind).toBe("serviceMethod");
    expect(method.address.protocol).toBe("http");
    expect(method.request.protocol).toBe("http");
    expect(method.responses[0]!.protocol).toBe("http");

    // Sub-IRs stay self-describing when passed around detached.
    const address = method.address;
    expect(address).toEqual({
      protocol: "http",
      method: "GET",
      path: "/users/{id}",
    });
  });
});

describe("capabilities the flat operation IR could not express", () => {
  test("several status codes on one method", () => {
    const irs = getIRsForSource(sourceCode, [
      "User",
      "NotFound",
      "ValidationError",
      "PathParams",
    ]);

    const svc: ServiceIR = {
      kind: "service",
      methods: [
        {
          kind: "serviceMethod",
          protocol: "http",
          address: { protocol: "http", method: "GET", path: "/users/{id}" },
          request: { protocol: "http", pathParameters: irs.PathParams.ir },
          responses: [
            {
              protocol: "http",
              status: 200,
              body: [{ mimetype: "application/json", content: irs.User.ir }],
            },
            {
              protocol: "http",
              status: 404,
              description: "No such user",
              body: [{ mimetype: "application/json", content: irs.NotFound.ir }],
            },
            {
              protocol: "http",
              status: "default",
              description: "Unexpected error",
              body: [
                {
                  mimetype: "application/json",
                  content: irs.ValidationError.ir,
                },
              ],
            },
          ],
        },
      ],
    };

    const doc = evalModule<{ openapiSchema: () => any }>(
      generateOpenApiSchemaCode([], "3.1", svc)
    ).openapiSchema();

    const responses = doc.paths["/users/{id}"].get.responses;
    expect(Object.keys(responses).sort()).toEqual(["200", "404", "default"]);
    expect(responses["404"].description).toBe("No such user");
    expect(responses["404"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/NotFound",
    });
    expect(responses.default.content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/ValidationError",
    });

    // Every referenced type is hoisted, including error-only ones and the
    // named path-parameter alias.
    expect(Object.keys(doc.components.schemas).sort()).toEqual([
      "NotFound",
      "PathParams",
      "User",
      "ValidationError",
    ]);
  });

  test("several media types on one payload", () => {
    const irs = getIRsForSource(sourceCode, ["User", "NewUser"]);

    const svc: ServiceIR = {
      kind: "service",
      methods: [
        {
          kind: "serviceMethod",
          protocol: "http",
          address: { protocol: "http", method: "POST", path: "/users" },
          request: {
            protocol: "http",
            body: [
              { mimetype: "application/json", content: irs.NewUser.ir },
              { mimetype: "application/x-www-form-urlencoded", content: irs.NewUser.ir },
            ],
          },
          responses: [
            {
              protocol: "http",
              status: 201,
              body: [{ mimetype: "application/json", content: irs.User.ir }],
            },
          ],
        },
      ],
    };

    const doc = evalModule<{ openapiSchema: () => any }>(
      generateOpenApiSchemaCode([], "3.1", svc)
    ).openapiSchema();

    const post = doc.paths["/users"].post;
    expect(Object.keys(post.requestBody.content).sort()).toEqual([
      "application/json",
      "application/x-www-form-urlencoded",
    ]);
    expect(Object.keys(post.responses)).toEqual(["201"]);
  });

  test("header and cookie parameters", () => {
    const irs = getIRsForSource(
      `
      export type Headers = { "x-request-id": string };
      export type Cookies = { session?: string };
    `,
      ["Headers", "Cookies"]
    );

    const svc: ServiceIR = {
      kind: "service",
      methods: [
        {
          kind: "serviceMethod",
          protocol: "http",
          address: { protocol: "http", method: "GET", path: "/ping" },
          request: {
            protocol: "http",
            headerParameters: irs.Headers.ir,
            cookieParameters: irs.Cookies.ir,
          },
          responses: [{ protocol: "http", status: 204 }],
        },
      ],
    };

    const doc = evalModule<{ openapiSchema: () => any }>(
      generateOpenApiSchemaCode([], "3.1", svc)
    ).openapiSchema();

    expect(doc.paths["/ping"].get.parameters).toEqual([
      { name: "x-request-id", in: "header", required: true, schema: { type: "string" } },
      { name: "session", in: "cookie", required: false, schema: { type: "string" } },
    ]);
  });

  test("method level metadata reaches the operation object", () => {
    const irs = getIRsForSource(sourceCode, ["User"]);

    const doc = evalModule<{ openapiSchema: () => any }>(
      generateOpenApiSchemaCode([], "3.1", {
        kind: "service",
        methods: [
          {
            kind: "serviceMethod",
            protocol: "http",
            address: { protocol: "http", method: "GET", path: "/users" },
            request: { protocol: "http" },
            responses: [
              {
                protocol: "http",
                status: 200,
                body: [{ mimetype: "application/json", content: irs.User.ir }],
              },
            ],
            operationId: "listUsers",
            summary: "List users",
            tags: ["User"],
            deprecated: true,
          },
        ],
      })
    ).openapiSchema();

    const get = doc.paths["/users"].get;
    expect(get.operationId).toBe("listUsers");
    expect(get.summary).toBe("List users");
    expect(get.tags).toEqual(["User"]);
    expect(get.deprecated).toBe(true);
  });
});
