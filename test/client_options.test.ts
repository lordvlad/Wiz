import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractApiIR } from "../src/extractors/openapi.ts";
import { generate } from "../src/generators/generator.ts";
import { tsClientGenerator } from "../src/generators/tsClient.ts";
import { silentLogger } from "../src/logger.ts";

describe("Client Logger and ErrorFactory options", () => {
    let tempDir: string;
    let apiPath: string;

    const DOC = JSON.stringify({
        openapi: "3.1.0",
        info: { title: "ErrorLoggerService", version: "1.0.0" },
        paths: {
            "/items": {
                get: {
                    operationId: "getItems",
                    responses: {
                        "200": {
                            description: "Items list",
                            content: { "application/json": { schema: { type: "array", items: { type: "string" } } } },
                        },
                    },
                },
            },
        },
    });

    beforeAll(async () => {
        tempDir = await mkdtemp(join(tmpdir(), "wiz-logger-test-"));
        const ir = extractApiIR(DOC, { format: "json" });
        const files = generate(ir, tsClientGenerator, {}, silentLogger);
        for (const [name, content] of Object.entries(files)) {
            await writeFile(join(tempDir, name), content);
        }
        apiPath = join(tempDir, "api.ts");
    });

    afterAll(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    test("emits Logger interface, ErrorFactory type, and ClientConfig options", () => {
        const ir = extractApiIR(DOC, { format: "json" });
        const files = generate(ir, tsClientGenerator, {}, silentLogger);
        const apiSource = files["api.ts"]!;

        expect(apiSource).toContain("export interface Logger {");
        expect(apiSource).toContain(
            "export type ErrorFactory = (status: number, body: unknown, response: Response) => Error;",
        );
        expect(apiSource).toContain("logger?: Logger;");
        expect(apiSource).toContain("errorFactory?: ErrorFactory;");
    });

    test("uses custom errorFactory when HTTP call fails with non-2xx", async () => {
        const mod = await import(apiPath);

        class CustomDomainError extends Error {
            readonly httpStatus: number;
            readonly rawBody: unknown;

            constructor(status: number, body: unknown) {
                super(`Domain failure with HTTP ${status}`);
                this.name = "CustomDomainError";
                this.httpStatus = status;
                this.rawBody = body;
            }
        }

        const customFetch = async () =>
            new Response(JSON.stringify({ code: "ITEM_NOT_FOUND", reason: "Out of stock" }), {
                status: 404,
                headers: { "content-type": "application/json" },
            });

        const client = mod.createClient({
            baseUrl: "https://api.example.com",
            transport: customFetch,
            errorFactory: (status: number, body: unknown) => new CustomDomainError(status, body),
        });

        try {
            await client.getItems();
            expect().fail("Should have thrown custom error");
        } catch (err: any) {
            expect(err).toBeInstanceOf(CustomDomainError);
            expect(err.name).toBe("CustomDomainError");
            expect(err.httpStatus).toBe(404);
            expect(err.rawBody).toEqual({ code: "ITEM_NOT_FOUND", reason: "Out of stock" });
        }
    });

    test("logs HTTP error to custom pino/console-compatible logger", async () => {
        const mod = await import(apiPath);

        const loggedErrors: Array<{ msg: unknown; extra: unknown }> = [];
        const pinoLikeLogger = {
            info: () => {},
            warn: () => {},
            error: (msg: unknown, extra: unknown) => {
                loggedErrors.push({ msg, extra });
            },
            debug: () => {},
            trace: () => {},
        };

        const customFetch = async () =>
            new Response(JSON.stringify({ error: "Internal error" }), {
                status: 500,
                headers: { "content-type": "application/json" },
            });

        const client = mod.createClient({
            baseUrl: "https://api.example.com",
            transport: customFetch,
            logger: pinoLikeLogger,
        });

        try {
            await client.getItems();
        } catch {
            // Expected failure
        }

        expect(loggedErrors).toHaveLength(1);
        expect(loggedErrors[0]!.msg).toContain("HTTP 500");
        expect(loggedErrors[0]!.extra).toEqual({ error: "Internal error" });
    });
});
