import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleOpenApiDocument, extractApiIRFromFile } from "../src/extractors/openapi.ts";
import { generate } from "../src/generators/generator.ts";
import { tsClientGenerator } from "../src/generators/tsClient.ts";
import { silentLogger } from "../src/logger.ts";

describe("Multi-file OpenAPI specification bundling and extraction", () => {
    let tempDir: string;

    beforeAll(async () => {
        tempDir = await mkdtemp(join(tmpdir(), "wiz-multifile-test-"));

        // Build a multi-file tree:
        // root.yaml
        // models/pet.yaml
        // models/error.yaml
        // resources/pets_get.yaml
        // resources/pets_post.yaml
        await mkdir(join(tempDir, "models"), { recursive: true });
        await mkdir(join(tempDir, "resources"), { recursive: true });

        await writeFile(
            join(tempDir, "models", "pet.yaml"),
            `
type: object
required:
  - id
  - name
properties:
  id:
    type: string
  name:
    type: string
  tag:
    type: string
`,
        );

        await writeFile(
            join(tempDir, "models", "error.yaml"),
            `
type: object
required:
  - code
  - message
properties:
  code:
    type: integer
  message:
    type: string
`,
        );

        await writeFile(
            join(tempDir, "resources", "pets_get.yaml"),
            `
summary: List all pets
operationId: listPets
parameters:
  - name: limit
    in: query
    schema:
      type: integer
responses:
  '200':
    description: A paged array of pets
    content:
      application/json:
        schema:
          type: array
          items:
            $ref: "../models/pet.yaml"
  default:
    description: unexpected error
    content:
      application/json:
        schema:
          $ref: "../models/error.yaml"
`,
        );

        await writeFile(
            join(tempDir, "resources", "pets_post.yaml"),
            `
summary: Create a pet
operationId: createPet
requestBody:
  required: true
  content:
    application/json:
      schema:
        $ref: "../models/pet.yaml"
responses:
  '201':
    description: Null response
`,
        );

        await writeFile(
            join(tempDir, "root.yaml"),
            `
openapi: "3.0.0"
info:
  version: 1.0.0
  title: MultiFile Petstore
paths:
  /pets:
    get:
      $ref: "resources/pets_get.yaml"
    post:
      $ref: "resources/pets_post.yaml"
`,
        );
    });

    afterAll(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    test("bundleOpenApiDocument bundles external file references and hoists canonical schemas", async () => {
        const rootPath = join(tempDir, "root.yaml");
        const bundled = (await bundleOpenApiDocument(rootPath)) as any;

        expect(bundled.openapi).toBe("3.0.0");
        expect(bundled.info.title).toBe("MultiFile Petstore");
        expect(bundled.paths["/pets"].get.operationId).toBe("listPets");
        expect(bundled.paths["/pets"].post.operationId).toBe("createPet");

        expect(bundled.components?.schemas?.pet).toBeDefined();
        expect(bundled.components?.schemas?.pet?.properties?.name?.type).toBe("string");
        expect(bundled.components?.schemas?.error).toBeDefined();
        expect(bundled.components?.schemas?.error?.properties?.code?.type).toBe("integer");
    });

    test("extractApiIRFromFile extracts full IR with service methods and hoisted types", async () => {
        const rootPath = join(tempDir, "root.yaml");
        const ir = await extractApiIRFromFile(rootPath);

        expect(ir.service.name).toBe("MultiFile Petstore");
        expect(ir.service.methods).toHaveLength(2);
        const methodNames = ir.service.methods.map((m) => ("method" in m.address ? m.address.method : undefined));
        expect(methodNames).toContain("GET");
        expect(methodNames).toContain("POST");
        expect(ir.types.has("pet")).toBe(true);
        expect(ir.types.has("error")).toBe(true);
    });

    test("generates standalone TypeScript client from multi-file spec", async () => {
        const rootPath = join(tempDir, "root.yaml");
        const ir = await extractApiIRFromFile(rootPath);
        const files = generate(ir, tsClientGenerator, {}, silentLogger);

        expect(files["api.ts"]).toBeDefined();
        expect(files["model.ts"]).toBeDefined();

        expect(files["api.ts"]).toContain("listPets(");
        expect(files["api.ts"]).toContain("createPet(");
        expect(files["model.ts"]).toContain("export interface pet {");
        expect(files["model.ts"]).toContain("export interface error {");
    });
});
