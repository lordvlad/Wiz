// @wiz-ignore
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silentLogger } from '../src/logger.ts';
import { transformSource } from '../src/plugin.ts';

/**
 * `openapiDocument()` is answered from the whole import graph, read off disk,
 * and the answer is cached per entry path for the lifetime of the process. A
 * watch build that re-transformed the entry used to get the previous build's
 * document.
 */
const serviceSource = (paths: string[]): string => `
declare function openapiSchema<TTypes extends unknown[]>(
  base?: Record<string, unknown>
): Record<string, unknown>;

export interface User {
  id: number;
}

export interface UserApi {
${paths
  .map(
    (path, index) => `  /**
   * @get ${path}
   * @response 200 User
   */
  read${index}(): Promise<User>;`
  )
  .join('\n')}
}

export const schema = openapiSchema<[UserApi]>({
  openapi: "3.1.0",
  info: { title: "Users", version: "1.0.0" },
});
`;

const orderSource = `
declare function openapiSchema<TTypes extends unknown[]>(
  base?: Record<string, unknown>
): Record<string, unknown>;

export interface Order {
  id: number;
}

export interface OrderApi {
  /**
   * @get /orders
   * @response 200 Order
   */
  listOrders(): Promise<Order>;
}

export const orders = openapiSchema<[OrderApi]>({
  openapi: "3.1.0",
  info: { title: "Orders", version: "1.0.0" },
});
`;

const entrySource = `
import { schema } from "./service.ts";
import { orders } from "./orders.ts";

declare function openapiDocument(): Record<string, unknown>;

export const declared = [schema, orders];
export const document = openapiDocument();
`;

describe('harvested document lifetime', () => {
  let directory: string;
  let entryPath: string;
  let servicePath: string;
  let ordersPath: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'wiz-harvest-'));
    entryPath = join(directory, 'entry.ts');
    servicePath = join(directory, 'service.ts');
    ordersPath = join(directory, 'orders.ts');
    await writeFile(entryPath, entrySource);
    await writeFile(ordersPath, orderSource);
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

  test('a re-transform re-reads the service instead of replaying the last document', async () => {
    await writeFile(servicePath, serviceSource(['/users']));
    const first = transformEntry();

    expect(first).toContain('"/users"');
    expect(first).not.toContain('"/people"');

    // The declarations change on disk while the process, and its caches, live on.
    await writeFile(servicePath, serviceSource(['/users', '/people']));
    const second = transformEntry();

    expect(second).toContain('"/users"');
    expect(second).toContain('"/people"');
  });

  test('every document reachable from the entry is merged into one', async () => {
    await writeFile(servicePath, serviceSource(['/users']));
    const code = transformEntry();

    // One document, both modules: the scope is the import graph, and the answer
    // cannot depend on which file the transform happened to see first.
    expect(code).toContain('"/users"');
    expect(code).toContain('"/orders"');
  });
});
