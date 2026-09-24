// @wiz-ignore
import { beforeAll, describe, expect, test } from "bun:test";
import { Validator } from "@seriousme/openapi-schema-validator";
import { plugin } from "bun";
import { generateOpenApiSchemaCode } from "../src/generators/openapi.ts";
import { silentLogger } from "../src/logger.ts";
import { wizPlugin } from "../src/plugin.ts";
import { evalModule, getIRsForSource, service, httpMethod, params } from "./helpers.ts";

plugin(wizPlugin({ logger: silentLogger }));

/**
 * Interop for the document side: wiz's OpenAPI output is checked against the
 * official OpenAPI JSON Schemas rather than against our own reading of them.
 */

/** Fails with the validator's own messages, which name the offending path. */
async function expectValid(document: unknown) {
    const result = await new Validator().validate(document as never);
    if (!result.valid) {
        throw new Error(`document is not valid OpenAPI:\n${JSON.stringify(result.errors, null, 2)}`);
    }
    expect(result.valid).toBe(true);
}

const base = (version: "3.0.3" | "3.1.0") => ({
    openapi: version,
    info: { title: "Interop", version: "1.0.0" },
});

// Building the first TypeScript program and compiling the first schema costs
// more than the default per-test timeout on a cold cache. Paid once here, so
// no test is measuring a cold start.
beforeAll(async () => {
    await expectValid({ ...base("3.1.0"), paths: {} });
}, 60_000);

describe("generated documents satisfy the OpenAPI schemas", () => {
    const source = `
    export interface User {
      /**
       * Unique identifier.
       * @format uuid
       */
      id: string;
      /**
       * @minLength 2
       * @maxLength 64
       * @example "Ada"
       */
      name: string;
      /**
       * @minimum 0
       * @maximum 150
       */
      age?: number;
      /** @deprecated Use name. */
      handle?: string;
      tags: string[];
      /** @format int64 */
      visits: bigint;
      avatar?: Uint8Array;
      createdAt: Date;
      meta: Record<string, string>;
    }
    export interface NotFound {
      message: string;
    }
    export interface UserQuery {
      /** @minimum 1 */
      page?: number;
    }
    export interface PathParams {
      id: string;
    }
  `;

    for (const version of ["3.0", "3.1"] as const) {
        describe(`OpenAPI ${version}`, () => {
            test("a schema-only document validates", async () => {
                const irs = getIRsForSource(source, ["User", "NotFound"]);
                const code = generateOpenApiSchemaCode(
                    [
                        { name: "User", ir: irs.User.ir },
                        { name: "NotFound", ir: irs.NotFound.ir },
                    ],
                    version,
                );
                const doc = evalModule<{ openapiSchema: (b?: unknown) => any }>(code).openapiSchema(
                    base(version === "3.0" ? "3.0.3" : "3.1.0"),
                );

                await expectValid(doc);
                expect(Object.keys(doc.components.schemas).sort()).toEqual(["NotFound", "User"]);
            });

            test("a document with operations validates", async () => {
                const irs = getIRsForSource(source, ["User", "NotFound", "UserQuery", "PathParams"]);
                const code = generateOpenApiSchemaCode(
                    [],
                    version,
                    service([
                        httpMethod({
                            method: "get",
                            path: "/users/{id}",
                            parameters: [...params(irs.PathParams.ir, "path"), ...params(irs.UserQuery.ir, "query")],
                            response: irs.User.ir,
                            overrides: `{ tags: ["Users"], summary: "Fetch a user" }`,
                        }),
                        httpMethod({
                            method: "post",
                            path: "/users",
                            body: irs.User.ir,
                            response: irs.User.ir,
                            status: 201,
                        }),
                        httpMethod({
                            method: "delete",
                            path: "/users/{id}",
                            parameters: params(irs.PathParams.ir, "path"),
                            status: 204,
                        }),
                    ]),
                );
                const doc = evalModule<{ openapiSchema: (b?: unknown) => any }>(code).openapiSchema(
                    base(version === "3.0" ? "3.0.3" : "3.1.0"),
                );

                await expectValid(doc);
                expect(Object.keys(doc.paths).sort()).toEqual(["/users", "/users/{id}"]);
            });
        });
    }
});

describe("harvested documents validate", () => {
    let doc: Record<string, any>;

    beforeAll(async () => {
        // Deferred on purpose: a static import is hoisted above the `plugin()`
        // call that installs the transform, so the fixture would load untransformed.
        doc = (await import("./fixtures/catalogueFixture.ts")).document as Record<string, any>;
    });

    test("a harvested 3.1 document is valid OpenAPI", async () => {
        await expectValid(doc);
        expect(Object.keys(doc.paths).sort()).toEqual(["/products", "/products/{id}"]);
    });

    test("multi-status responses survive validation", async () => {
        const post = doc.paths["/products"].post;
        expect(Object.keys(post.responses).sort()).toEqual(["201", "422"]);

        const get = doc.paths["/products/{id}"].get;
        expect(Object.keys(get.responses).sort()).toEqual(["200", "404"]);
    });

    test("every referenced schema is present, so no $ref dangles", async () => {
        const refs = new Set<string>();
        JSON.stringify(doc, (_key, value) => {
            if (value && typeof value === "object" && typeof value.$ref === "string") {
                refs.add(value.$ref);
            }
            return value;
        });

        expect(refs.size).toBeGreaterThan(0);
        for (const ref of refs) {
            const name = ref.replace("#/components/schemas/", "");
            expect(Object.keys(doc.components.schemas)).toContain(name);
        }
    });
});
