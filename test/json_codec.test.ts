// @wiz-ignore
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { generateJsonCode, generateJsonCodecCode } from "../src/generators/json.ts";
import { getIRsForSource, evalModule } from "./helpers.ts";
import { transformSource } from "../src/plugin.ts";
import { silentLogger } from "../src/logger.ts";

interface JsonCodec {
  encodeJson(val: unknown, indent?: string | number): string;
  decodeJson(raw: string): unknown;
}

const irFor = (source: string, name: string) =>
  getIRsForSource(source, [name])[name]!.ir;

describe("JSON encoders and decoders (encodeJson / decodeJson)", () => {
  test("plain types use raw JSON.stringify and JSON.parse", () => {
    const ir = irFor("export interface Plain { id: string; count: number }", "Plain");
    const code = generateJsonCode(ir);

    expect(code).toContain("return JSON.stringify(val, null, indent);");
    expect(code).toContain('return typeof raw === "string" ? JSON.parse(raw) : raw;');
  });

  test("bigint, Date, and bytes handling in encodeJson and decodeJson", () => {
    const ir = irFor(
      `export interface Event {
        id: string;
        timestamp: Date;
        amount: bigint;
        payload: Uint8Array;
      }`,
      "Event"
    );

    const code = generateJsonCode(ir);
    const mod = evalModule<JsonCodec>(code);

    const now = new Date("2026-09-01T12:00:00.000Z");
    const original = {
      id: "evt_1",
      timestamp: now,
      amount: 9007199254740993n,
      payload: new Uint8Array([1, 2, 3, 4]),
    };

    const encoded = mod.encodeJson(original);
    expect(typeof encoded).toBe("string");
    expect(encoded).toContain('"amount":"9007199254740993"');
    expect(encoded).toContain('"timestamp":"2026-09-01T12:00:00.000Z"');

    const decoded = mod.decodeJson(encoded) as typeof original;
    expect(decoded.id).toBe("evt_1");
    expect(decoded.timestamp).toBeInstanceOf(Date);
    expect(decoded.timestamp.toISOString()).toBe("2026-09-01T12:00:00.000Z");
    expect(decoded.amount).toBe(9007199254740993n);
    expect(decoded.payload).toBeInstanceOf(Uint8Array);
    expect(Array.from(decoded.payload)).toEqual([1, 2, 3, 4]);
  });

  test("plugin rewrites encodeJson and decodeJson callsites", () => {
    const source = `
      import { encodeJson, decodeJson } from "wiz";
      export interface Item { name: string; created: Date }
      export const raw = encodeJson<Item>({ name: "tool", created: new Date() });
      export const item = decodeJson<Item>(raw);
    `;

    const result = transformSource({ path: "app.ts", contents: source, logger: silentLogger });
    expect(result.code).toContain("encodeJson as __wiz_encodeJson_");
    expect(result.code).toContain("decodeJson as __wiz_decodeJson_");
    expect(result.code).toContain("= __wiz_encodeJson_");
    expect(result.code).toContain("= __wiz_decodeJson_");
  });

  test("generateJsonCodecCode emits named codecs for model types", () => {
    const ir = irFor("export interface User { id: string; balance: bigint }", "User");
    const code = generateJsonCodecCode([{ name: "User", ir }], { modelModule: "./model.ts" });

    expect(code).toContain('import type { User } from "./model.ts";');
    expect(code).toContain("export function encodeUser(val: User): string");
    expect(code).toContain("export function decodeUser(raw: string): User");
  });

  /**
   * The named codecs are typed from the model, but what they encode is the wire
   * shape - a bigint as a string, a Date as an ISO string - so writing those
   * back into the model's own field types is not assignable. The consumer
   * compiles this file, so the error surfaced in their build, not ours.
   */
  test("emitted named codecs typecheck under strict TypeScript", async () => {
    const model = [
      "export interface Event { id: string; amount: bigint; created: Date; payload: Uint8Array }",
      "export interface Wrapper { events: Event[]; note?: string }",
      "export type Either = Event | Wrapper;",
      "export interface Keyed { byKey: Record<string, Event> }",
      "export type Amount = bigint;",
      "export interface Pair { pair: [bigint, Date] }",
    ].join("\n");
    const names = ["Event", "Wrapper", "Either", "Keyed", "Amount", "Pair"];
    const irs = getIRsForSource(model, names);
    const code = generateJsonCodecCode(
      names.map((name) => ({ name, ir: irs[name]!.ir })),
      { modelModule: "./model.ts" }
    );

    const directory = await mkdtemp(join(tmpdir(), "wiz-json-codec-"));
    try {
      const modelPath = join(directory, "model.ts");
      const codecPath = join(directory, "codec.ts");
      await Bun.write(modelPath, `${model}\n`);
      await Bun.write(codecPath, `${code}\n`);

      const program = ts.createProgram([modelPath, codecPath], {
        strict: true,
        noEmit: true,
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        allowImportingTsExtensions: true,
        skipLibCheck: true,
        lib: ["lib.esnext.d.ts", "lib.dom.d.ts"],
        types: ["bun"],
      });

      const diagnostics = [
        ...program.getSyntacticDiagnostics(),
        ...program.getSemanticDiagnostics(),
      ].map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")
      );

      expect(diagnostics).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("encodeJson accepts optional indent parameter", () => {
    const ir = irFor("export interface Plain { id: string; count: number }", "Plain");
    const code = generateJsonCode(ir);
    const mod = evalModule<JsonCodec>(code);

    const data = { id: "a1", count: 10 };
    const indentedNum = mod.encodeJson(data, 2);
    expect(indentedNum).toBe(JSON.stringify(data, null, 2));

    const indentedStr = mod.encodeJson(data, "\t");
    expect(indentedStr).toBe(JSON.stringify(data, null, "\t"));
  });
});
