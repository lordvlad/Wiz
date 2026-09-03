/**
 * The OpenRPC contract, served over WebSocket by `src/server.ts`.
 *
 * A JSON-RPC method is a name, named params and a result — so unlike REST it
 * needs no path, verb or media type, and the signatures carry almost everything
 * on their own. `@service` supplies the namespace, giving `Pets.listPets`.
 *
 * These names are what `openRPCHandler` dispatches on, and the methods are
 * bound to the same `PetStore` the REST paths use.
 */
import type { NewPet, Pet, PetQuery, Sale } from "./model.ts";

/** @service Pets */
export interface PetRpcApi {
  /**
   * Lists pets, filtered and capped.
   * @summary List pets
   */
  listPets(query: PetQuery): Promise<Pet[]>;

  /**
   * Fetches one pet by id.
   * @summary Fetch a pet
   */
  getPet(id: number): Promise<Pet>;

  /**
   * Adds a pet to the store.
   * @summary Add a pet
   */
  addPet(pet: NewPet): Promise<Pet>;

  /**
   * Sells a pet to an owner.
   * @summary Sell a pet
   */
  sellPet(id: number, sale: Sale): Promise<Pet>;
}
