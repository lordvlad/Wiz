// @wiz-ignore
import { beforeAll, describe, expect, test } from "bun:test";
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
    expect(model).toContain(
      "export type Status = (typeof Status)[keyof typeof Status];"
    );
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
  expect(() =>
    new Bun.Transpiler({ loader: "ts" }).transformSync(model)
  ).not.toThrow();
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
    { format: "json" }
  );
  generate(api, tsClientGenerator, {}, logger);

  const matches = warnings.filter((line) =>
    line.includes("no plugin handles vendor extension 'x-widget'")
  );
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
    { format: "json" }
  );
  const generated = generate(
    api,
    tsClientGenerator,
    {
      plugins: [
        {
          name: "t",
          extensions: ["x-widget"],
          declaration: ({ name }) =>
            name === "Widget" ? "export type Widget = 42;" : undefined,
        },
      ],
    },
    logger
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
    { format: "json" }
  );
  const without = extractApiIR(
    document({ Status: { type: "string", enum: ["active", "banned"] } }),
    { format: "json" }
  );

  const a = generate(withExtensions, tsClientGenerator, { validate: true }, silentLogger);
  const b = generate(without, tsClientGenerator, { validate: true }, silentLogger);

  expect(a["api.ts"]).toBe(b["api.ts"]!);
});
