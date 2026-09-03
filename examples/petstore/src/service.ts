/**
 * The one implementation every interface in this example is a view onto.
 *
 * REST, OpenRPC-over-WebSocket and the Kafka consumer all call these methods.
 * The service knows nothing about HTTP, JSON-RPC, media types or topics — which
 * is what makes "three protocols, one behaviour" true rather than aspirational.
 */
import { is, validate } from "wiz";
import {
  ChangeKind,
  PetStatus,
  Species,
  type NewPet,
  type Pet,
  type PetChanged,
  type PetQuery,
  type Sale,
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

export class PetStore {
  #pets = new Map<number, Pet>();
  #nextId = 1;
  #listeners: ChangeListener[] = [];

  /** Registers a sink for change events; the Kafka producer is one of these. */
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

  list(query: PetQuery = {}): Pet[] {
    const limit = query.limit ?? 20;
    const needle = query.q?.toLowerCase();
    return [...this.#pets.values()]
      .filter((pet) => query.status === undefined || pet.status === query.status)
      .filter((pet) => !needle || pet.name.toLowerCase().includes(needle))
      .sort((a, b) => a.id - b.id)
      .slice(0, limit);
  }

  get(id: number): Pet {
    const pet = this.#pets.get(id);
    if (!pet) throw new NotFoundError(id);
    return pet;
  }

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
      status: PetStatus.Available,
      priceCents: BigInt(body.priceCents),
      tags: body.tags ?? [],
      addedAt: new Date(),
    };
    this.#pets.set(pet.id, pet);
    await this.#publish(ChangeKind.Created, pet);
    return pet;
  }

  async sell(id: number, sale: Sale): Promise<Pet> {
    if (!is<Sale>(sale)) throw new InvalidError("invalid Sale");

    const pet = this.get(id);
    const sold: Pet = {
      ...pet,
      status: PetStatus.Sold,
      owner: { id: sale.ownerId, name: sale.ownerName, email: sale.ownerEmail },
    };
    this.#pets.set(id, sold);
    await this.#publish(ChangeKind.Sold, sold);
    return sold;
  }

  async remove(id: number): Promise<void> {
    this.get(id);
    this.#pets.delete(id);
  }

  /**
   * Where consumed change events land.
   *
   * Idempotent by `eventId`, because a topic redelivers. This is the method the
   * Kafka consumer forwards to, so the event round-trips: service → topic →
   * consumer → service.
   */
  #applied = new Set<string>();

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
      species: Species.Dog,
      priceCents: 42_000n,
      tags: ["good-girl", "chipped"],
    });
    await this.add({
      name: "Grace",
      species: Species.Cat,
      priceCents: 31_500n,
      tags: ["quiet"],
    });
    await this.add({
      name: "Alan",
      species: Species.Bird,
      priceCents: 8_000n,
      tags: ["talks"],
    });
  }
}

export const store = new PetStore();
