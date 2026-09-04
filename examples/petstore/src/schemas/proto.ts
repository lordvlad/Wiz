/**
 * The `.proto` messages, derived from the model's `@fieldNumber` tags.
 *
 * This is proto *text*, not a JSON document, so it prints as-is rather than
 * through `JSON.stringify`. Run directly: `bun run src/schemas/proto.ts`.
 *
 * Messages only: the petstore's operations are HTTP and JSON-RPC, so there is
 * no gRPC service to declare. `grpcSchema<[Service]>()` is what turns a
 * TypeScript service interface into `service`/`rpc` blocks, and consuming a
 * `.proto` that declares services is the other direction, which
 * `build:clients:proto` shows.
 */
import { protobufSchema } from "wiz";
import type { NewPet, Owner, Pet, PetChanged, Sale } from "../model.ts";

export const proto = protobufSchema<[Pet, NewPet, Sale, Owner, PetChanged]>();

if (import.meta.main) {
  console.log(proto);
}
