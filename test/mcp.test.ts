// @wiz-ignore
import { describe, expect, test } from "bun:test";
import { generateMcpSchemaCode, irToMcpInputSchema } from "../src/generators/mcp.ts";
import { transformSource } from "../src/plugin.ts";
import { silentLogger } from "../src/logger.ts";
import { evalModule } from "./helpers.ts";
import { mcpSchema } from "../src/index.ts";
import type { TypeIR } from "../src/types.ts";
import type { ServiceIR } from "../src/ir/service.ts";

describe("MCP Schema Generator", () => {
  test("irToMcpInputSchema converts object and primitive IR into valid MCP input schema", () => {
    const objectIR: TypeIR = {
      id: "t_obj",
      kind: "object",
      properties: [
        {
          name: "query",
          type: { id: "t_str", kind: "primitive", type: "string" },
          optional: false,
          readonly: false,
        },
      ],
    };

    const schema = irToMcpInputSchema(objectIR);
    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();
    expect((schema.properties as any).query).toEqual({ type: "string" });

    const primIR: TypeIR = { id: "t_str", kind: "primitive", type: "string" };
    const primSchema = irToMcpInputSchema(primIR);
    expect(primSchema.type).toBe("object");
    expect((primSchema.properties as any).value).toEqual({ type: "string" });
  });

  test("generateMcpSchemaCode generates virtual module code for service methods", () => {
    const service: ServiceIR = {
      kind: "service",
      methods: [
        {
          kind: "serviceMethod",
          protocol: "mcp",
          address: { protocol: "mcp", name: "search_users" },
          title: "Search Users",
          description: "Searches users by query",
          annotations: { audience: ["assistant"], priority: 0.9 },
          request: {
            protocol: "mcp",
            input: {
              id: "t_in",
              kind: "object",
              properties: [
                {
                  name: "q",
                  type: { id: "t_str", kind: "primitive", type: "string" },
                  optional: false,
                  readonly: false,
                },
              ],
            },
          },
          responses: [
            {
              protocol: "mcp",
              output: {
                id: "t_out",
                kind: "array",
                element: { id: "t_str", kind: "primitive", type: "string" },
              },
            },
          ],
        },
      ],
    };

    const code = generateMcpSchemaCode([], service);
    expect(code).toContain("buildMcpDocument");
    expect(code).toContain("search_users");
    expect(code).toContain("Search Users");
    expect(code).toContain("Searches users by query");

    const mod = evalModule<{ mcpSchema: (base?: any) => any }>(code);
    const doc = mod.mcpSchema();
    expect(doc.tools).toBeDefined();
    expect(doc.tools.length).toBe(1);
    expect(doc.tools[0].name).toBe("search_users");
    expect(doc.tools[0].title).toBe("Search Users");
    expect(doc.tools[0].description).toBe("Searches users by query");
    expect(doc.tools[0].annotations).toEqual({ audience: ["assistant"], priority: 0.9 });
    expect(doc.tools[0].inputSchema.type).toBe("object");
    expect(doc.tools[0].outputSchema.type).toBe("array");
  });

  test("generateMcpSchemaCode throws validation error on malformed input schema", () => {
    const service: ServiceIR = {
      kind: "service",
      methods: [
        {
          kind: "serviceMethod",
          protocol: "mcp",
          address: { protocol: "mcp", name: "bad_tool" },
          description: 123 as any, // Invalid: MCP requires description to be a string
          request: {
            protocol: "mcp",
            input: {
              id: "t_in",
              kind: "object",
              properties: [],
            },
          },
          responses: [],
        },
      ],
    };
    expect(() => generateMcpSchemaCode([], service)).toThrow(/\[wiz\] Generated MCP document is invalid/);
  });

  test("mcpSchema stub throws PluginInactiveError when plugin is not active", () => {
    expect(() => mcpSchema()).toThrow("without active Bun plugin");
  });


  test("transforms mcpSchema with function signature types", () => {
    const source = `
      import { mcpSchema } from "./src/index.ts";

      /**
       * Search users in system.
       * @title Search System Users
       * @audience assistant
       * @priority 0.85
       */
      function searchUsers(params: { name: string; age?: number }): Promise<Array<{ id: string; name: string }>> {
        return Promise.resolve([]);
      }

      export const schema = mcpSchema<[typeof searchUsers]>();
    `;

    const res = transformSource({ path: "test.ts", contents: source, logger: silentLogger });
    expect(res.code).toContain("mcpSchema as __wiz_mcpSchema_");

    const virtualModule = Array.from(res.modules.values())[0]!;
    const code = virtualModule.files["index.js"]!;
    const mod = evalModule<{ mcpSchema: (base?: any) => any }>(code);
    const doc = mod.mcpSchema();

    expect(doc).toBeDefined();
    expect(doc.tools).toBeDefined();
    expect(doc.tools.length).toBe(1);

    const t = doc.tools[0];
    expect(t.name).toBe("search_users");
    expect(t.title).toBe("Search System Users");
    expect(t.description).toBe("Search users in system.");
    expect(t.annotations).toEqual({ audience: ["assistant"], priority: 0.85 });
    expect(t.inputSchema.type).toBe("object");
    expect(t.inputSchema.properties.name).toEqual({ type: "string" });
    expect(t.outputSchema.type).toBe("array");
  });

  test("transforms mcpSchema with signature types and baseSchema merging", () => {
    const source = `
      import { mcpSchema } from "./src/index.ts";

      interface CreateUserInput {
        username: string;
      }
      interface CreateUserOutput {
        id: string;
      }

      /**
       * Creates a new user
       * @title Create User
       * @audience user
       * @priority 0.9
       */
      function createUser(input: CreateUserInput): CreateUserOutput {
        return { id: "1" };
      }

      export const schema = mcpSchema<[typeof createUser]>(
        { tools: [{ name: "existing_tool", inputSchema: { type: "object" } }] }
      );
    `;

    const res = transformSource({ path: "test.ts", contents: source, logger: silentLogger });
    expect(res.code).toContain("mcpSchema as __wiz_mcpSchema_");

    const virtualModule = Array.from(res.modules.values())[0]!;
    const code = virtualModule.files["index.js"]!;
    const mod = evalModule<{ mcpSchema: (base?: any) => any }>(code);

    const doc = mod.mcpSchema({ tools: [{ name: "existing_tool", inputSchema: { type: "object" } }] });
    expect(doc.tools).toBeDefined();
    expect(doc.tools.length).toBe(2);

    const existing = doc.tools.find((t: any) => t.name === "existing_tool");
    expect(existing).toBeDefined();

    const created = doc.tools.find((t: any) => t.name === "create_user");
    expect(created).toBeDefined();
    expect(created.title).toBe("Create User");
    expect(created.description).toBe("Creates a new user");
    expect(created.annotations).toEqual({ audience: ["user"], priority: 0.9 });
    expect(created.inputSchema.properties.username).toEqual({ type: "string" });
    expect(created.outputSchema.properties.id).toEqual({ type: "string" });
  });

  test("transforms mcpSchema with JSDoc @name override", () => {
    const source = `
      import { mcpSchema } from "./src/index.ts";

      /**
       * @name custom_search_name
       */
      function findSomething(query: string): string {
        return query;
      }

      export const schema = mcpSchema<[typeof findSomething]>();
    `;

    const res = transformSource({ path: "test.ts", contents: source, logger: silentLogger });
    const virtualModule = Array.from(res.modules.values())[0]!;
    const code = virtualModule.files["index.js"]!;
    const mod = evalModule<{ mcpSchema: (base?: any) => any }>(code);
    const doc = mod.mcpSchema();

    expect(doc.tools).toBeDefined();
    expect(doc.tools[0].name).toBe("custom_search_name");
  });
  test("transforms mcpSchema with object/service types with namespaced tool names", () => {
    const source = `
      import { mcpSchema } from "./src/index.ts";

      interface UserService {
        /**
         * Search users in system.
         * @title Search Users
         */
        searchUsers(query: string): Promise<Array<{ id: string; name: string }>>;

        /**
         * @name get_user_by_id
         */
        getUser(id: string): Promise<{ id: string }>;
      }

      export const schema = mcpSchema<[UserService]>();
    `;

    const res = transformSource({ path: "test.ts", contents: source, logger: silentLogger });
    const virtualModule = Array.from(res.modules.values())[0]!;
    const code = virtualModule.files["index.js"]!;
    const mod = evalModule<{ mcpSchema: (base?: any) => any }>(code);
    const doc = mod.mcpSchema();

    expect(doc).toBeDefined();
    expect(doc.tools).toBeDefined();
    expect(doc.tools.length).toBe(2);

    const tool1 = doc.tools.find((t: any) => t.name === "UserService.search_users");
    expect(tool1).toBeDefined();
    expect(tool1.title).toBe("Search Users");
    expect(tool1.description).toBe("Search users in system.");

    const tool2 = doc.tools.find((t: any) => t.name === "get_user_by_id");
    expect(tool2).toBeDefined();
  });

  test("emits compiler warning when object type with 0 methods is passed to mcpSchema", () => {
    const source = `
      import { mcpSchema } from "./src/index.ts";

      interface EmptyService {
        name: string;
      }

      export const schema = mcpSchema<[EmptyService]>();
    `;
    const warnings: string[] = [];
    const testLogger = {
      warn: (msg: string) => warnings.push(msg),
      error: () => {},
      info: () => {},
      debug: () => {},
      trace: () => {},
    };
    transformSource({ path: "test.ts", contents: source, logger: testLogger });
    expect(warnings.some((w) => w.includes("no methods found on object type 'EmptyService' for mcpSchema"))).toBe(true);
  });
});
