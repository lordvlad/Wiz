/**
 * The OpenAPI document, derived from `PetApi` at compile time.
 *
 * Run directly to print it: `bun run src/schemas/openapi.ts`.
 */
import { openapiSchema } from "wiz";
import type { Problem } from "../model.ts";
import type { PetApi } from "../service.ts";

export const openapi = openapiSchema<[PetApi, Problem]>({
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
