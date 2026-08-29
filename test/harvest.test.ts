// @wiz-ignore
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transformSource } from "../src/plugin.ts";
import { silentLogger } from "../src/logger.ts";

/**
 * `openapiDocument()` is answered from the whole import graph, read off disk, and
 * the answer was cached per entry path for the lifetime of the process. A watch
 * build that re-transformed the entry then got the previous build's document.
 */
const routesSource = (paths: string[]): string => `
declare function op<TSpec>(handler: unknown): unknown;
declare const openapiSchema: {
  bunRoutes<TRoutes>(base: Record<string, unknown>, routes: TRoutes): TRoutes;
};

export interface User {
  id: number;
}

export const routes = openapiSchema.bunRoutes(
  { openapi: "3.1.0", info: { title: "Users", version: "1.0.0" } },
  {
${paths.map((path) => `    "${path}": { GET: op<{ response: User[] }>(() => null) },`).join("\n")}
  }
);
`;

const entrySource = `
import { routes } from "./routes.ts";

declare function openapiDocument(): Record<string, unknown>;

export const mounted = routes;
export const document = openapiDocument();
`;

describe("harvested document lifetime", () => {
  let directory: string;
  let entryPath: string;
  let routesPath: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "wiz-harvest-"));
    entryPath = join(directory, "entry.ts");
    routesPath = join(directory, "routes.ts");
    await writeFile(entryPath, entrySource);
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const transformEntry = (): string =>
    transformSource({
      path: entryPath,
      contents: entrySource,
      logger: silentLogger,
    }).code;

  test("a re-transform re-reads the routes instead of replaying the last document", async () => {
    await writeFile(routesPath, routesSource(["/users"]));
    const first = transformEntry();

    expect(first).toContain('"/users"');
    expect(first).not.toContain('"/people"');

    // The route map changes on disk while the process, and its caches, live on.
    await writeFile(routesPath, routesSource(["/users", "/people"]));
    const second = transformEntry();

    expect(second).toContain('"/users"');
    expect(second).toContain('"/people"');
  });
});
