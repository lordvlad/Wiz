/**
 * The AsyncAPI document, derived from `PetEvents` at compile time.
 *
 * Run directly to print it: `bun run src/schemas/asyncapi.ts`.
 */
import { asyncapiSchema } from "wiz";
import type { PetEvents } from "../events.ts";
import type { PetChanged } from "../model.ts";

export const asyncapi = asyncapiSchema<[PetEvents, PetChanged]>({
  info: {
    title: "Petstore Events",
    version: "1.0.0",
    description:
      "Change events published to petstore.pets.changed, and consumed back " +
      "off it by the projection.",
  },
});

if (import.meta.main) {
  console.log(JSON.stringify(asyncapi, null, 2));
}
