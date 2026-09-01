import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runGenerate } from "../src/cli/generate.ts";
import { openRPCHandler } from "../src/server/openrpc.ts";

describe("OpenRPC CLI Generation & End-to-End Test", () => {
  test("wiz generate -g tsClient.ts from OpenRPC document", async () => {
    const spec = JSON.stringify({
      openrpc: "1.3.0",
      info: { title: "PetStore", version: "1.0.0" },
      methods: [
        {
          name: "PetService.getPet",
          params: [{ name: "id", required: true, schema: { type: "string" } }],
          result: { name: "pet", schema: { $ref: "#/components/schemas/Pet" } },
        },
      ],
      components: {
        schemas: {
          Pet: {
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

    const tmpDir = join("/tmp", `openrpc_cli_test_${Date.now()}`);
    const specFile = join(tmpDir, "openrpc.json");
    const outDir = join(tmpDir, "client");

    await Bun.write(specFile, spec);

    const tsClientPath = join(process.cwd(), "src/generators/tsClient.ts");
    const code = await runGenerate([
      "-g",
      tsClientPath,
      specFile,
      "-o",
      outDir,
    ]);

    expect(code).toBe(0);

    const modelFile = Bun.file(join(outDir, "model.ts"));
    const apiFile = Bun.file(join(outDir, "api.ts"));

    expect(await modelFile.exists()).toBe(true);
    expect(await apiFile.exists()).toBe(true);

    const modelContent = await modelFile.text();
    const apiContent = await apiFile.text();

    expect(modelContent).toContain("export interface Pet");
    expect(apiContent).toContain("getPet");
  });
});
