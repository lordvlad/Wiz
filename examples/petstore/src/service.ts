/**
 * The one implementation every document in this example is derived from.
 *
 * The contracts live on `PetStore` itself: `@get`/`@post`/`@delete` declare the
 * REST operations, `@rpc` the JSON-RPC methods, and `@producer`/`@consumer` the
 * event channels. Because spec macros harvest only tagged members, one class
 * generates all five spec documents without separate interface definitions or
 * leaky methods.
 * REST, OpenRPC-over-WebSocket and the Kafka consumer all call these methods,
 * and the service itself knows nothing about HTTP, JSON-RPC, media types or
 * topics — which is what makes "three protocols, one behaviour" true rather
 * than aspirational.
 */
import { is, validate } from "wiz";
import type {
  ChangeKind,
  NewPet,
  Pet,
  PetChanged,
  PetQuery,
  Problem,
  Sale,
} from "./model.ts";

/** Thrown when a caller asks for a pet that is not there. */
export class NotFoundError extends Error {
  readonly status = 404;
  constructor(petId: number) {
    super(`no pet with id ${petId}`);
    this.name = "NotFoundError";
  }
}

/** Thrown when a payload does not match its declared type. */
export class InvalidError extends Error {
  readonly status = 422;
  constructor(
    message: string,
    readonly errors: unknown[] = []
  ) {
    super(message);
    this.name = "InvalidError";
  }
}

export type ChangeListener = (event: PetChanged) => void | Promise<void>;

/** The `Problem` payload both error classes serialize to. */
export function problemOf(error: NotFoundError | InvalidError): Problem {
  return { status: error.status, detail: error.message };
}

/**
 * The store itself: one implementation class, five spec documents.
 *
 * REST, JSON-RPC, AsyncAPI and Protobuf schemas are all derived from this class.
 * Each macro harvests only the members carrying tags for its protocol.
 *
 * @service Pets
 */
export class PetStore {
  #pets = new Map<number, Pet>();
  #nextId = 1;
  #listeners: ChangeListener[] = [];

  /**
   * A pet was created, updated or sold.
   *
   * Registers a sink for change events; the Kafka producer is one of these.
   *
   * @producer
   * @channel petstore.pets.changed
   * @summary Pet changed
   */
  onChange(listener: ChangeListener): void {
    this.#listeners.push(listener);
  }

  async #publish(kind: ChangeKind, pet: Pet): Promise<void> {
    const event: PetChanged = {
      eventId: crypto.randomUUID(),
      kind,
      petId: pet.id,
      pet,
      occurredAt: new Date(),
    };
    for (const listener of this.#listeners) await listener(event);
  }

  /**
   * Lists pets, filtered and capped.
   *
   * The one operation offered in four representations. Each `@response 200`
   * tag adds a media type to the *same* response object, so the document says
   * one 200 with four `content` entries.
   *
   * @get /pets
   * @rpc
   * @summary List pets
   * @response 200 application/json Pet[]
   * @response 200 application/yaml Pet[]
   * @response 200 application/xml Pet[]
   * @response 200 text/csv Pet[]
   */
  list(query: PetQuery = {}): Pet[] {
    const limit = query.limit ?? 20;
    const needle = query.q?.toLowerCase();
    return [...this.#pets.values()]
      .filter((pet) => query.status === undefined || pet.status === query.status)
      .filter((pet) => !needle || pet.name.toLowerCase().includes(needle))
      .sort((a, b) => a.id - b.id)
      .slice(0, limit);
  }

  /**
   * Fetches one pet as JSON or as protobuf.
   *
   * The protobuf representation is encoded by `encodeProto<Pet>`, generated
   * from the same `@fieldNumber` declarations as `build/schemas/petstore.proto`.
   *
   * @get /pets/{id}
   * @rpc
   * @summary Fetch a pet
   * @response 200 application/json Pet
   * @response 200 application/x-protobuf Pet
   * @response 404 application/json Problem
   */
  get(id: number): Pet {
    const pet = this.#pets.get(id);
    if (!pet) throw new NotFoundError(id);
    return pet;
  }

  /**
   * Adds a pet to the store and publishes a change event.
   *
   * @post /pets
   * @rpc
   * @summary Add a pet
   * @response 201 application/json Pet
   * @response 422 application/json Problem
   */
  async add(body: NewPet): Promise<Pet> {
    if (typeof (body as any).priceCents === "number") {
      (body as any).priceCents = BigInt((body as any).priceCents);
    }
    const errors = validate<NewPet>(body);
    if (errors.length > 0) throw new InvalidError("invalid NewPet", errors);
    const pet: Pet = {
      id: this.#nextId++,
      name: body.name,
      species: body.species,
      status: "available",
      priceCents: BigInt(body.priceCents),
      tags: body.tags ?? [],
      addedAt: new Date(),
    };
    this.#pets.set(pet.id, pet);
    await this.#publish("created", pet);
    return pet;
  }

  /**
   * Sells a pet to an owner and publishes a change event.
   *
   * @post /pets/{id}/sale
   * @rpc
   * @summary Sell a pet
   * @response 200 application/json Pet
   * @response 404 application/json Problem
   * @response 422 application/json Problem
   */
  async sell(id: number, body: Sale): Promise<Pet> {
    if (!is<Sale>(body)) throw new InvalidError("invalid Sale");

    const pet = this.get(id);
    const sold: Pet = {
      ...pet,
      status: "sold",
      owner: { id: body.ownerId, name: body.ownerName, email: body.ownerEmail },
    };
    this.#pets.set(id, sold);
    await this.#publish("sold", sold);
    return sold;
  }

  /**
   * Removes a pet. No body, so no content.
   *
   * @delete /pets/{id}
   * @rpc
   * @summary Remove a pet
   * @response 204
   * @response 404 application/json Problem
   */
  async remove(id: number): Promise<void> {
    this.get(id);
    this.#pets.delete(id);
  }

  /** Every event id already applied, because a topic redelivers. */
  #applied = new Set<string>();

  /**
   * Applied by the consumer to bring a projection back in step.
   *
   * Idempotent by `eventId`, because a topic redelivers. This is the method the
   * Kafka consumer forwards to, so the event round-trips: service → topic →
   * consumer → service.
   *
   * @consumer
   * @channel petstore.pets.changed
   * @summary Pet changed, consumed
   */
  applyChange(event: PetChanged): { applied: boolean } {
    if (this.#applied.has(event.eventId)) return { applied: false };
    this.#applied.add(event.eventId);

    const existing = this.#pets.get(event.petId);
    // A projection would live here. Reinstating a pet the store has lost is
    // enough to show the event carried everything needed to rebuild it.
    if (!existing) this.#pets.set(event.petId, event.pet);
    return { applied: true };
  }

  /** Seeds a few pets so a fresh server has something to serve. */
  async seed(): Promise<void> {
    await this.add({
      name: "Ada",
      species: "dog",
      priceCents: 42_000n,
      tags: ["good-girl", "chipped"],
    });
    await this.add({
      name: "Grace",
      species: "cat",
      priceCents: 31_500n,
      tags: ["quiet"],
    });
    await this.add({
      name: "Alan",
      species: "bird",
      priceCents: 8_000n,
      tags: ["talks"],
    });
  }
}

export const store = new PetStore();
