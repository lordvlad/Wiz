/**
 * The OpenAPI document, derived from `PetRestApi` at compile time.
 *
 * Run directly to print it: `bun run src/schemas/openapi.ts`.
 */
import { openapiSchema } from "wiz";
import type { PetRestApi } from "../rest.ts";
import type { Problem } from "../model.ts";

export const openapi = openapiSchema<[PetRestApi, Problem]>({
  openapi: "3.1.0",
  info: {
    title: "Petstore",
    version: "1.0.0",
    description:
      "A mini petstore. Every path, schema and media type in this document " +
      "was derived from TypeScript declarations by the wiz plugin.",
  },
  servers: [{ url: "http://localhost:3000" }],
});

if (import.meta.main) {
  console.log(JSON.stringify(openapi, null, 2));
}
