/**
 * The OpenRPC document, derived from the same `PetApi` the OpenAPI document is.
 *
 * A JSON-RPC method is a name, named params and a result, so `@rpc` on a
 * `PetApi` member is all this document needs: the `@get`/`@post` tags that
 * OpenAPI needs are not read here, an untagged member would not be a method at
 * all, and `@service Pets` supplies the namespace, giving `Pets.get`.
 *
 * Run directly to print it: `bun run src/schemas/openrpc.ts`.
 */
import { openRPCSchema } from "wiz";
import type { PetApi } from "../service.ts";

export const openrpc = openRPCSchema<[PetApi]>({
  openrpc: "1.3.2",
  info: {
    title: "Petstore RPC",
    version: "1.0.0",
    description: "JSON-RPC over WebSocket at ws://localhost:3000/rpc.",
  },
});

if (import.meta.main) {
  console.log(JSON.stringify(openrpc, null, 2));
}
