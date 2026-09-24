// @wiz-ignore
import { describe, expect, test } from "bun:test";
import * as zod from "zod";
import { generateValidatorCode } from "../src/generators/validator.ts";
import { generateZodSchemaCode } from "../src/generators/zod.ts";
import type { TypeIR } from "../src/ir/types.ts";
import { evalModule } from "./helpers.ts";

const load = async () => zod;

const FORMAT_CASES: Record<string, { good: string[]; bad: string[] }> = {
    email: {
        good: ["a@b.co", "x.y+z@mail.example.com"],
        bad: ["nope", "a@b", "a b@c.d", "@b.co"],
    },
    uuid: {
        good: ["123e4567-e89b-12d3-a456-426614174000"],
        bad: ["123e4567", "zzze4567-e89b-12d3-a456-426614174000"],
    },
    uri: {
        good: ["https://a.example/x?y=1#z", "mailto:a@b.co", "urn:isbn:123"],
        bad: ["/relative", "not a uri", "//host/path", "http://a b"],
    },
    "uri-reference": {
        good: ["/relative", "https://a.example/x", "../up", "#frag", ""],
        bad: ["has space", "a\tb"],
    },
    "uri-template": {
        good: ["/users/{id}", "https://a/{a}/{b}", "/plain", "{?q,lang}"],
        bad: ["/users/{id", "/a{b{c}}", "/has space"],
    },
    hostname: {
        good: ["example.com", "a", "a-b.example.co.uk", "example.com."],
        bad: ["-bad.com", "bad-.com", "a..b", "has space", `${"x".repeat(64)}.com`],
    },
    ipv4: {
        good: ["0.0.0.0", "255.255.255.255", "192.168.1.1"],
        bad: ["256.1.1.1", "1.1.1", "01.1.1.1", "1.1.1.1.1", "a.b.c.d"],
    },
    ipv6: {
        good: ["::", "::1", "2001:db8::1", "fe80::1", "2001:0db8:0000:0000:0000:0000:0000:0001", "::ffff:192.168.1.1"],
        bad: ["2001:db8::1::2", "gggg::1", "1.2.3.4", "12345::"],
    },
    regex: {
        good: ["^a+b$", "[a-z]+", "plain"],
        bad: ["a[b", "(", "[a-z"],
    },
    "json-pointer": {
        good: ["", "/a", "/a/b", "/a~0b", "/a~1b", "/"],
        bad: ["a", "/a~2b", "~0"],
    },
    "relative-json-pointer": {
        good: ["0", "1/a", "2#", "0/a~1b", "10"],
        bad: ["-1", "01", "/a", "#", "1/a~2"],
    },
};

describe("enforced string formats in validator and zod", () => {
    for (const [format, { good, bad }] of Object.entries(FORMAT_CASES)) {
        test(`format '${format}' validates correctly`, async () => {
            const ir: TypeIR = {
                id: "root",
                kind: "object",
                properties: [
                    {
                        name: "v",
                        optional: false,
                        readonly: false,
                        type: {
                            id: "p",
                            kind: "primitive",
                            type: "string",
                            constraints: [{ kind: "format", value: format }],
                        },
                    },
                ],
            };

            const validatorMod = evalModule<{ validate: (v: unknown) => unknown[] }>(generateValidatorCode(ir));

            const zodMod = evalModule<{
                zodSchema: (l: unknown) => Promise<{ safeParse(v: unknown): { success: boolean } }>;
            }>(generateZodSchemaCode(ir));
            const schema = await zodMod.zodSchema(load);

            for (const val of good) {
                expect(validatorMod.validate({ v: val })).toEqual([]);
                // All non-email formats agree 100% with zod
                if (format !== "email") {
                    expect(schema.safeParse({ v: val }).success).toBe(true);
                }
            }

            for (const val of bad) {
                expect(validatorMod.validate({ v: val }).length).toBeGreaterThan(0);
                expect(schema.safeParse({ v: val }).success).toBe(false);
            }
        });
    }
});
