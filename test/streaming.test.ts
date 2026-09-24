import { describe, expect, test } from "bun:test";
import { extractApiIR } from "../src/extractors/openapi.ts";
import { generate } from "../src/generators/generator.ts";
import { tsClientGenerator } from "../src/generators/tsClient.ts";
import { silentLogger } from "../src/logger.ts";

describe("HTTP Streaming and Server-Sent Events", () => {
    test("generates async generator for text/event-stream responses", async () => {
        const doc = JSON.stringify({
            openapi: "3.1.0",
            info: { title: "StreamService", version: "1.0.0" },
            paths: {
                "/events": {
                    get: {
                        operationId: "getEvents",
                        responses: {
                            "200": {
                                description: "Event stream",
                                content: {
                                    "text/event-stream": {
                                        schema: {
                                            type: "object",
                                            required: ["id", "data"],
                                            properties: {
                                                id: { type: "string" },
                                                data: { type: "string" },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });

        const ir = extractApiIR(doc, { format: "json" });
        const files = generate(ir, tsClientGenerator, {}, silentLogger);

        const apiSource = files["api.ts"]!;
        expect(apiSource).toContain("async *getEvents(");
        expect(apiSource).toContain("sendStream(config,");
        expect(apiSource).toContain("AsyncIterable<GetEventsResult>");
    });

    test("yields SSE stream events correctly at runtime", async () => {
        const doc = JSON.stringify({
            openapi: "3.1.0",
            info: { title: "StreamService", version: "1.0.0" },
            paths: {
                "/events": {
                    get: {
                        operationId: "getEvents",
                        responses: {
                            "200": {
                                description: "Event stream",
                                content: {
                                    "text/event-stream": {
                                        schema: {
                                            type: "object",
                                            required: ["count"],
                                            properties: {
                                                count: { type: "number" },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });

        const ir = extractApiIR(doc, { format: "json" });
        const files = generate(ir, tsClientGenerator, {}, silentLogger);

        const ssePayload = 'data: {"count": 1}\n\ndata: {"count": 2}\n\ndata: [DONE]\n\n';
        const customFetch = async () =>
            new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode(ssePayload));
                        controller.close();
                    },
                }),
                {
                    status: 200,
                    headers: { "content-type": "text/event-stream" },
                },
            );

        // Dynamic import to test generated in-memory client module
        const mod = await import(`data:text/javascript;base64,${Buffer.from(files["api.ts"]!).toString("base64")}`);

        const client = mod.createClient({
            baseUrl: "https://api.example.com",
            transport: customFetch,
        });

        const results: Array<{ count: number }> = [];
        for await (const event of client.getEvents()) {
            results.push(event);
        }

        expect(results).toEqual([{ count: 1 }, { count: 2 }]);
    });
});
