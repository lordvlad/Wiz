import { arrowSchema, decodeArrow, encodeArrow } from "../../src/index.ts";

export interface Reading {
    /** @format int32 */
    sensor: number;
    station: string;
    /** Wall-clock time of the sample. */
    at: Date;
    celsius: number;
    /** @format float */
    humidity: number;
    ok: boolean;
    /** @format int64 */
    sequence: bigint;
    payload: Uint8Array;
    /** Absent when the station did not report one. */
    note?: string;
}

export const readingSchema = arrowSchema<[Reading]>({ indent: "  " });

export function encodeReadings(rows: Reading[], buf: Uint8Array): number {
    return encodeArrow<Reading>(rows, buf);
}

export function decodeReadings(buf: Uint8Array): Reading[] {
    return decodeArrow<Reading>(buf);
}
