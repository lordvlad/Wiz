/**
 * The mocked Kafka broker, and the wiring that closes the loop.
 *
 * The event *contract* is not here: it is the `@producer`/`@consumer` tags on
 * `PetStore` in `src/service.ts`, carried by the two members that satisfy them,
 * because the producer is the store's own `onChange` registration and the
 * consumer its `applyChange`. This file is a log and an array — enough to show
 * the round trip without a dependency.
 *
 * The loop is: `PetStore` mutates → `publish` → topic → `startConsumer` →
 * `PetStore.applyChange`. The consumer's parameter type and the producer's
 * payload type are the same declaration, so a change to `PetChanged` breaks
 * both ends at compile time.
 */
import { decodeJson, encodeJson } from "wiz";
import type { PetChanged } from "./model.ts";
import type { PetStore } from "./service.ts";

export const TOPIC = "petstore.pets.changed";

/** One partition, one offset counter, no network. */
export class MockBroker {
  #log: string[] = [];
  #subscribers: Array<(raw: string, offset: number) => void | Promise<void>> = [];

  get depth(): number {
    return this.#log.length;
  }

  async produce(topic: string, raw: string): Promise<number> {
    const offset = this.#log.length;
    this.#log.push(raw);
    console.log(`[kafka] → ${topic}@${offset} ${raw.length}B`);
    for (const subscriber of this.#subscribers) await subscriber(raw, offset);
    return offset;
  }

  subscribe(fn: (raw: string, offset: number) => void | Promise<void>): void {
    this.#subscribers.push(fn);
  }
}

export const broker = new MockBroker();

/**
 * Wires the store's change events onto the topic.
 *
 * `encodeJson<PetChanged>` is generated, so `bigint` and `Date` survive the
 * trip as the schema says they do rather than as whatever `JSON.stringify`
 * happens to do with them.
 */
export function startProducer(store: PetStore): void {
  store.onChange(async (event) => {
    await broker.produce(TOPIC, encodeJson<PetChanged>(event));
  });
}

/**
 * Reads the topic and forwards each event to a service method.
 *
 * `decodeJson<PetChanged>` is the inverse of the producer's encoder, from the
 * same IR, which is the only reason `occurredAt` arrives as a `Date` and
 * `priceCents` as a `bigint`.
 */
export function startConsumer(store: PetStore): void {
  broker.subscribe((raw, offset) => {
    const event = decodeJson<PetChanged>(raw);
    const { applied } = store.applyChange(event);
    console.log(
      `[kafka] ← ${TOPIC}@${offset} ${event.kind}:${event.petId}(${event.pet.name}) applied=${applied}`
    );
  });
}
