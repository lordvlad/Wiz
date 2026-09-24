import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import ts from "typescript";
import { runGenerate } from "../src/cli/generate.ts";

describe("OpenRPC CLI Generation & End-to-End Test", () => {
    test("wiz generate -g tsClient.ts from OpenRPC document", async () => {
        const spec = JSON.stringify({
            openrpc: "1.3.0",
            info: { title: "PetStore", version: "1.0.0" },
            methods: [
                {
                    name: "PetService.getPet",
                    params: [{ name: "id", required: true, schema: { type: "string" } }],
                    result: { name: "pet", schema: { $ref: "#/components/schemas/Pet" } },
                },
            ],
            components: {
                schemas: {
                    Pet: {
                        type: "object",
                        properties: {
                            id: { type: "string" },
                            name: { type: "string" },
                        },
                        required: ["id", "name"],
                    },
                },
            },
        });

        const tmpDir = join("/tmp", `openrpc_cli_test_${Date.now()}`);
        const specFile = join(tmpDir, "openrpc.json");
        const outDir = join(tmpDir, "client");

        await Bun.write(specFile, spec);

        const tsClientPath = join(process.cwd(), "src/generators/tsClient.ts");
        const code = await runGenerate(["-g", tsClientPath, specFile, "-o", outDir]);

        expect(code).toBe(0);

        const modelFile = Bun.file(join(outDir, "model.ts"));
        const apiFile = Bun.file(join(outDir, "api.ts"));

        expect(await modelFile.exists()).toBe(true);
        expect(await apiFile.exists()).toBe(true);

        const modelContent = await modelFile.text();
        const apiContent = await apiFile.text();

        expect(modelContent).toContain("export interface Pet");
        expect(apiContent).toContain("getPet");
    });

    /**
     * A JSON-RPC method is emitted as an ordinary HTTP call, so the checks are
     * that it reaches `send` - the one place interceptors, deadlines and body
     * parsing live - rather than a transport of its own.
     */
    describe("the emitted JSON-RPC methods share the HTTP path", () => {
        const spec = JSON.stringify({
            openrpc: "1.3.0",
            info: { title: "Calculator", version: "1.0.0" },
            methods: [
                {
                    name: "Calc.add",
                    paramStructure: "by-name",
                    params: [
                        { name: "a", required: true, schema: { type: "number" } },
                        { name: "b", required: true, schema: { type: "number" } },
                    ],
                    result: { name: "sum", schema: { type: "number" } },
                },
                {
                    name: "Calc.fail",
                    params: [],
                    result: { name: "never", schema: { type: "number" } },
                },
            ],
        });

        interface CallLike {
            method: string;
            url: string;
            headers: Record<string, string>;
            body?: string;
        }

        interface ResultLike {
            call: CallLike;
            response: Response;
        }

        interface ClientModule {
            configure(next: {
                baseUrl?: string;
                transport?: (
                    url: string,
                    init: { method: string; headers: Record<string, string>; body?: string },
                ) => Promise<Response>;
                interceptors?: {
                    http?: Array<
                        (call: CallLike, next: (call: CallLike) => Promise<ResultLike>) => Promise<ResultLike>
                    >;
                };
            }): void;
            defaultClient(): { calcAdd(params: { a: number; b: number }): Promise<number> };
            calcAdd(params: { a: number; b: number }): Promise<number>;
            calcFail(): Promise<number>;
            RpcError: new (...args: never[]) => Error & { code: number; data?: unknown };
        }

        let api: ClientModule;
        let source: string;
        let apiPath: string;
        const envelopes: Array<Record<string, unknown>> = [];
        const intercepted: string[] = [];

        beforeAll(async () => {
            const tmpDir = join("/tmp", `openrpc_send_test_${Date.now()}`);
            const specFile = join(tmpDir, "openrpc.json");
            const outDir = join(tmpDir, "client");
            await Bun.write(specFile, spec);

            const code = await runGenerate([
                "-g",
                join(process.cwd(), "src/generators/tsClient.ts"),
                specFile,
                "-o",
                outDir,
            ]);
            expect(code).toBe(0);

            apiPath = join(outDir, "api.ts");
            source = await Bun.file(apiPath).text();
            // Generated into a temp directory during the run, so the specifier is not
            // known at author time and a static import cannot reach it.
            api = (await import(join(outDir, "api.ts"))) as unknown as ClientModule;

            api.configure({
                baseUrl: "https://rpc.test",
                transport: async (_url, init) => {
                    const envelope = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
                    envelopes.push(envelope);
                    const failing = envelope["method"] === "Calc.fail";
                    return new Response(
                        JSON.stringify({
                            jsonrpc: "2.0",
                            id: envelope["id"],
                            ...(failing
                                ? { error: { code: -32000, message: "no", data: { why: "asked" } } }
                                : { result: 7 }),
                        }),
                        { headers: { "content-type": "application/json" } },
                    );
                },
                interceptors: {
                    http: [
                        async (call, next) => {
                            intercepted.push(call.body ?? "");
                            return next(call);
                        },
                    ],
                },
            });
        });

        test("no transport of its own is left in the emitted source", () => {
            expect(source).not.toContain("openrpcTransport");
            expect(source).not.toContain("idSeq");
            expect(source).toContain("send(config, {");
            // The one interceptor key a JSON-RPC client has, since the call is HTTP.
            expect(source).toContain("  http?: HttpInterceptor[];");
            // Only an HTTP method builds a path, a query or a header record.
            expect(source).not.toContain("function encodePath");
            expect(source).not.toContain("function queryString");
            expect(source).not.toContain("function headerRecord");
            expect(source).toContain("export function defaultClient(): Client {");
        });

        /**
         * The check whose absence let a JSON-RPC client ship that named fields
         * `ClientConfig` never declared: a consumer compiles this file, so the
         * test compiles it too, with nothing unused left in it.
         */
        test("typechecks under strict TypeScript, with no unused declaration", () => {
            const program = ts.createProgram([apiPath], {
                strict: true,
                noEmit: true,
                noUnusedLocals: true,
                noUnusedParameters: true,
                target: ts.ScriptTarget.ESNext,
                module: ts.ModuleKind.ESNext,
                moduleResolution: ts.ModuleResolutionKind.Bundler,
                allowImportingTsExtensions: true,
                skipLibCheck: true,
                lib: ["lib.esnext.d.ts", "lib.dom.d.ts"],
            });

            expect(
                [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()].map((diagnostic) =>
                    ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
                ),
            ).toEqual([]);
        });

        test("every call runs the interceptor chain and counts its own id", async () => {
            expect(await api.calcAdd({ a: 3, b: 4 })).toBe(7);
            expect(await api.calcAdd({ a: 5, b: 2 })).toBe(7);

            expect(intercepted).toHaveLength(2);
            expect(envelopes.map((envelope) => envelope["id"])).toEqual([1, 2]);
            expect(envelopes[0]).toMatchObject({
                jsonrpc: "2.0",
                method: "Calc.add",
                params: { a: 3, b: 4 },
            });
            // The chain saw the same body that went out, not a re-serialisation.
            expect(intercepted[0]).toBe(JSON.stringify(envelopes[0]));
        });

        test("the module-level functions and `defaultClient` are one client", async () => {
            const before = envelopes.length;
            expect(await api.defaultClient().calcAdd({ a: 1, b: 1 })).toBe(7);
            // A fresh client would restart at 1; this one continues the count.
            expect(envelopes[before]!["id"]).toBe(before + 1);
        });

        test("a JSON-RPC error member becomes an RpcError", async () => {
            const thrown = await api.calcFail().then(
                () => undefined,
                (error: unknown) => error,
            );
            expect(thrown).toBeInstanceOf(api.RpcError);
            if (!(thrown instanceof api.RpcError)) {
                throw new Error("expected an RpcError");
            }
            expect(thrown.message).toBe("no");
            expect(thrown.code).toBe(-32000);
            expect(thrown.data).toEqual({ why: "asked" });
        });
    });
});
