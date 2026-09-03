/**
 * The OpenRPC document, derived from `PetRpcApi` at compile time.
 *
 * Run directly to print it: `bun run src/schemas/openrpc.ts`.
 */
import { openRPCSchema } from "wiz";
import type { PetRpcApi } from "../rpc.ts";

export const openrpc = openRPCSchema<[PetRpcApi]>({
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
