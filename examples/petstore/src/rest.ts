/**
 * The REST contract.
 *
 * This interface is never implemented and never called — it exists so the
 * OpenAPI document can be derived from types instead of hand-written. JSDoc
 * supplies what a signature cannot: the verb, the path template, and which
 * media types each status is offered in.
 *
 * `src/server.ts` implements these paths for real. The two agree because the
 * payload types here are the same declarations the service returns.
 */
import type {
  NewPet,
  Pet,
  PetQuery,
  Problem,
  Sale,
} from "./model.ts";

/** @service Pets */
export interface PetRestApi {
  /**
   * Lists pets, filtered and capped.
   *
   * The one operation offered in four representations. Each `@response 200`
   * tag adds a media type to the *same* response object, so the document says
   * one 200 with four `content` entries.
   *
   * @get /pets
   * @summary List pets
   * @response 200 application/json Pet[]
   * @response 200 application/yaml Pet[]
   * @response 200 application/xml Pet[]
   * @response 200 text/csv Pet[]
   */
  listPets(params: { query: PetQuery }): Promise<Pet[]>;

  /**
   * Fetches one pet as JSON or as protobuf.
   *
   * The protobuf representation is encoded by `encodeProto<Pet>`, generated
   * from the same `@fieldNumber` declarations as `build/schemas/petstore.proto`.
   *
   * @get /pets/{id}
   * @summary Fetch a pet
   * @response 200 application/json Pet
   * @response 200 application/x-protobuf Pet
   * @response 404 application/json Problem
   */
  getPet(params: { path: { id: number } }): Promise<Pet>;

  /**
   * Adds a pet to the store and publishes a change event.
   *
   * @post /pets
   * @summary Add a pet
   * @response 201 application/json Pet
   * @response 422 application/json Problem
   */
  addPet(body: NewPet): Promise<Pet>;

  /**
   * Sells a pet to an owner and publishes a change event.
   *
   * @post /pets/{id}/sale
   * @summary Sell a pet
   * @response 200 application/json Pet
   * @response 404 application/json Problem
   * @response 422 application/json Problem
   */
  sellPet(params: { path: { id: number }; body: Sale }): Promise<Pet>;

  /**
   * Removes a pet. No body, so no content.
   *
   * @delete /pets/{id}
   * @summary Remove a pet
   * @response 204
   * @response 404 application/json Problem
   */
  removePet(params: { path: { id: number } }): Promise<void>;
}
