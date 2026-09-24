// @wiz-ignore
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractApiIR } from "../src/extractors/openapi.ts";
import { generate } from "../src/generators/generator.ts";
import { tsClientGenerator } from "../src/generators/tsClient.ts";
import { silentLogger } from "../src/logger.ts";

const OK_STATUS = {
    "200": {
        description: "ok",
        content: {
            "application/json": { schema: { $ref: "#/components/schemas/Status" } },
        },
    },
};

const document = (schemas: Record<string, unknown>) =>
    JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Accounts", version: "1.0.0" },
        components: { schemas },
        paths: {
            "/status": { get: { operationId: "readStatus", responses: OK_STATUS } },
        },
    });

const SCHEMAS = {
    Status: {
        type: "string",
        enum: ["active", "banned"],
        description: "Whether the account may sign in.",
        "x-enum-varnames": ["ACTIVE", "BANNED"],
        "x-enum-descriptions": ["The account is usable.", "Locked by an operator."],
    },
    Tier: {
        type: "string",
        enum: ["free", "paid"],
        "x-enum-descriptions": ["No card on file.", "Billing active."],
    },
    Plain: { type: "string", enum: ["a", "b"] },
    Weird: {
        type: "string",
        enum: ["a", "b", "c"],
        "x-enum-varnames": ["FOO-BAR", "DUP", "DUP"],
    },
};

let files: Record<string, string>;
let model: string;

beforeAll(() => {
    const api = extractApiIR(document(SCHEMAS), { format: "json" });
    files = generate(api, tsClientGenerator, {}, silentLogger);
    model = files["model.ts"]!;
});

describe("x-enum-varnames", () => {
    test("emits a const object plus a union alias", () => {
        expect(model).toContain("export const Status = {");
        expect(model).toContain(`  ACTIVE: "active",`);
        expect(model).toContain(`  BANNED: "banned",`);
        expect(model).toContain("} as const;");
        expect(model).toContain("export type Status = (typeof Status)[keyof typeof Status];");
    });

    test("the schema description documents the const, the members their entries", () => {
        expect(model).toContain("/** Whether the account may sign in. */");
        expect(model).toContain("/** The account is usable. */");
        expect(model).toContain("/** Locked by an operator. */");
    });

    test("unnameable varnames are quoted and repeats are suffixed", () => {
        expect(model).toContain(`"FOO-BAR": "a",`);
        expect(model).toContain(`  DUP_2: "c",`);
    });
});

describe("x-enum-descriptions", () => {
    test("without varnames the enum stays a doc-commented union", () => {
        expect(model).toContain("export type Tier =");
        expect(model).toContain("/** No card on file. */");
        expect(model).toContain(`  | "free"`);
        expect(model).not.toContain("export const Tier");
    });
});

test("an enum with no extensions is emitted exactly as before", () => {
    expect(model).toContain(`export type Plain = "a" | "b";`);
});

test("model.ts is valid TypeScript", () => {
    expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(model)).not.toThrow();
});

test("api.ts mentions the enum in type position only", () => {
    const api = files["api.ts"]!;
    expect(api).not.toContain("Status.");
    expect(api).not.toContain("export const Status");
});

test("an unclaimed vendor extension is warned about once", () => {
    const warnings: string[] = [];
    const logger = { ...silentLogger, warn: (...args: unknown[]) => warnings.push(args.join(" ")) };
    const api = extractApiIR(
        document({
            Status: { type: "string", enum: ["active"] },
            Widget: { type: "string", "x-widget": "slider" },
        }),
        { format: "json" },
    );
    generate(api, tsClientGenerator, {}, logger);

    const matches = warnings.filter((line) => line.includes("no plugin handles vendor extension 'x-widget'"));
    expect(matches).toHaveLength(1);
});

test("a user plugin claims its extension and renders the declaration", () => {
    const warnings: string[] = [];
    const logger = { ...silentLogger, warn: (...args: unknown[]) => warnings.push(args.join(" ")) };
    const api = extractApiIR(
        document({
            Status: { type: "string", enum: ["active"] },
            Widget: { type: "string", "x-widget": "slider" },
        }),
        { format: "json" },
    );
    const generated = generate(
        api,
        tsClientGenerator,
        {
            plugins: [
                {
                    name: "t",
                    extensions: ["x-widget"],
                    declaration: ({ name }) => (name === "Widget" ? "export type Widget = 42;" : undefined),
                },
            ],
        },
        logger,
    );

    expect(generated["model.ts"]!).toContain("export type Widget = 42;");
    expect(warnings.join("\n")).not.toContain("no plugin handles");
});

test("plugin mutations never reach the validators", () => {
    const withExtensions = extractApiIR(
        document({
            Status: {
                type: "string",
                enum: ["active", "banned"],
                "x-enum-varnames": ["ACTIVE", "BANNED"],
            },
        }),
        { format: "json" },
    );
    const without = extractApiIR(document({ Status: { type: "string", enum: ["active", "banned"] } }), {
        format: "json",
    });

    const a = generate(withExtensions, tsClientGenerator, { validate: true }, silentLogger);
    const b = generate(without, tsClientGenerator, { validate: true }, silentLogger);

    expect(a["api.ts"]).toBe(b["api.ts"]!);
});

/** One operation whose 200 response carries `x-select`. */
const selecting = (select: unknown) =>
    JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Pets", version: "1.0.0" },
        components: {
            schemas: {
                Pet: {
                    type: "object",
                    required: ["id", "name"],
                    properties: { id: { type: "string" }, name: { type: "string" } },
                },
            },
        },
        paths: {
            "/pet": {
                get: {
                    operationId: "getPet",
                    responses: {
                        "200": {
                            description: "ok",
                            ...(select === undefined ? {} : { "x-select": select }),
                            content: {
                                "application/json": {
                                    schema: { $ref: "#/components/schemas/Pet" },
                                },
                            },
                        },
                    },
                },
            },
        },
    });

const selected = (select: unknown) => {
    const warnings: string[] = [];
    const logger = {
        ...silentLogger,
        warn: (...args: unknown[]) => warnings.push(args.join(" ")),
    };
    const generated = generate(extractApiIR(selecting(select), { format: "json" }), tsClientGenerator, {}, logger);
    return { api: generated["api.ts"]!, warnings };
};

describe("x-select", () => {
    test("a JSONPath becomes an optional-chained access, with no warning", () => {
        const { api, warnings } = selected("$.data.pet");
        expect(api).toContain("((($: any) => ($?.data?.pet))(");
        expect(warnings).toEqual([]);
    });

    test("bracket and index segments are honoured", () => {
        expect(selected("$['a-b'][2]").api).toContain(`($?.["a-b"]?.[2])`);
    });

    test("a bare $ selects nothing and emits no wrapper", () => {
        const { api, warnings } = selected("$");
        expect(api).not.toContain("($: any)");
        expect(warnings).toEqual([]);
    });

    test("an expression is inlined verbatim and warned about", () => {
        const { api, warnings } = selected("$.items.find((p) => p.id)");
        expect(api).toContain("((($: any) => ($.items.find((p) => p.id)))(");
        expect(warnings.join("\n")).toContain("is not a plain JSONPath");
        expect(warnings.join("\n")).toContain("review it before shipping");
    });

    test("a selector that does not parse is dropped, not emitted", () => {
        const { api, warnings } = selected("$.data.(((");
        expect(api).not.toContain("($: any)");
        expect(warnings.join("\n")).toContain("neither a JSONPath nor an expression that parses");
    });

    test("a non-string selector is ignored", () => {
        const { api, warnings } = selected({ path: "$.data" });
        expect(api).not.toContain("($: any)");
        expect(warnings.join("\n")).toContain("expected a non-empty string");
    });

    test("no x-select leaves the call site exactly as it was", () => {
        expect(selected(undefined).api).not.toContain("($: any) =>");
    });

    test("emitted api.ts still parses with a selector in place", () => {
        expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(selected("$.data.pet").api)).not.toThrow();
    });

    test("the selected value is what gets validated and returned", async () => {
        const generated = generate(
            extractApiIR(selecting("$.data.pet"), { format: "json" }),
            tsClientGenerator,
            { validate: true },
            silentLogger,
        );
        const dir = await mkdtemp(join(tmpdir(), "wiz-select-"));
        for (const [file, content] of Object.entries(generated)) {
            await writeFile(join(dir, file), content);
        }

        const realFetch = globalThis.fetch;
        const respond = (payload: unknown) => {
            globalThis.fetch = Object.assign(
                async () =>
                    new Response(JSON.stringify(payload), {
                        headers: { "content-type": "application/json" },
                    }),
                { preconnect: realFetch.preconnect },
            );
        };

        try {
            // Runtime path: the client under test was just generated into a tmpdir.
            const client = await import(join(dir, "api.ts"));
            client.configure({ baseUrl: "http://example.test" });

            respond({ data: { pet: { id: "7", name: "Ada" } }, meta: { page: 1 } });
            expect(await client.getPet()).toEqual({ id: "7", name: "Ada" });

            // The envelope alone must fail: validation reads the selected value.
            respond({ meta: { page: 1 } });
            await expect(client.getPet()).rejects.toThrow("Validation failed for response");
        } finally {
            globalThis.fetch = realFetch;
            await rm(dir, { recursive: true, force: true });
        }
    });
});
