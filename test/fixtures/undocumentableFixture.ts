import { openapiSchema } from "../../src/index.ts";

export interface Thing {
  id: number;
}

const PATH_KEY = "/computed";
const extraRoutes = { "/spread": () => new Response("spread") };
const methodMapInVariable = { GET: () => new Response("ref") };

// Every entry below exists at runtime but cannot reach the document.
export const routes = openapiSchema.bunRoutes(
  { openapi: "3.0.3", info: { title: "Leaky API", version: "1.0.0" } },
  {
    // Documented normally — proves warnings do not suppress good entries.
    "/ok": { GET: () => Response.json({ id: 1 }) },

    ...extraRoutes,
    [PATH_KEY]: () => new Response("computed"),
    "/referenced": methodMapInVariable,
  }
);

const routesInVariable = {
  "/hidden": { GET: () => new Response("hidden") },
};

export const alsoRoutes = openapiSchema.bunRoutes(
  { openapi: "3.0.3", info: { title: "Hidden API", version: "1.0.0" } },
  routesInVariable
);
