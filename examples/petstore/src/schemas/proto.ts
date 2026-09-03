/**
 * The `.proto` messages, derived from the model's `@fieldNumber` tags.
 *
 * This is proto *text*, not a JSON document, so it prints as-is rather than
 * through `JSON.stringify`. Run directly: `bun run src/schemas/proto.ts`.
 *
 * wiz derives protobuf messages and a binary codec from TypeScript; it does not
 * derive `service`/`rpc` blocks. Consuming a `.proto` that declares services is
 * the other direction, and `build:clients:proto` shows it.
 */
import { protobufSchema } from "wiz";
import type { NewPet, Owner, Pet, PetChanged, Sale } from "../model.ts";

export const proto = protobufSchema<[Pet, NewPet, Sale, Owner, PetChanged]>();

if (import.meta.main) {
  console.log(proto);
}
