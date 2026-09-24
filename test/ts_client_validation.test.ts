// @wiz-ignore
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { extractApiIR } from "../src/extractors/openapi.ts";
import { generate } from "../src/generators/generator.ts";
import { tsClientGenerator } from "../src/generators/tsClient.ts";
import { silentLogger } from "../src/logger.ts";
import type { ApiIR } from "../src/ir/api.ts";
import { runGenerate } from "../src/cli/generate.ts";

/**
 * `Pet.name` and `petId` carry constraints, not just types: a check that only
 * proved `typeof x === "string"` would pass on a document with no constraints
 * at all, and say nothing about whether the document's own rules are enforced.
 */
const DOCUMENT = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Pets", version: "1.0.0" },
  components: {
    schemas: {
      Pet: {
        type: "object",
        required: ["id", "name"],
        properties: {
          id: { type: "string" },
          name: { type: "string", minLength: 3 },
        },
      },
    },
  },
  paths: {
    "/pets/{petId}": {
      get: {
        operationId: "getPet",
        parameters: [
          { name: "petId", in: "path", required: true, schema: { type: "string", minLength: 5 } },
          { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1 } },
          { name: "x-token", in: "header", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "One pet",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } },
          },
        },
      },
      post: {
        operationId: "createPet",
        parameters: [
          { name: "petId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } },
        },
        responses: {
          "200": {
            description: "The pet",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } },
          },
        },
      },
    },
  },
});

let api: ApiIR;

beforeAll(() => {
  api = extractApiIR(DOCUMENT, { format: "json" });
});

const emit = (validate: unknown) =>
  generate(api, tsClientGenerator, { validate } as never, silentLogger);

describe("what the option selects", () => {
  test("no option leaves the client exactly as it was", () => {
    const source = emit(undefined)["api.ts"]!;

    // The error type is the whole observable surface of the feature; a client
    // that does not validate must not carry it.
    expect(source).not.toContain("ClientValidationError");
    expect(source).not.toContain("__wizLength");
  });

  test("true validates every part", () => {
    const source = emit(true)["api.ts"]!;

    for (const target of ["path", "query", "headers", "body", "response"]) {
      expect(source).toContain(`throw new ClientValidationError("${target}"`);
    }
  });

  test("an array validates only the parts it names", () => {
    const source = emit(["path", "body"])["api.ts"]!;

    expect(source).toContain('throw new ClientValidationError("path"');
    expect(source).toContain('throw new ClientValidationError("body"');
    expect(source).not.toContain('throw new ClientValidationError("query"');
    expect(source).not.toContain('throw new ClientValidationError("headers"');
    expect(source).not.toContain('throw new ClientValidationError("response"');
  });

  test("an empty array validates nothing", () => {
    expect(emit([])["api.ts"]!).not.toContain("ClientValidationError");
  });

  /**
   * Every schema in an OpenAPI document arrives as a `$ref`, and the validator
   * emitter has no `ref` case. Without resolving them the checks would be
   * emitted but empty - the failure this pins is a client that appears to
   * validate and does not.
   */
  test("constraints behind a $ref are still enforced", () => {
    const source = emit(["response"])["api.ts"]!;

    expect(source).toContain("__wizLength");
    expect(source).toContain('constraint: "minLength"');
  });
});
/**
 * `--validate` is the only flag in this command whose value is optional, so
 * what it does and does not claim from the argument list is worth pinning.
 */
describe("the --validate flag", () => {
  let directory: string;
  let documentPath: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "wiz-validate-cli-"));
    documentPath = join(directory, "openapi.json");
    await Bun.write(documentPath, DOCUMENT);
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /** The targets the emitted client actually checks, read back off the file. */
  const targetsFor = async (...flags: string[]): Promise<string[]> => {
    const outdir = join(directory, `out-${flags.join("_") || "none"}`);
    expect(await runGenerate(["-g", "tsClient", documentPath, "-o", outdir, ...flags])).toBe(0);

    const source = await Bun.file(join(outdir, "api.ts")).text();
    const found = [...source.matchAll(/ClientValidationError\("([a-z]+)"/g)].map(
      (match) => match[1]!
    );
    return [...new Set(found)].sort();
  };

  test("without a value it validates everything", async () => {
    expect(await targetsFor("--validate")).toEqual([
      "body",
      "headers",
      "path",
      "query",
      "response",
    ]);
  });

  test("a comma-separated list narrows it", async () => {
    expect(await targetsFor("--validate", "path,response")).toEqual(["path", "response"]);
  });

  test("the `=` form is accepted too", async () => {
    expect(await targetsFor("--validate=query")).toEqual(["query"]);
  });

  test("a single target needs no comma", async () => {
    expect(await targetsFor("--validate", "body")).toEqual(["body"]);
  });

  test("omitting it validates nothing", async () => {
    expect(await targetsFor()).toEqual([]);
  });

  /**
   * The bare form must not eat the positional, which is the whole reason the
   * value is only claimed when it could be one.
   */
  test("the bare flag does not consume the input path", async () => {
    const outdir = join(directory, "out-before");
    expect(
      await runGenerate(["-g", "tsClient", "--validate", documentPath, "-o", outdir])
    ).toBe(0);
    expect(await Bun.file(join(outdir, "api.ts")).exists()).toBe(true);
  });

  test("a misspelled target is named, not silently ignored", async () => {
    expect(
      runGenerate(["-g", "tsClient", documentPath, "--validate=respones"])
    ).resolves.toBe(1);
    expect(
      runGenerate(["-g", "tsClient", documentPath, "--validate", "path,respones"])
    ).resolves.toBe(1);
  });
});

describe("emitted code compiles and runs", () => {
  let directory: string;
  let apiPath: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "wiz-validate-"));
    apiPath = join(directory, "api.ts");
    for (const [filename, contents] of Object.entries(emit(true))) {
      await Bun.write(join(directory, filename), contents);
    }
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /**
   * The checks are generated from a validator whose output is normally a
   * virtual JS module, so nothing typechecked it before. Emitted into a `.ts`
   * a consumer compiles, an unannotated helper or a constant-truthy test is
   * their build error, not ours.
   */
  test("typechecks under strict TypeScript", () => {
    const program = ts.createProgram([apiPath], {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true,
      skipLibCheck: true,
      lib: ["lib.esnext.d.ts", "lib.dom.d.ts"],
    });

    const diagnostics = [
      ...program.getSyntacticDiagnostics(),
      ...program.getSemanticDiagnostics(),
    ].map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")
    );

    expect(diagnostics).toEqual([]);
  });
  interface Client {
    getPet(path: { petId: string }, headers: { "x-token": string }, query?: { limit?: number }): Promise<unknown>;
    createPet(path: { petId: string }, body: { id: string; name: string }): Promise<unknown>;
  }

  interface ClientModule {
    createClient(config: Record<string, unknown>): Client;
  }
  /** A client whose transport answers with `pet`, so only the checks can fail. */
  const load = async (pet: unknown): Promise<Client> => {
    const module = (await import(apiPath)) as ClientModule;
    return module.createClient({
      baseUrl: "https://pets.test",
      transport: async () =>
        new Response(JSON.stringify(pet), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
  };

  const valid = { id: "p1", name: "Rex" };

  /** The thrown value, or `undefined` when the call was allowed through. */
  const rejection = async (call: () => Promise<unknown>) => {
    try {
      await call();
      return undefined;
    } catch (error) {
      return error as Error & { target?: string };
    }
  };

  test("a request the document allows is sent", async () => {
    const client = await load(valid);

    expect(
      await client.getPet({ petId: "abcdef" }, { "x-token": "t" })
    ).toEqual(valid);
  });

  /**
   * `minLength: 5` on a path parameter. A type-only check would pass this, so
   * this is what says the document's constraints reached the client.
   */
  test("a path parameter breaking its constraint is rejected", async () => {
    const client = await load(valid);
    const error = await rejection(() =>
      client.getPet({ petId: "abc" }, { "x-token": "t" })
    );

    expect(error?.name).toBe("ClientValidationError");
    expect(error?.target).toBe("path");
    expect(error?.message).toContain("path.petId");
  });

  test("a query parameter breaking its constraint is rejected", async () => {
    const client = await load(valid);
    const error = await rejection(() =>
      client.getPet(
        { petId: "abcdef" },
        { "x-token": "t" },
        { limit: 0 }
      )
    );

    expect(error?.target).toBe("query");
    expect(error?.message).toContain("query.limit");
  });

  test("an absent required header is rejected", async () => {
    const client = await load(valid);
    const error = await rejection(() => client.getPet({ petId: "abcdef" }, undefined as any));

    expect(error?.target).toBe("headers");
  });

  test("an absent optional query is not", async () => {
    const client = await load(valid);

    expect(
      await client.getPet({ petId: "abcdef" }, { "x-token": "t" })
    ).toEqual(valid);
  });

  test("a request body breaking its constraint is rejected", async () => {
    const client = await load(valid);
    const error = await rejection(() =>
      client.createPet({ petId: "p1" }, { id: "1", name: "ab" })
    );

    expect(error?.target).toBe("body");
    expect(error?.message).toContain("body.name");
  });

  /**
   * The response is checked after decoding, so what the caller would have been
   * handed is the value that failed - not a second reading of the body.
   */
  test("a response the server got wrong is rejected", async () => {
    const client = await load({ id: "p1", name: "R" });
    const error = await rejection(() =>
      client.getPet({ petId: "abcdef" }, { "x-token": "t" })
    );

    expect(error?.target).toBe("response");
    expect(error?.message).toContain("response.name");
  });

  test("a response missing a required property is rejected", async () => {
    const client = await load({ id: "p1" });
    const error = await rejection(() =>
      client.getPet({ petId: "abcdef" }, { "x-token": "t" })
    );

    expect(error?.target).toBe("response");
    expect(error?.message).toContain("Required property is missing");
  });
});
