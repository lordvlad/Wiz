import { describe, expect, test } from "bun:test";
import { extractOpenRpcIR } from "../src/extractors/openrpc.ts";
import { generateOpenRpcSchemaCode } from "../src/generators/openrpc.ts";
import type { TypeIR } from "../src/ir/types.ts";

describe("OpenRPC Extractor & Generator", () => {
  test("extractOpenRpcIR extracts ApiIR from OpenRPC document", () => {
    const doc = JSON.stringify({
      openrpc: "1.3.0",
      info: {
        title: "User Service",
        version: "1.0.0",
        description: "API for managing users",
      },
      methods: [
        {
          name: "UserService.getUser",
          summary: "Get a user by ID",
          params: [
            {
              name: "id",
              required: true,
              schema: { type: "string" },
            },
          ],
          result: {
            name: "result",
            schema: { $ref: "#/components/schemas/User" },
          },
          paramStructure: "by-name",
        },
      ],
      components: {
        schemas: {
          User: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
            },
            required: ["id", "name"],
          },
        },
      },
    });

    const apiIR = extractOpenRpcIR(doc);
    expect(apiIR.kind).toBe("api");
    expect(apiIR.version).toBe("openrpc-1.3");
    expect(apiIR.service.name).toBe("User Service");
    expect(apiIR.service.version).toBe("1.0.0");
    expect(apiIR.types.has("User")).toBe(true);

    expect(apiIR.service.methods.length).toBe(1);
    const method = apiIR.service.methods[0]!;
    expect(method.protocol).toBe("openrpc");
    expect(method.address.service).toBe("UserService");
    expect(method.address.method).toBe("getUser");
    expect(method.request.protocol).toBe("openrpc");
    expect(method.request.params.length).toBe(1);
    expect(method.request.params[0]!.name).toBe("id");
    expect(method.request.paramsByName).toBe(true);
  });

  test("generateOpenRpcSchemaCode produces code building OpenRPC 1.3 spec", () => {
    const userTypeIR: TypeIR = {
      id: "User1",
      kind: "object",
      name: "User",
      properties: [
        { name: "id", type: { id: "p1", kind: "primitive", type: "string" } },
        { name: "name", type: { id: "p2", kind: "primitive", type: "string" } },
      ],
    };

    const code = generateOpenRpcSchemaCode([{ name: "User", ir: userTypeIR }], {
      kind: "service",
      name: "Test API",
      version: "2.0.0",
      methods: [],
    });

    expect(code).toContain("export function openRPCSchema");
    expect(code).toContain("openrpc: \"1.3.0\"");
    expect(code).toContain("rpc.discover");

    // Evaluate code function to test buildOpenRpcDocument output
    const fn = new Function(`${code.replace(/export function/g, "function")}; return openRPCSchema();`);
    const result = fn() as Record<string, unknown>;

    expect(result.openrpc).toBe("1.3.0");
    const info = result.info as Record<string, string>;
    expect(info.title).toBe("Test API");
    expect(info.version).toBe("2.0.0");

    const components = result.components as Record<string, Record<string, unknown>>;
    expect(components.schemas.User).toBeDefined();
  });
});
