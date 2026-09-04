// @wiz-ignore
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { extractApiIR } from "../src/extractors/openapi.ts";
import { generate } from "../src/generators/generator.ts";
import { reactQueryGenerator } from "../src/generators/reactQuery.ts";
import { silentLogger } from "../src/logger.ts";
import { runGenerate } from "../src/cli/generate.ts";
import type { ApiIR } from "../src/ir/api.ts";

const DOCUMENT = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Petstore", version: "1.0.0" },
  components: {
    schemas: {
      Pet: {
        type: "object",
        required: ["id", "name"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
        },
      },
      NewPet: {
        type: "object",
        required: ["name"],
        properties: {
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
        parameters: [
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer" },
          },
        ],
        responses: {
          "200": {
            description: "A list of pets",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Pet" },
                },
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
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/NewPet" },
            },
          },
        },
        responses: {
          "201": {
            description: "Created pet",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Pet" },
              },
            },
          },
        },
      },
    },
    "/pets/{petId}": {
      get: {
        operationId: "getPetByPetId",
        summary: "Info for a specific pet",
        parameters: [
          {
            name: "petId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Expected response to a valid request",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Pet" },
              },
            },
          },
        },
      },
      delete: {
        operationId: "deletePet",
        summary: "Delete a pet",
        parameters: [
          {
            name: "petId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "204": {
            description: "Pet deleted",
          },
        },
      },
    },
  },
});

let api: ApiIR;
let files: Record<string, string>;
let tempDir: string;

beforeAll(async () => {
  api = extractApiIR(DOCUMENT, { format: "json" });
  files = generate(api, reactQueryGenerator, {}, silentLogger);
  tempDir = await mkdtemp(join(tmpdir(), "wiz-react-query-test-"));
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("reactQueryGenerator basic code generation", () => {
  test("emits model.ts, api.ts, codec.ts, queries.ts, and mutations.ts", () => {
    expect(Object.keys(files).sort()).toEqual([
      "api.ts",
      "codec.ts",
      "model.ts",
      "mutations.ts",
      "queries.ts",
    ]);
  });

  test("queries.ts contains GET operations (listPets, getPetByPetId)", () => {
    const queries = files["queries.ts"]!;
    expect(queries).toContain("export function getListPetsQueryOptions");
    expect(queries).toContain("export function useListPets");
    expect(queries).toContain("export function getGetPetByPetIdQueryOptions");
    expect(queries).toContain("export function useGetPetByPetId");
    expect(queries).toContain("export function createQueries");
    expect(queries).toContain("export function createHooks");
  });

  test("mutations.ts contains POST/DELETE operations (createPet, deletePet)", () => {
    const mutations = files["mutations.ts"]!;
    expect(mutations).toContain("export function getCreatePetMutationOptions");
    expect(mutations).toContain("export function useCreatePet");
    expect(mutations).toContain("export function getDeletePetMutationOptions");
    expect(mutations).toContain("export function useDeletePet");
    expect(mutations).toContain("export function createMutations");
  });

  test("query keys start with path template and include options parameter", () => {
    const queries = files["queries.ts"]!;
    expect(queries).toContain('queryKey: ["/pets", options] as const');
    expect(queries).toContain('queryKey: ["/pets/{petId}", options] as const');
  });

  test("mutation keys use path template and HTTP method", () => {
    const mutations = files["mutations.ts"]!;
    expect(mutations).toContain('mutationKey: ["/pets", "POST"] as const');
    expect(mutations).toContain('mutationKey: ["/pets/{petId}", "DELETE"] as const');
  });
});

describe("Multi-tenancy & query options verification", () => {
  test("queries.ts re-uses options getter inside query hook", () => {
    const queries = files["queries.ts"]!;
    expect(queries).toContain("return useQuery(getListPetsQueryOptions(options!, queryOptions, client));");
    expect(queries).toContain("return useQuery(getGetPetByPetIdQueryOptions(options, queryOptions, client));");
  });

  test("mutations.ts re-uses mutation options getter inside mutation hook", () => {
    const mutations = files["mutations.ts"]!;
    expect(mutations).toContain("return useMutation(getCreatePetMutationOptions(mutationOptions, client));");
    expect(mutations).toContain("return useMutation(getDeletePetMutationOptions(mutationOptions, client));");
  });

  test("createQueries, createMutations, and createHooks bind operations to client instance", () => {
    const queries = files["queries.ts"]!;
    const mutations = files["mutations.ts"]!;

    expect(queries).toContain("export function createQueries(client: Client = defaultClient())");
    expect(mutations).toContain("export function createMutations(client: Client = defaultClient())");
    expect(queries).toContain("export function createHooks(client: Client = defaultClient())");
    expect(queries).toContain("...createQueries(client)");
    expect(queries).toContain("...createMutations(client)");
  });

  /**
   * A default of `createClient()` built a client per invocation, so `configure()`
   * on the module-level one never reached a hook.
   */
  test("every client default is the module-level client, not a fresh one", () => {
    const queries = files["queries.ts"]!;
    const mutations = files["mutations.ts"]!;

    for (const source of [queries, mutations]) {
      expect(source).toContain('import { defaultClient, type Client } from "./api.ts";');
      expect(source).toContain("client: Client = defaultClient()");
      expect(source).not.toContain("createClient()");
    }

    expect(files["api.ts"]!).toContain("export function defaultClient(): Client {");
  });
});

describe("CLI Generator Resolution & Typechecking", () => {
  test("CLI resolves -g reactQuery shortcut and emits files", async () => {
    const docPath = join(tempDir, "openapi.json");
    const outDir = join(tempDir, "client");

    await Bun.write(docPath, DOCUMENT);
    const exitCode = await runGenerate(["-g", "reactQuery", docPath, "-o", outDir]);

    expect(exitCode).toBe(0);
    expect(await Bun.file(join(outDir, "queries.ts")).exists()).toBe(true);
    expect(await Bun.file(join(outDir, "mutations.ts")).exists()).toBe(true);
    expect(await Bun.file(join(outDir, "api.ts")).exists()).toBe(true);
  });

  test("emitted code typechecks under TypeScript compiler", async () => {
    const outDir = join(tempDir, "client");
    const stubPath = join(outDir, "react-query-stub.d.ts");
    await Bun.write(
      stubPath,
      'declare module "@tanstack/react-query" { export type UseQueryOptions<TData=any, TError=any, TQueryData=any> = any; export type UseMutationOptions<TData=any, TError=any, TVariables=any> = any; export function useQuery(...args: any[]): any; export function useMutation(...args: any[]): any; }'
    );

    const program = ts.createProgram(
      [
        stubPath,
        join(outDir, "model.ts"),
        join(outDir, "codec.ts"),
        join(outDir, "api.ts"),
        join(outDir, "queries.ts"),
        join(outDir, "mutations.ts"),
      ],
      {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        allowImportingTsExtensions: true,
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      }
    );

    const diagnostics = ts.getPreEmitDiagnostics(program);
    const errors = diagnostics
      .filter((d) => d.category === ts.DiagnosticCategory.Error)
      .map((d) => `${d.file?.fileName}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);

    expect(errors).toEqual([]);
  });
});
