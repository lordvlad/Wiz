/**
 * Plain JSON Schema for the two payloads a client is most likely to build by
 * hand, so the constraints in `model.ts` are usable outside any of the API
 * documents.
 *
 * Run directly to print it: `bun run src/schemas/jsonschema.ts`.
 */
import { jsonSchemas } from "wiz";
import type { NewPet, PetChanged } from "../model.ts";

export const jsonschema = jsonSchemas<[NewPet, PetChanged]>();

if (import.meta.main) {
  console.log(JSON.stringify(jsonschema, null, 2));
}
