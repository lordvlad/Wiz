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
    expect(Object.keys(files).sort()).toEqual(["api.ts", "codec.ts", "model.ts"]);
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

    // The slots are named once, at the module that owns them, and the signature
    // refers to that name.
    // Only an optional query, so the whole argument is optional.
    expect(source).toContain(
      "export type ListPetsOptions = { query?: { limit?: number } };"
    );
    expect(source).toContain("export type ListPetsResult = Pet[];");
    expect(source).toContain(
      "listPets(query?: { limit?: number }, callOptions?: HttpCallOptions): Promise<ListPetsResult>;"
    );
    expect(source).toContain("export type CreatePetOptions = { body: NewPet };");
    expect(source).toContain(
      "createPet(body: NewPet, callOptions?: HttpCallOptions): Promise<CreatePetResult>;"
    );
    // Path is required, the header is not, and the header name needs quoting.
    expect(source).toContain(
      'export type GetPetByIdOptions = { path: { petId: string }; headers?: { "x-trace-id"?: string } };'
    );
    expect(source).toContain(
      'getPetById(path: { petId: string }, headers?: { "x-trace-id"?: string }, callOptions?: HttpCallOptions): Promise<GetPetByIdResult>;'
    );
    // No content means no payload to type.
    expect(source).toContain(
      "export type DeletePetOptions = { path: { petId: string } };"
    );
    expect(source).toContain("export type DeletePetResult = void;");
    expect(source).toContain(
      "deletePet(path: { petId: string }, callOptions?: HttpCallOptions): Promise<void>;"
    );
  });

  test("operations are reachable as a client and as module-level functions", () => {
    const source = files["api.ts"]!;

    expect(source).toContain("export interface Client {");
    expect(source).toContain(
      "export function createClient(overrides: Partial<ClientConfig> = {}): Client {"
    );
    // The free function is typed from the interface, so the two cannot drift,
    // and it forwards the per-call options along with the slots.
    expect(source).toContain(
      "export const listPets: Client[\"listPets\"] = (query, callOptions) => client.listPets(query, callOptions);"
    );
    // Four operations, four request bodies: the delegates forward, they do not
    // re-implement.
    expect(source.match(/send\(config, \{/g)).toHaveLength(4);
    // The module-level client is reachable, so a hook or another generated file
    // can default to the one `configure` maintains instead of building its own.
    expect(source).toContain("export function defaultClient(): Client {");
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
    for (const [filename, contents] of Object.entries(files)) {
      await Bun.write(join(directory, filename), contents);
    }
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

  interface ResultLike {
    call: Sent;
    response: Response;
  }

  type InterceptorLike = (
    call: Sent,
    next: (call: Sent) => Promise<ResultLike>
  ) => Promise<ResultLike>;

  interface ClientConfigLike {
    baseUrl?: string;
    timeoutMs?: number;
    transport?:
      | { call(call: Sent): Promise<Response> }
      | ((
          url: string,
          init: {
            method: string;
            headers: Record<string, string>;
            body?: string;
            signal?: AbortSignal;
          }
        ) => Promise<Response>);
    interceptors?: { http?: InterceptorLike[] };
  }

  interface CallOptionsLike {
    signal?: AbortSignal;
    timeoutMs?: number;
  }

  interface Operations {
    listPets(query?: { limit?: number }, callOptions?: CallOptionsLike): Promise<unknown>;
    createPet(body: { name: string }, callOptions?: CallOptionsLike): Promise<unknown>;
    getPetById(
      path: { petId: string },
      headers?: { "x-trace-id"?: string },
      callOptions?: CallOptionsLike
    ): Promise<unknown>;
    deletePet(path: { petId: string }, callOptions?: CallOptionsLike): Promise<unknown>;
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
      transport: async (url, init) => {
        const call = { url, method: init.method, headers: init.headers, body: init.body };
        sent.push(call);
        return respond(call);
      },
      // One interceptor covers both directions: the token on the way in, the
      // status on the way out.
      interceptors: {
        http: [
          async (call, next) => {
            const result = await next(
              hooks.authorization
                ? { ...call, headers: { ...call.headers, authorization: hooks.authorization } }
                : call
            );
            hooks.seen?.push(result.response.status);
            return result;
          },
        ],
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

    const pet = await client.getPetById(
      { petId: "p 1" },
      { "x-trace-id": "t1" }
    );

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

    await client.listPets({ limit: 2 });
    await client.listPets();

    expect(sent[0]!.url).toBe("https://api.test/pets?limit=2");
    expect(sent[1]!.url).toBe("https://api.test/pets");
  });

  test("a body is sent as JSON with the media type the document declared", async () => {
    const sent: Sent[] = [];
    const client = await load(() => json({ id: "p2", name: "Ada" }, 201), sent);

    await client.createPet({ name: "Ada" });
    expect(sent[0]!.method).toBe("POST");
    expect(sent[0]!.headers["content-type"]).toBe("application/json");
    expect(sent[0]!.body).toBe('{"name":"Ada"}');
  });

  test("no content resolves to nothing", async () => {
    const sent: Sent[] = [];
    const client = await load(() => new Response(null, { status: 204 }), sent);

    expect(await client.deletePet({ petId: "p1" })).toBeUndefined();
  });

  test("a failure throws with the status and the parsed body", async () => {
    const sent: Sent[] = [];
    const client = await load(() => json({ message: "gone" }, 404), sent);

    const failure = await client
      .getPetById({ petId: "p1" })
      .catch((error: unknown) => error);
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
      transport: async (url, init) => {
        first.push({ url, method: init.method, headers: init.headers, body: init.body });
        return json({ id: "a", name: "A" });
      },
      interceptors: {
        http: [
          (call, next) =>
            next({ ...call, headers: { ...call.headers, authorization: "Bearer a" } }),
        ],
      },
    });

    const tenantB = client.createClient({
      baseUrl: "https://b.test",
      transport: async (url, init) => {
        second.push({ url, method: init.method, headers: init.headers, body: init.body });
        return json({ id: "b", name: "B" });
      },
    });

    expect(await tenantA.getPetById({ petId: "x" })).toEqual({
      id: "a",
      name: "A",
    });
    expect(await tenantB.getPetById({ petId: "x" })).toEqual({
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

  /**
   * An interceptor is a wrapper, not a callback: the chain nests, and calling
   * `next` twice sends the request twice. That is what makes a retry the
   * caller's to write rather than a feature the client has to ship.
   */
  test("the chain nests outermost first, and may call next twice", async () => {
    const client = await load(() => json({}), []);
    const order: string[] = [];
    let attempts = 0;

    const retrying = client.createClient({
      baseUrl: "https://r.test",
      transport: async () => {
        attempts += 1;
        return attempts === 1
          ? json({ error: "busy" }, 503)
          : json({ id: "p1", name: "Rex" });
      },
      interceptors: {
        http: [
          async (call, next) => {
            order.push("outer in");
            const result = await next(call);
            order.push("outer out");
            return result;
          },
          async (call, next) => {
            order.push("inner in");
            let result = await next(call);
            // A 503 reaches the chain as a response, not as a throw: that is
            // what lets this decide rather than catch.
            if (result.response.status === 503) result = await next(call);
            order.push("inner out");
            return result;
          },
        ],
      },
    });

    expect(await retrying.getPetById({ petId: "x" })).toEqual({
      id: "p1",
      name: "Rex",
    });
    expect(attempts).toBe(2);
    expect(order).toEqual(["outer in", "inner in", "inner out", "outer out"]);
  });

  /**
   * Symmetrical to gRPC, an HTTP client accepts a `transport` option that
   * overrides `fetch`. It can be an `HttpTransport` object (`{ call(call) }`) or
   * a custom fetch function.
   */
  test("custom HttpTransport overrides fetch symmetrically to gRPC", async () => {
    const client = await load(() => json({}), []);
    const calls: Sent[] = [];

    const customClient = client.createClient({
      baseUrl: "https://t.test",
      transport: {
        async call(c: Sent) {
          calls.push(c);
          return json({ id: "t1", name: "TransportPet" });
        },
      },
    });

    const pet = await customClient.getPetById({ petId: "t1" });
    expect(calls[0]!.url).toBe("https://t.test/pets/t1");
  });

  /**
   * The same two things a gRPC call takes. `signal` reaches `fetch` untouched;
   * `timeoutMs` is enforced by the client, so a server that never answers
   * cannot hang the caller either.
   *
   * The deadline is `AbortSignal.timeout` inside the emitted client, a platform
   * timer fake timers cannot reach, so this exercises the real clock. The
   * 250ms fallback is deliberately past the deadline: if enforcement broke, the
   * call would succeed and the name assertion below would fail, not hang.
   */
  test("a call can be cancelled through its signal, and a timeout aborts it", async () => {
    const client = await load(() => json({}), []);

    // A fetch that behaves like the real one: it settles when told, and it
    // rejects the moment its signal is aborted, not after its own timer.
    const slow = (init: { signal?: AbortSignal }): Promise<Response> => {
      const { promise, resolve, reject } = Promise.withResolvers<Response>();
      const timer = setTimeout(() => resolve(json({ id: "late" })), 250);
      init.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(init.signal!.reason);
        },
        { once: true }
      );
      return promise;
    };

    const controlled = client.createClient({
      baseUrl: "https://c.test",
      transport: (_url, init) => slow(init),
    });

    const controller = new AbortController();
    const inFlight = controlled.getPetById(
      { petId: "x" },
      undefined,
      { signal: controller.signal }
    );
    controller.abort();
    const cancelled = await inFlight.catch((error: unknown) => error);

    expect((cancelled as Error).name).toBe("AbortError");

    const timedOut = await controlled
      .getPetById({ petId: "x" }, undefined, { timeoutMs: 25 })
      .catch((error: unknown) => error);

    // `AbortSignal.timeout` names its own failure, which is what keeps a
    // deadline apart from a caller changing their mind.
    expect((timedOut as Error).name).toBe("TimeoutError");

    // The same deadline can be a default on the client rather than per call.
    const byDefault = client.createClient({
      baseUrl: "https://c.test",
      timeoutMs: 25,
      transport: (_url, init) => slow(init),
    });
    const defaulted = await byDefault
      .deletePet({ petId: "x" })
      .catch((error: unknown) => error);

    expect((defaulted as Error).name).toBe("TimeoutError");
  });

  /**
   * The deadline is per attempt, not per call: the signal is built inside the
   * attempt, so an interceptor that retries after a timeout is not handed a
   * signal that has already fired.
   */
  test("a retried attempt gets a fresh deadline", async () => {
    const client = await load(() => json({}), []);
    let attempts = 0;

    const retrying = client.createClient({
      baseUrl: "https://r.test",
      transport: (_url, init) => {
        const { promise, resolve, reject } = Promise.withResolvers<Response>();
        attempts += 1;
        if (attempts === 1) {
          // The first attempt hangs until its deadline aborts it.
          init.signal?.addEventListener(
            "abort",
            () => reject(init.signal!.reason),
            { once: true }
          );
        } else {
          // Resolves only if the second attempt really got a fresh signal; an
          // already-aborted one would reject immediately.
          init.signal?.addEventListener(
            "abort",
            () => reject(init.signal!.reason),
            { once: true }
          );
          resolve(json({ id: "second" }));
        }
        return promise;
      },
      interceptors: {
        http: [
          async (call, next) => {
            try {
              return await next(call);
            } catch (error) {
              if ((error as Error).name !== "TimeoutError") throw error;
              return await next(call);
            }
          },
        ],
      },
    });

    const pet = await retrying.getPetById({ petId: "x" }, undefined, { timeoutMs: 25 });
    expect(pet).toEqual({ id: "second" });
    expect(attempts).toBe(2);
  });
});
describe("mediaTypes option support in tsClient", () => {
  test("emits client with YAML, JSONL, Erlang, XML support when mediaTypes is set", () => {
    const yamlDoc = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "MediaTypesTest", version: "1.0.0" },
      paths: {
        "/config": {
          post: {
            operationId: "updateConfig",
            requestBody: {
              content: {
                "application/yaml": {
                  schema: { type: "object", properties: { key: { type: "string" } } },
                },
              },
            },
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/yaml": {
                    schema: { type: "object", properties: { status: { type: "string" } } },
                  },
                },
              },
            },
          },
        },
        "/events": {
          post: {
            operationId: "sendEvents",
            requestBody: {
              content: {
                "application/jsonl": {
                  schema: { type: "array", items: { type: "string" } },
                },
              },
            },
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/x-erlang-text": {
                    schema: { type: "object", properties: { result: { type: "string" } } },
                  },
                },
              },
            },
          },
        },
      },
    });

    const ir = extractApiIR(yamlDoc, { format: "json" });
    const files = generate(
      ir,
      tsClientGenerator,
      { mediaTypes: ["yaml", "jsonl", "erlangText"] },
      silentLogger
    );

    expect(files["api.ts"]).toContain('"application/yaml"');
    expect(files["api.ts"]).toContain("Bun");
    expect(files["api.ts"]).toContain('"application/jsonl"');
    expect(files["api.ts"]).toContain("encodeErlangText");
    expect(files["codec.ts"]).toContain("encodeErlangText");
  });

  test("emits client with all media types when mediaTypes is 'all'", () => {
    const doc = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "AllMediaTypes", version: "1.0.0" },
      paths: {
        "/binary": {
          post: {
            operationId: "sendEtf",
            requestBody: {
              content: {
                "application/x-etf": {
                  schema: { type: "object", properties: { data: { type: "string" } } },
                },
              },
            },
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/xml": {
                    schema: { type: "object", properties: { xmlRes: { type: "string" } } },
                  },
                },
              },
            },
          },
        },
      },
    });

    const ir = extractApiIR(doc, { format: "json" });
    const files = generate(
      ir,
      tsClientGenerator,
      { mediaTypes: "all" },
      silentLogger
    );

    expect(files["api.ts"]).toContain('"application/x-etf"');
    expect(files["codec.ts"]).toContain("encodeErlangBinary");
  });

  test("emits client with CBOR support when mediaTypes includes cbor", () => {
    const doc = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "CborApi", version: "1.0.0" },
      paths: {
        "/items": {
          post: {
            operationId: "sendItem",
            requestBody: {
              content: {
                "application/cbor": {
                  schema: { type: "object", properties: { data: { type: "string" } } },
                },
              },
            },
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/cbor": {
                    schema: { type: "object", properties: { id: { type: "string" } } },
                  },
                },
              },
            },
          },
        },
      },
    });

    const ir = extractApiIR(doc, { format: "json" });
    const files = generate(ir, tsClientGenerator, { mediaTypes: ["cbor"] }, silentLogger);

    expect(files["api.ts"]).toContain('"application/cbor"');
    expect(files["codec.ts"]).toContain("encodeCbor");
  });
});

describe("malformed response body handling in tsClient", () => {
  test("throws on malformed JSON responses", async () => {
    const doc = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "JsonApi", version: "1.0.0" },
      paths: {
        "/data": {
          get: {
            operationId: "getData",
            responses: {
              "200": {
                description: "ok",
                content: { "application/json": { schema: { type: "object" } } },
              },
            },
          },
        },
      },
    });
    const ir = extractApiIR(doc, { format: "json" });
    const clientFiles = generate(ir, tsClientGenerator, {}, silentLogger);
    expect(clientFiles["api.ts"]).toContain("JSON.parse(text)");
    expect(clientFiles["api.ts"]).not.toContain("catch { return text }");
  });

  test("throws descriptive error when Bun.XML or decoder is missing", () => {
    const doc = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "XmlApi", version: "1.0.0" },
      paths: {
        "/xml": {
          get: {
            operationId: "getXml",
            responses: {
              "200": {
                description: "ok",
                content: { "application/xml": { schema: { type: "object" } } },
              },
            },
          },
        },
      },
    });
    const ir = extractApiIR(doc, { format: "json" });
    const clientFiles = generate(ir, tsClientGenerator, { mediaTypes: ["xml"] }, silentLogger);
    expect(clientFiles["api.ts"]).toContain("[wiz] application/xml responses need Bun.XML");
    expect(clientFiles["api.ts"]).not.toContain("catch { return text }");
  });
});

describe("parameter serialization styles (style and explode)", () => {
  test("emits queries with style and explode query specs", () => {
    const doc = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "StylesApi", version: "1.0.0" },
      paths: {
        "/test": {
          get: {
            operationId: "getStyled",
            parameters: [
              {
                name: "tags",
                in: "query",
                style: "form",
                explode: false,
                schema: { type: "array", items: { type: "string" } },
              },
              {
                name: "filter",
                in: "query",
                style: "deepObject",
                explode: true,
                schema: { type: "object", properties: { age: { type: "integer" } } },
              },
              {
                name: "pipes",
                in: "query",
                style: "pipeDelimited",
                explode: false,
                schema: { type: "array", items: { type: "string" } },
              },
            ],
            responses: {
              "200": {
                description: "ok",
                content: { "application/json": { schema: { type: "string" } } },
              },
            },
          },
        },
      },
    });
    const ir = extractApiIR(doc, { format: "json" });
    const clientFiles = generate(ir, tsClientGenerator, {}, silentLogger);
    expect(clientFiles["api.ts"]).toContain('"tags":{"style":"form","explode":false}');
    expect(clientFiles["api.ts"]).toContain('"filter":{"style":"deepObject","explode":true}');
    expect(clientFiles["api.ts"]).toContain('"pipes":{"style":"pipeDelimited","explode":false}');
    expect(clientFiles["api.ts"]).toContain("serializeParam");
  });
});

describe("multipart/form-data and application/x-www-form-urlencoded request body serialization", () => {
  test("emits client with FormData serializer for multipart request bodies", async () => {
    const doc = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "UploadApi", version: "1.0.0" },
      components: {
        schemas: {
          UploadRequest: {
            type: "object",
            properties: {
              name: { type: "string" },
              file: { type: "string", format: "binary" },
            },
          },
        },
      },
      paths: {
        "/upload": {
          post: {
            operationId: "uploadFile",
            requestBody: {
              required: true,
              content: {
                "multipart/form-data": {
                  schema: { $ref: "#/components/schemas/UploadRequest" },
                },
              },
            },
            responses: {
              "200": {
                description: "ok",
                content: { "application/json": { schema: { type: "string" } } },
              },
            },
          },
        },
      },
    });

    const ir = extractApiIR(doc, { format: "json" });
    const clientFiles = generate(ir, tsClientGenerator, {}, silentLogger);
    expect(clientFiles["api.ts"]).toContain("serializeFormData(body)");
    expect(clientFiles["api.ts"]).toContain("function serializeFormData");
  });

  test("emits client with urlencoded serializer for form urlencoded request bodies", async () => {
    const doc = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "FormApi", version: "1.0.0" },
      components: {
        schemas: {
          FormRequest: {
            type: "object",
            properties: {
              username: { type: "string" },
              password: { type: "string" },
            },
          },
        },
      },
      paths: {
        "/login": {
          post: {
            operationId: "login",
            requestBody: {
              required: true,
              content: {
                "application/x-www-form-urlencoded": {
                  schema: { $ref: "#/components/schemas/FormRequest" },
                },
              },
            },
            responses: {
              "200": {
                description: "ok",
                content: { "application/json": { schema: { type: "string" } } },
              },
            },
          },
        },
      },
    });

    const ir = extractApiIR(doc, { format: "json" });
    const clientFiles = generate(ir, tsClientGenerator, {}, silentLogger);
    expect(clientFiles["api.ts"]).toContain("serializeUrlEncoded(body)");
    expect(clientFiles["api.ts"]).toContain("function serializeUrlEncoded");
  });
});
