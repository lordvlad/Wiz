// @wiz-ignore
import { describe, expect, test } from "bun:test";
import { generate, type Generator } from "../src/generators/generator.ts";
import { emptyApiComponents, type ApiIR } from "../src/ir/api.ts";
import { emptyService } from "../src/ir/service.ts";
import { silentLogger } from "../src/logger.ts";
import type { TypeIR } from "../src/types.ts";

const type: TypeIR = { id: "t_1", kind: "object", properties: [] };
const service = emptyService();
const api: ApiIR = {
    kind: "api",
    version: "3.1",
    types: new Map(),
    components: emptyApiComponents(),
    service: emptyService(),
    diagnostics: [],
};

describe("generator dispatch", () => {
    test("each IR root reaches its own handler", () => {
        const seen: string[] = [];
        const everything: Generator = {
            name: "everything",
            type: () => {
                seen.push("type");
                return { "type.txt": "" };
            },
            service: () => {
                seen.push("service");
                return { "service.txt": "" };
            },
            api: () => {
                seen.push("api");
                return { "api.txt": "" };
            },
        };

        expect(generate(type, everything, {}, silentLogger)).toEqual({ "type.txt": "" });
        expect(generate(service, everything, {}, silentLogger)).toEqual({ "service.txt": "" });
        expect(generate(api, everything, {}, silentLogger)).toEqual({ "api.txt": "" });
        expect(seen).toEqual(["type", "service", "api"]);
    });

    test("options and logger are handed through untouched", () => {
        const recorder: Generator<{ lenient?: boolean }> = {
            name: "recorder",
            type: (_ir, context) => ({
                "out.txt": JSON.stringify(context.options),
            }),
        };

        expect(generate(type, recorder, { lenient: true }, silentLogger)).toEqual({
            "out.txt": '{"lenient":true}',
        });
    });

    /**
     * A generator that cannot read a root has to say so: emitting nothing would
     * look like a document with no operations in it.
     */
    test("an unsupported root names the generator and what it does read", () => {
        const typesOnly: Generator = { name: "types-only", type: () => ({}) };

        expect(() => generate(api, typesOnly, {}, silentLogger)).toThrow(
            "generator 'types-only' cannot generate from 'api'; it reads a type",
        );
        expect(() => generate(service, typesOnly, {}, silentLogger)).toThrow("cannot generate from 'service'");
    });

    test("a generator with no handlers at all is reported as such", () => {
        const empty: Generator = { name: "empty" };

        expect(() => generate(type, empty, {}, silentLogger)).toThrow("it declares no inputs at all");
    });
});
