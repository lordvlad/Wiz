import { decodeProto, encodeProto, protobufSchema, schema } from "../../src/index.ts";
import type { Shape } from "./shapeTypes.ts";

export interface Drawing {
  /** @fieldNumber 1 */
  title: string;
  /** The shape is a oneof; its variants carry field numbers 2 and 3. */
  shape: Shape;
  /** @fieldNumber 4 */
  note?: string;
}

export const drawingProto = protobufSchema<[Drawing]>({ indent: "  " });
export const drawingJsonSchema = schema<Drawing>();

export function encodeDrawing(value: Drawing, buf: Uint8Array): number {
  return encodeProto<Drawing>(value, buf);
}

export function decodeDrawing(buf: Uint8Array): Drawing {
  return decodeProto<Drawing>(buf);
}
