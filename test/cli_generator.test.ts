import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractApiIR } from "../src/extractors/openapi.ts";
import { cliGenerator } from "../src/generators/cli.ts";
import { generate } from "../src/generators/generator.ts";
import { silentLogger } from "../src/logger.ts";

describe("CLI Generator with persistent Bun.secrets and auth helper", () => {
    let tempDir: string;
    let cliPath: string;

    const PETSTORE_DOC = JSON.stringify({
        openapi: "3.1.0",
        info: { title: "PetStore", version: "1.0.0" },
        components: {
            securitySchemes: {
                bearerAuth: {
                    type: "http",
                    scheme: "bearer",
                },
                apiKeyAuth: {
                    type: "apiKey",
                    in: "header",
                    name: "x-api-key",
                },
            },
            schemas: {
                Pet: {
                    type: "object",
                    required: ["id", "name"],
                    properties: {
                        id: { type: "string" },
                        name: { type: "string" },
                    },
                },
            },
        },
        paths: {
            "/pets": {
                get: {
                    operationId: "listPets",
                    summary: "List all pets",
                    parameters: [{ name: "limit", in: "query", schema: { type: "number" } }],
                    responses: {
                        "200": {
                            description: "List of pets",
                            content: {
                                "application/json": {
                                    schema: { type: "array", items: { $ref: "#/components/schemas/Pet" } },
                                },
                            },
                        },
                    },
                },
                post: {
                    operationId: "createPet",
                    summary: "Create a pet",
                    requestBody: {
                        required: true,
                        content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } },
                    },
                    responses: {
                        "200": {
                            description: "Created pet",
                            content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } },
                        },
                    },
                },
            },
            "/pets/{petId}": {
                get: {
                    operationId: "getPet",
                    summary: "Get pet by ID",
                    parameters: [{ name: "petId", in: "path", required: true, schema: { type: "string" } }],
                    responses: {
                        "200": {
                            description: "A pet",
                            content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } },
                        },
                    },
                },
            },
        },
    });

    beforeAll(async () => {
        tempDir = await mkdtemp(join(tmpdir(), "wiz-cli-gen-test-"));
        const ir = extractApiIR(PETSTORE_DOC, { format: "json" });
        const files = generate(ir, cliGenerator, { binName: "petstore" }, silentLogger);
        for (const [name, content] of Object.entries(files)) {
            await writeFile(join(tempDir, name), content);
        }
        cliPath = join(tempDir, "cli.ts");
    });

    afterAll(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    test("generates standalone cli.ts alongside client files", () => {
        const ir = extractApiIR(PETSTORE_DOC, { format: "json" });
        const files = generate(ir, cliGenerator, { binName: "petstore" }, silentLogger);

        expect(files["api.ts"]).toBeDefined();
        expect(files["model.ts"]).toBeDefined();
        expect(files["cli.ts"]).toBeDefined();

        const cli = files["cli.ts"]!;
        expect(cli).toContain("#!/usr/bin/env bun");
        expect(cli).toContain('const BIN_NAME = "petstore";');
        expect(cli).toContain("function getEnv()");
        expect(cli).toContain("async function handleConfig(");
        expect(cli).toContain("async function handleAuth(");
        expect(cli).toContain('case "listPets":');
        expect(cli).toContain('case "createPet":');
        expect(cli).toContain('case "getPet":');
    });

    test("runs CLI help command without error", async () => {
        const proc = Bun.spawn(["bun", cliPath, "--help"], {
            stdout: "pipe",
            stderr: "pipe",
        });
        const out = await new Response(proc.stdout).text();
        await proc.exited;

        expect(out).toContain("Usage: petstore <command>");
        expect(out).toContain("config [key] [value]");
        expect(out).toContain("auth");
        expect(out).toContain("listPets");
        expect(out).toContain("getPet");
    });

    test("config command sets and gets configuration scoped by environment", async () => {
        // Set baseUrl in default env
        const p1 = Bun.spawn(["bun", cliPath, "config", "baseUrl", "https://petstore.default.test"], {
            stdout: "pipe",
        });
        await p1.exited;

        // Set baseUrl in staging env
        const p2 = Bun.spawn(
            ["bun", cliPath, "config", "baseUrl", "https://petstore.staging.test", "--env", "staging"],
            {
                stdout: "pipe",
            },
        );
        await p2.exited;

        // Read back default
        const p3 = Bun.spawn(["bun", cliPath, "config", "baseUrl"], {
            stdout: "pipe",
        });
        const outDefault = await new Response(p3.stdout).text();
        await p3.exited;
        expect(outDefault).toContain("baseUrl: https://petstore.default.test");

        // Read back staging
        const p4 = Bun.spawn(["bun", cliPath, "config", "baseUrl", "--env", "staging"], {
            stdout: "pipe",
        });
        const outStaging = await new Response(p4.stdout).text();
        await p4.exited;
        expect(outStaging).toContain("baseUrl: https://petstore.staging.test");
    });
});
