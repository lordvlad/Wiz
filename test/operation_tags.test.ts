// @wiz-ignore
import { describe, expect, test } from "bun:test";
import { silentLogger, type WizLogger } from "../src/logger.ts";
import { transformSource } from "../src/plugin.ts";
import { evalModule } from "./helpers.ts";

/**
 * An operation is only what the documentation says it is: `openapiSchema` needs
 * a verb and a path, `asyncapiSchema` a direction, `openRPCSchema` an `@rpc`
 * tag and `grpcSchema` a `@grpc` tag. That is what lets an annotated
 * implementation class be handed to a macro - its other members, and the
 * members that speak a different protocol, contribute nothing.
 *
 * Every test here builds a cold `ts.Program`, which does not fit bun's 5s
 * default under load.
 */
const TIMEOUT = 30_000;

interface OpenApiDoc {
    paths: Record<string, Record<string, { parameters?: Array<{ name: string; in: string }> }>>;
}

interface AsyncApiDoc {
    channels: Record<string, { address: string }>;
    operations: Record<string, { action: string }>;
}

interface OpenRpcDoc {
    methods: { name: string }[];
}

interface SchemaModule {
    openapiSchema: () => OpenApiDoc;
    asyncapiSchema: () => AsyncApiDoc;
    openRPCSchema: () => OpenRpcDoc;
    grpcSchema: (options?: { indent?: string }) => string;
}

/**
 * Transforms one source with a single macro callsite and runs the virtual
 * module it emits. Every emitted module exports every stub name, so the source
 * carries one macro call and the one emitted module is the answer.
 */
function harvest(source: string, logger: WizLogger = silentLogger): SchemaModule {
    const result = transformSource({ path: "app.ts", contents: source, logger });
    const emitted = Array.from(result.modules.values());
    if (emitted.length !== 1) {
        throw new Error(`expected one virtual module, got ${emitted.length}`);
    }
    return evalModule<SchemaModule>(emitted[0]!.files["index.js"]!);
}

function warningsFor(source: string): string[] {
    const warn: string[] = [];
    transformSource({
        path: "app.ts",
        contents: source,
        logger: {
            trace: () => {},
            info: () => {},
            warn: (...args: unknown[]) => warn.push(args.map(String).join(" ")),
            error: () => {},
        },
    });
    return warn;
}

/**
 * One class speaking two protocols plus a method that speaks neither: the shape
 * the gate exists for.
 */
const PET_STORE = `
  export interface Pet { id: number; name: string }
  export interface Changed { at: string }

  /** @service Pets */
  export class PetStore {
    /**
     * @get /pets
     * @response 200 application/json Pet[]
     */
    list(query: { limit?: number }): Pet[] { return []; }

    /**
     * @method POST
     * @path /pets
     * @response 201 application/json Pet
     */
    add(body: Pet): Pet { return body; }

    /** @http PUT /pets/{id} */
    replace(id: number, body: Pet): Pet { return body; }

    /**
     * @producer
     * @channel pets.changed
     */
    onChange(listener: (event: Changed) => void): void {}

    /** @consumer @channel pets.changed */
    applyChange(event: Changed): void {}

    /** Neither an operation nor a channel. */
    seed(): void {}
  }
`;

const OPENAPI_BASE = `{ openapi: "3.1.0", info: { title: "Pets", version: "1.0.0" } }`;
const ASYNCAPI_BASE = `{ info: { title: "Pets", version: "1.0.0" } }`;

/**
 * One class serving JSON-RPC and gRPC beside an HTTP operation and a plain
 * helper: each macro takes only the members tagged for it.
 */
const OPS = `
  export interface Tick {
    /** @fieldNumber 1 */
    at: number;
  }

  /** @service Ops */
  export class Ops {
    /** @rpc */
    status(): { up: boolean } { return { up: true }; }

    /** @rpc admin.restart */
    restart(): void {}

    /** @grpc */
    Sync(request: Tick): Tick { return request; }

    /** @get /health */
    health(): { ok: boolean } { return { ok: true }; }

    /** Neither an rpc nor an operation. */
    helper(): void {}
  }
`;

const OPENRPC_BASE = `{ openrpc: "1.3.2", info: { title: "Ops", version: "1.0.0" } }`;

describe("an OpenAPI operation needs an explicit verb and path", () => {
    const doc = (): OpenApiDoc =>
        harvest(`
      import { openapiSchema } from "../../src/index.ts";
      ${PET_STORE}
      export const schema = openapiSchema<[PetStore]>(${OPENAPI_BASE});
    `).openapiSchema();

    test(
        "only the tagged members become paths",
        () => {
            const paths = doc().paths;
            expect(Object.keys(paths).sort()).toEqual(["/pets", "/pets/{id}"]);
            expect(Object.keys(paths["/pets"]!).sort()).toEqual(["get", "post"]);
            expect(Object.keys(paths["/pets/{id}"]!)).toEqual(["put"]);
        },
        TIMEOUT,
    );

    test(
        "a bare verb tag takes its path from @path",
        () => {
            const paths = harvest(`
        import { openapiSchema } from "../../src/index.ts";
        export class Health {
          /**
           * @get
           * @path /health
           */
          check(): { ok: boolean } { return { ok: true }; }
        }
        export const schema = openapiSchema<[Health]>(${OPENAPI_BASE});
      `).openapiSchema().paths;

            expect(Object.keys(paths)).toEqual(["/health"]);
            expect(Object.keys(paths["/health"]!)).toEqual(["get"]);
        },
        TIMEOUT,
    );

    test(
        "a @method value that is not an HTTP verb documents nothing",
        () => {
            const paths = harvest(`
        import { openapiSchema } from "../../src/index.ts";
        export class Mixed {
          /**
           * @method FOO
           * @path /nope
           */
          nope(): void {}

          /** @get /ok */
          ok(): void {}
        }
        export const schema = openapiSchema<[Mixed]>(${OPENAPI_BASE});
      `).openapiSchema().paths;

            expect(Object.keys(paths)).toEqual(["/ok"]);
        },
        TIMEOUT,
    );
});

describe("an AsyncAPI channel operation needs an explicit direction", () => {
    const doc = (): AsyncApiDoc =>
        harvest(`
      import { asyncapiSchema } from "../../src/index.ts";
      ${PET_STORE}
      export const schema = asyncapiSchema<[PetStore, Changed]>(${ASYNCAPI_BASE});
    `).asyncapiSchema();

    test(
        "only the direction-tagged members become operations",
        () => {
            const { channels, operations } = doc();
            expect(Object.keys(operations).sort()).toEqual(["applyChange", "onChange"]);
            expect(operations["onChange"]!.action).toBe("send");
            expect(operations["applyChange"]!.action).toBe("receive");
            expect(Object.values(channels).map((c) => c.address)).toEqual(["pets.changed"]);
        },
        TIMEOUT,
    );
});

describe("a type argument that documents nothing is reported", () => {
    const UNTAGGED = `
    export interface Untagged {
      run(input: { id: string }): Promise<{ ok: boolean }>;
    }
  `;

    test(
        "openapiSchema names the missing HTTP tag",
        () => {
            const warnings = warningsFor(`
        import { openapiSchema } from "../../src/index.ts";
        ${UNTAGGED}
        export const schema = openapiSchema<[Untagged]>(${OPENAPI_BASE});
      `);

            const matched = warnings.filter((w) => w.includes("no HTTP tag found on 'Untagged' for openapiSchema"));
            expect(matched).toHaveLength(1);
        },
        TIMEOUT,
    );

    test(
        "asyncapiSchema names the missing direction tag",
        () => {
            const warnings = warningsFor(`
        import { asyncapiSchema } from "../../src/index.ts";
        ${UNTAGGED}
        export const schema = asyncapiSchema<[Untagged]>(${ASYNCAPI_BASE});
      `);

            const matched = warnings.filter((w) =>
                w.includes("no direction tag found on 'Untagged' for asyncapiSchema"),
            );
            expect(matched).toHaveLength(1);
        },
        TIMEOUT,
    );

    test(
        "openRPCSchema names the missing @rpc tag",
        () => {
            const warnings = warningsFor(`
        import { openRPCSchema } from "../../src/index.ts";
        ${UNTAGGED}
        export const schema = openRPCSchema<[Untagged]>(${OPENRPC_BASE});
      `);

            const matched = warnings.filter((w) => w.includes("no @rpc tag found on 'Untagged' for openRPCSchema"));
            expect(matched).toHaveLength(1);
        },
        TIMEOUT,
    );

    test(
        "grpcSchema names the missing @grpc tag",
        () => {
            const warnings = warningsFor(`
        import { grpcSchema } from "../../src/index.ts";
        ${UNTAGGED}
        export const proto = grpcSchema<[Untagged]>();
      `);

            const matched = warnings.filter((w) => w.includes("no @grpc tag found on 'Untagged' for grpcSchema"));
            expect(matched).toHaveLength(1);
        },
        TIMEOUT,
    );

    test(
        "a tagged service is silent",
        () => {
            const warnings = warningsFor(`
        import { openapiSchema } from "../../src/index.ts";
        ${PET_STORE}
        export const schema = openapiSchema<[PetStore]>(${OPENAPI_BASE});
      `);

            expect(warnings.filter((w) => w.includes("no HTTP tag found"))).toEqual([]);
        },
        TIMEOUT,
    );
});

describe("a JSON-RPC method needs @rpc", () => {
    test(
        "only the @rpc members become methods",
        () => {
            const doc = harvest(`
        import { openRPCSchema } from "../../src/index.ts";
        ${OPS}
        export const schema = openRPCSchema<[Ops]>(${OPENRPC_BASE});
      `).openRPCSchema();

            // `@rpc admin.restart` writes the whole method name, so it is not
            // namespaced again; a bare `@rpc` keeps the `@service` namespace.
            // `rpc.discover` is the generator's own service-discovery method.
            expect(doc.methods.map((m) => m.name).sort()).toEqual(["Ops.status", "admin.restart", "rpc.discover"]);
        },
        TIMEOUT,
    );
});

describe("an rpc needs @grpc", () => {
    test(
        "only the @grpc members reach the service block",
        () => {
            const proto = harvest(`
        import { grpcSchema } from "../../src/index.ts";
        ${OPS}
        export const proto = grpcSchema<[Ops]>();
      `).grpcSchema({ indent: "  " });

            expect(proto).toContain("service Ops {");
            expect(proto).toContain("rpc Sync (Tick) returns (Tick);");
            expect(proto).not.toContain("rpc status");
            expect(proto).not.toContain("rpc health");
            expect(proto).not.toContain("rpc helper");
            expect(proto).not.toContain("rpc restart");
        },
        TIMEOUT,
    );
});

describe("OpenAPI parameter slot parsing", () => {
    test(
        "a parameter named 'query' with a 'path' property is not mistaken for a slot wrapper",
        () => {
            const doc = harvest(`
        import { openapiSchema } from "../../src/index.ts";
        export class FileService {
          /**
           * @get /file
           */
          getFileContent(query: { path: string; cwd?: string }): string { return ""; }
        }
        export const schema = openapiSchema<[FileService]>(${OPENAPI_BASE});
      `).openapiSchema();

            const params = doc.paths["/file"]?.get?.parameters ?? [];
            expect(params).toHaveLength(2);
            expect(params[0]!.name).toBe("path");
            expect(params[0]!.in).toBe("query");
            expect(params[1]!.name).toBe("cwd");
            expect(params[1]!.in).toBe("query");
        },
        TIMEOUT,
    );
});
