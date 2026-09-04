/**
 * The AsyncAPI document, derived from `PetStore` at compile time.
 *
 * The store's own members carry the tags: the producer in the document is its
 * `onChange` listener registration and the consumer its `applyChange`. Its
 * untagged members are not channel operations, so the class harvests to exactly
 * those two.
 *
 * Run directly to print it: `bun run src/schemas/asyncapi.ts`.
 */
import { asyncapiSchema } from "wiz";
import type { PetChanged } from "../model.ts";
import type { PetStore } from "../service.ts";

export const asyncapi = asyncapiSchema<[PetStore, PetChanged]>({
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
