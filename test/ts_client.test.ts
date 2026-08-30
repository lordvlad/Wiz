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

const DOCUMENT = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Pets", version: "1.0.0" },
  components: {
    schemas: {
      Pet: {
        type: "object",
        description: "An animal on file",
        required: ["id", "name"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
      },
      NewPet: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
      },
      "error-response": {
        type: "object",
        properties: { message: { type: "string" } },
      },
    },
  },
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        summary: "Every pet on file",
        parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }],
        responses: {
          "200": {
            description: "ok",
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
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/NewPet" } },
          },
        },
        responses: {
          "201": {
            description: "created",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Pet" } },
            },
          },
        },
      },
    },
    "/pets/{petId}": {
      get: {
        operationId: "getPetById",
        parameters: [
          { name: "petId", in: "path", required: true, schema: { type: "string" } },
          { name: "x-trace-id", in: "header", schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Pet" } },
            },
          },
          "404": {
            description: "missing",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/error-response" },
              },
            },
          },
        },
      },
      delete: {
        operationId: "deletePet",
        parameters: [
          { name: "petId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "204": { description: "gone" } },
      },
    },
  },
});

let api: ApiIR;
let files: Record<string, string>;

beforeAll(() => {
  api = extractApiIR(DOCUMENT, { format: "json" });
  files = generate(api, tsClientGenerator, {}, silentLogger);
});

describe("emitted files", () => {
  test("the document becomes a model and an api file", () => {
    expect(Object.keys(files).sort()).toEqual(["api.ts", "model.ts"]);
  });

  test("model.ts declares every schema, with unnameable ones sanitised", () => {
    const model = files["model.ts"]!;
    expect(model).toContain("export interface Pet {");
    expect(model).toContain("/** An animal on file */");
    expect(model).toContain("id: string;");
    expect(model).toContain("tags?: string[];");
    expect(model).toContain("export interface NewPet {");
    expect(model).toContain("export interface error_response {");
  });

  test("api.ts imports only the models its signatures mention", () => {
    const source = files["api.ts"]!;
    expect(source).toContain('import type { NewPet, Pet } from "./model.ts";');
    // The 404 payload is thrown, never returned, so it is not in a signature.
    expect(source).not.toContain("error_response");
  });

  test("each operation takes exactly the slots it declares", () => {
    const source = files["api.ts"]!;

    // Only an optional query, so the whole argument is optional.
    expect(source).toContain("listPets(options?: { query?: { limit?: number } }): Promise<Pet[]>;");
    // A required body is a required argument.
    expect(source).toContain("createPet(options: { body: NewPet }): Promise<Pet>;");
    // Path is required, the header is not, and the header name needs quoting.
    expect(source).toContain('getPetById(options: { path: { petId: string }; headers?: { "x-trace-id"?: string } }): Promise<Pet>;');
    // No content means no payload to type.
    expect(source).toContain("deletePet(options: { path: { petId: string } }): Promise<void>;");
  });

  test("operations are reachable as a client and as module-level functions", () => {
    const source = files["api.ts"]!;

    expect(source).toContain("export interface Client {");
    expect(source).toContain(
      "export function createClient(overrides: Partial<ClientConfig> = {}): Client {"
    );
    // The free function is typed from the interface, so the two cannot drift.
    expect(source).toContain(
      'export const listPets: Client["listPets"] = (options) => client.listPets(options);'
    );
    // Four operations, four request bodies: the delegates forward, they do not
    // re-implement.
    expect(source.match(/send\(config, \{/g)).toHaveLength(4);
  });

  test("summaries reach the emitted method", () => {
    expect(files["api.ts"]!).toContain("/** Every pet on file */");
  });

  test("lenient widens the parameter objects and adds the missing ones", () => {
    const lenient = generate(api, tsClientGenerator, { lenient: true }, silentLogger);
    const source = lenient["api.ts"]!;

    expect(source).toContain("{ limit?: number } & Record<string, string | boolean>");
    expect(source).toContain('{ "x-trace-id"?: string } & Record<string, string>');
    // A method that declares neither still gets both, or "lenient" would mean
    // "lenient only where the document already helped".
    expect(source).toContain("query?: Record<string, string | boolean>");
    expect(source).toContain("headers?: Record<string, string>");
  });
});

describe("emitted code compiles and runs", () => {
  let directory: string;
  let apiPath: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "wiz-client-"));
    apiPath = join(directory, "api.ts");
    await Bun.write(join(directory, "model.ts"), files["model.ts"]!);
    await Bun.write(apiPath, files["api.ts"]!);
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

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

  /**
   * The emitted module is plain TypeScript with no wiz import, so the only way
   * to check the wire it builds is to run it against a fetch of our own.
   */
  interface Sent {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }

  interface ClientConfigLike {
    baseUrl?: string;
    fetch?: (
      url: string,
      init: { method: string; headers: Record<string, string>; body?: string }
    ) => Promise<Response>;
    beforeCall?: (call: Sent) => Sent | Promise<Sent>;
    afterCall?: (result: { call: Sent; response: Response }) => unknown;
  }

  interface Operations {
    listPets(options?: { query?: { limit?: number } }): Promise<unknown>;
    createPet(options: { body: { name: string } }): Promise<unknown>;
    getPetById(options: {
      path: { petId: string };
      headers?: { "x-trace-id"?: string };
    }): Promise<unknown>;
    deletePet(options: { path: { petId: string } }): Promise<unknown>;
  }

  interface ClientModule extends Operations {
    configure(next: ClientConfigLike): void;
    createClient(overrides?: ClientConfigLike): Operations;
    ApiError: new (...args: never[]) => Error & { status: number; body: unknown };
  }

  const load = async (
    respond: (sent: Sent) => Response,
    sent: Sent[],
    hooks: { authorization?: string; seen?: number[] } = {}
  ): Promise<ClientModule> => {
    // A generated module is an external boundary: the shape is asserted once,
    // here, rather than at every call.
    const client = (await import(apiPath)) as unknown as ClientModule;

    client.configure({
      baseUrl: "https://api.test",
      fetch: async (url, init) => {
        const call = { url, method: init.method, headers: init.headers, body: init.body };
        sent.push(call);
        return respond(call);
      },
      beforeCall: (call) =>
        hooks.authorization
          ? { ...call, headers: { ...call.headers, authorization: hooks.authorization } }
          : call,
      afterCall: (result) => {
        hooks.seen?.push(result.response.status);
        return result;
      },
    });

    return client;
  };

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  test("a path parameter is encoded into the URL and the response is parsed", async () => {
    const sent: Sent[] = [];
    const seen: number[] = [];
    const client = await load(() => json({ id: "p1", name: "Rex" }), sent, {
      authorization: "Bearer token",
      seen,
    });

    const pet = await client.getPetById({
      path: { petId: "p 1" },
      headers: { "x-trace-id": "t1" },
    });

    expect(pet).toEqual({ id: "p1", name: "Rex" });
    expect(sent[0]!.url).toBe("https://api.test/pets/p%201");
    expect(sent[0]!.method).toBe("GET");
    // The before hook is where an Authorization header comes from.
    expect(sent[0]!.headers.authorization).toBe("Bearer token");
    expect(sent[0]!.headers["x-trace-id"]).toBe("t1");
    // The after hook sees the response before the status is judged.
    expect(seen).toEqual([200]);
  });

  test("query parameters are serialised and omitted when absent", async () => {
    const sent: Sent[] = [];
    const client = await load(() => json([]), sent);

    await client.listPets({ query: { limit: 2 } });
    await client.listPets();

    expect(sent[0]!.url).toBe("https://api.test/pets?limit=2");
    expect(sent[1]!.url).toBe("https://api.test/pets");
  });

  test("a body is sent as JSON with the media type the document declared", async () => {
    const sent: Sent[] = [];
    const client = await load(() => json({ id: "p2", name: "Ada" }, 201), sent);

    await client.createPet({ body: { name: "Ada" } });

    expect(sent[0]!.method).toBe("POST");
    expect(sent[0]!.headers["content-type"]).toBe("application/json");
    expect(sent[0]!.body).toBe('{"name":"Ada"}');
  });

  test("no content resolves to nothing", async () => {
    const sent: Sent[] = [];
    const client = await load(() => new Response(null, { status: 204 }), sent);

    expect(await client.deletePet({ path: { petId: "p1" } })).toBeUndefined();
  });

  test("a failure throws with the status and the parsed body", async () => {
    const sent: Sent[] = [];
    const client = await load(() => json({ message: "gone" }, 404), sent);

    const failure = await client
      .getPetById({ path: { petId: "p1" } })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(client.ApiError);
    if (!(failure instanceof client.ApiError)) throw new Error("expected ApiError");
    expect(failure.status).toBe(404);
    expect(failure.body).toEqual({ message: "gone" });
  });

  /**
   * The module-level functions are one deployment's worth of client. A caller
   * with two tenants needs two, sharing nothing.
   */
  test("createClient keeps two configurations apart", async () => {
    const client = await load(() => json({ id: "p1", name: "Rex" }), []);

    const first: Sent[] = [];
    const second: Sent[] = [];

    const tenantA = client.createClient({
      baseUrl: "https://a.test",
      fetch: async (url, init) => {
        first.push({ url, method: init.method, headers: init.headers, body: init.body });
        return json({ id: "a", name: "A" });
      },
      beforeCall: (call) => ({
        ...call,
        headers: { ...call.headers, authorization: "Bearer a" },
      }),
    });

    const tenantB = client.createClient({
      baseUrl: "https://b.test",
      fetch: async (url, init) => {
        second.push({ url, method: init.method, headers: init.headers, body: init.body });
        return json({ id: "b", name: "B" });
      },
    });

    expect(await tenantA.getPetById({ path: { petId: "x" } })).toEqual({
      id: "a",
      name: "A",
    });
    expect(await tenantB.getPetById({ path: { petId: "x" } })).toEqual({
      id: "b",
      name: "B",
    });

    expect(first[0]!.url).toBe("https://a.test/pets/x");
    expect(second[0]!.url).toBe("https://b.test/pets/x");
    // One tenant's hook must not reach the other's call.
    expect(first[0]!.headers.authorization).toBe("Bearer a");
    expect(second[0]!.headers.authorization).toBeUndefined();
    // And neither disturbs the module-level configuration.
    expect(second).toHaveLength(1);
  });
});
