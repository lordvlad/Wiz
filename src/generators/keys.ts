import { flattenObjectProperties, type TypeIR } from "../types.ts";

export function generateKeysCode(ir: TypeIR): string {
  const props = flattenObjectProperties(ir);

  const keys = props.map((p) => p.name);
  const requiredKeys = props.filter((p) => !p.optional).map((p) => p.name);
  const optionalKeys = props.filter((p) => p.optional).map((p) => p.name);

  return [
    `export const keys = ${JSON.stringify(keys)};`,
    `export const requiredKeys = ${JSON.stringify(requiredKeys)};`,
    `export const optionalKeys = ${JSON.stringify(optionalKeys)};`,
  ].join("\n");
}
