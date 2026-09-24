import { avroSchema, decodeAvro, encodeAvro } from "../../src/index.ts";

export interface Event {
    /**
     * @format int64
     */
    sequence: number;
    name: string;
    /**
     * Wall-clock nanoseconds, well past 2^53.
     */
    timestamp: bigint;
    tags: string[];
    source?: string;
}

export const eventAvroSchema = avroSchema<[Event]>({ indent: "  " });

export function encodeEvent(event: Event, buf: Uint8Array): number {
    return encodeAvro<Event>(event, buf);
}

export function decodeEvent(buf: Uint8Array): Event {
    return decodeAvro<Event>(buf);
}
