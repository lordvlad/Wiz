// @wiz-ignore
import { describe, expect, test } from "bun:test";
import { extractAsyncApiIR } from "../src/extractors/asyncapi.ts";
import { extractApiIR } from "../src/extractors/openapi.ts";
import { isAsyncApiMethod } from "../src/ir/service.ts";
import { generateAsyncApiSchemaCode } from "../src/generators/asyncapi.ts";
import { generate } from "../src/generators/generator.ts";
import { tsClientGenerator } from "../src/generators/tsClient.ts";
import { transformSource } from "../src/plugin.ts";
import { silentLogger } from "../src/logger.ts";
import { getIRsForSource, evalModule } from "./helpers.ts";

describe("AsyncAPI Extractor", () => {
  test("extracts AsyncAPI 3.0 document IR", () => {
    const doc = JSON.stringify({
      asyncapi: "3.0.0",
      info: { title: "User Events", version: "1.0.0" },
      channels: {
        userSignup: {
          address: "users/signup",
          messages: {
            UserSignup: { $ref: "#/components/messages/UserSignup" },
          },
        },
      },
      operations: {
        onSignup: {
          action: "send",
          channel: { $ref: "#/channels/userSignup" },
          summary: "User signup event",
        },
      },
      components: {
        messages: {
          UserSignup: {
            payload: {
              type: "object",
              properties: {
                userId: { type: "string" },
                email: { type: "string" },
              },
            },
          },
        },
      },
    });

    const ir = extractAsyncApiIR(doc);
    expect(ir.kind).toBe("api");
    expect(ir.version).toBe("asyncapi-3.0");
    expect(ir.service.name).toBe("User Events");

    const method = ir.service.methods[0]!;
    expect(method.operationId).toBe("onSignup");
    expect(isAsyncApiMethod(method)).toBe(true);
    if (!isAsyncApiMethod(method)) throw new Error("expected an asyncapi method");
    expect(method.address.channel).toBe("users/signup");
    expect(method.address.action).toBe("send");
  });

  test("extracts AsyncAPI 2.6 document IR", () => {
    const doc = JSON.stringify({
      asyncapi: "2.6.0",
      info: { title: "Orders API", version: "2.0.0" },
      channels: {
        "orders/created": {
          publish: {
            operationId: "orderCreated",
            message: {
              payload: {
                type: "object",
                properties: {
                  orderId: { type: "string" },
                  total: { type: "number" },
                },
              },
            },
          },
        },
      },
    });

    const ir = extractAsyncApiIR(doc);
    expect(ir.version).toBe("asyncapi-2.6");
    expect(ir.service.name).toBe("Orders API");

    const method = ir.service.methods[0]!;
    expect(method.operationId).toBe("orderCreated");
    if (!isAsyncApiMethod(method)) throw new Error("expected an asyncapi method");
    expect(method.address.channel).toBe("orders/created");
    expect(method.address.action).toBe("send");
  });

  /**
   * `wiz generate` reaches every front end through `extractApiIR`, which picks
   * the dialect off the document's root field. Without an `asyncapi` branch the
   * documented `-g asyncapiClient` invocation died on the OpenAPI version check.
   */
  test("extractApiIR dispatches an AsyncAPI document to this extractor", () => {
    const doc = JSON.stringify({
      asyncapi: "3.0.0",
      info: { title: "Routed", version: "1.0.0" },
      channels: {},
      operations: {},
    });

    const ir = extractApiIR(doc);
    expect(ir.version).toBe("asyncapi-3.0");
    expect(ir.service.name).toBe("Routed");
  });
});

describe("AsyncAPI Client Generator (model and decoder only)", () => {
  test("client generator produces ONLY model.ts and codec.ts", () => {
    const doc = JSON.stringify({
      asyncapi: "3.0.0",
      info: { title: "Events", version: "1.0.0" },
      channels: {
        userSignup: {
          address: "users/signup",
          messages: {
            UserSignup: { $ref: "#/components/messages/UserSignup" },
          },
        },
      },
      operations: {
        onSignup: {
          action: "send",
          channel: { $ref: "#/channels/userSignup" },
        },
      },
      components: {
        messages: {
          UserSignup: {
            payload: {
              type: "object",
              properties: {
                id: { type: "string" },
              },
            },
          },
        },
      },
    });

    const ir = extractAsyncApiIR(doc);
    const files = generate(ir, tsClientGenerator, {}, silentLogger);

    expect(Object.keys(files).sort()).toEqual(["codec.ts", "model.ts"]);
    expect(files["api.ts"]).toBeUndefined();
    expect(files["transport.ts"]).toBeUndefined();

    expect(files["model.ts"]).toContain("export interface UserSignup");
    expect(files["codec.ts"]).toContain("export function encodeUserSignup");
    expect(files["codec.ts"]).toContain("export function decodeUserSignup");
  });
});

describe("AsyncAPI Spec Generator", () => {
  test("generates AsyncAPI 3.0 schema virtual module", () => {
    const irs = getIRsForSource(
      `export interface OrderEvent { orderId: string; amount: number }`,
      ["OrderEvent"]
    );
    const code = generateAsyncApiSchemaCode(
      [{ name: "OrderEvent", ir: irs.OrderEvent!.ir }],
      "3.0"
    );

    const mod = evalModule<{ asyncapiSchema(): any }>(code);
    const doc = mod.asyncapiSchema();

    expect(doc.asyncapi).toBe("3.0.0");
    expect(doc.components.schemas.OrderEvent).toBeDefined();
    expect(doc.components.messages.OrderEvent).toBeDefined();
  });

  test("plugin rewrites asyncapiSchema for signature/service types", () => {
    const source = `
      import { asyncapiSchema } from "wiz";
      export interface UserEvent { id: string }
      export interface EventService {
        /** @channel users/signup */
        signup(event: UserEvent): void;
      }
      export const doc = asyncapiSchema<[EventService]>();
    `;

    const result = transformSource({ path: "app.ts", contents: source, logger: silentLogger });
    expect(result.code).toContain("asyncapiSchema as __wiz_asyncapiSchema_");
  });
});
