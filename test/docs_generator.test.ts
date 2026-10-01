import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractApiIR } from "../src/extractors/openapi.ts";
import { docsGenerator } from "../src/generators/docs.ts";
import { silentLogger } from "../src/logger.ts";

describe("Documentation Generator with SSR Shiki Syntax Highlighting", () => {
    let tempDir: string;

    const PETSTORE_DOC = JSON.stringify({
        openapi: "3.1.0",
        info: {
            title: "PetStore OpenAPI",
            version: "2.4.0",
            description:
                '# Welcome to PetStore\n\nManage pets easily with our **RESTful API**.\n\n```json\n{"sample": true}\n```',
        },
        components: {
            securitySchemes: {
                bearerAuth: {
                    type: "http",
                    scheme: "bearer",
                },
            },
            schemas: {
                Pet: {
                    type: "object",
                    required: ["id", "name"],
                    properties: {
                        id: { type: "string" },
                        name: { type: "string" },
                        status: { type: "string", enum: ["available", "pending", "sold"] },
                    },
                },
            },
        },
        paths: {
            "/pets": {
                get: {
                    operationId: "listPets",
                    summary: "List all pets",
                    description: "Retrieves a paginated list of pets.\n\n- Filter by status\n- Paginate with `limit`",
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
                    summary: "Create a new pet",
                    requestBody: {
                        required: true,
                        content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } },
                    },
                    responses: {
                        "201": {
                            description: "Created",
                            content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } },
                        },
                    },
                },
            },
        },
    });

    beforeAll(async () => {
        tempDir = await mkdtemp(join(tmpdir(), "wiz-docs-test-"));
    });

    afterAll(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    test("generates self-contained index.html with 3-column layout, sticky TOC, and highlighted code", async () => {
        const ir = extractApiIR(PETSTORE_DOC, { format: "json" });
        const files = await docsGenerator.api!(ir, {
            options: {},
            logger: silentLogger,
        });

        expect(files["index.html"]).toBeDefined();
        const html = files["index.html"]!;

        // 1. Structure
        expect(html).toContain("<!DOCTYPE html>");
        expect(html).toContain("<title>PetStore OpenAPI</title>");
        expect(html).toContain('<nav id="sidebar-toc">');
        expect(html).toContain('<main id="main-content">');
        expect(html).toContain('<div class="operation-grid">');

        // 2. Sticky TOC
        expect(html).toContain("Version 2.4.0");
        expect(html).toContain('href="#op-listPets"');
        expect(html).toContain('href="#op-createPet"');
        expect(html).toContain('<span class="badge badge-get">GET</span>');
        expect(html).toContain('<span class="badge badge-post">POST</span>');

        // 3. Markdown Rendering via Bun.markdown.html
        expect(html).toContain("<h1>Welcome to PetStore</h1>");
        expect(html).toContain("<strong>RESTful API</strong>");

        // 4. Shiki Syntax Highlighting
        expect(html).toContain('<pre class="shiki');
        expect(html).toContain("Pet");
        expect(html).toContain("available");
        expect(html).toContain("available");

        // 5. Schemas and Examples on the right column
        expect(html).toContain('<div class="operation-sidebar">');
        expect(html).toContain("Request Example (JSON)");
        expect(html).toContain("Response Example (200)");
    });

    test("CLI generate -g docs creates index.html", async () => {
        const specPath = join(tempDir, "spec.json");
        await writeFile(specPath, PETSTORE_DOC);

        const outDir = join(tempDir, "out-docs");
        const proc = Bun.spawn(["bun", "src/cli.ts", "generate", "-g", "docs", "--outdir", outDir, specPath], {
            stdout: "pipe",
            stderr: "pipe",
        });
        await proc.exited;

        const generatedHtml = await Bun.file(join(outDir, "index.html")).text();
        expect(generatedHtml).toContain("PetStore OpenAPI");
        expect(generatedHtml).toContain('id="sidebar-toc"');
    });
});
