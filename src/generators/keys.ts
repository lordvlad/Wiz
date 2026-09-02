import { flattenObjectProperties, type TypeIR } from "../types.ts";

function extractDeepKeys(
  ir: TypeIR,
  declaredTypes?: ReadonlyMap<string, TypeIR>,
  prefix = "",
  depth = 1,
  maxDepth = 5,
  visited = new Set<string>()
): string[] {
  if (ir.kind === "ref" && declaredTypes) {
    if (visited.has(ir.targetId)) {
      return prefix ? [prefix] : [];
    }
    const target = declaredTypes.get(ir.targetId);
    if (target) {
      return extractDeepKeys(
        target,
        declaredTypes,
        prefix,
        depth,
        maxDepth,
        new Set([...visited, ir.targetId])
      );
    }
  }

  if (ir.kind !== "object" || ir.properties.length === 0 || depth > maxDepth) {
    return prefix ? [prefix] : [];
  }

  const results: string[] = [];
  const nextVisited = ir.name ? new Set([...visited, ir.name]) : visited;

  for (const prop of ir.properties) {
    const keyPath = prefix ? `${prefix}.${prop.name}` : prop.name;
    const childKeys = extractDeepKeys(
      prop.type,
      declaredTypes,
      keyPath,
      depth + 1,
      maxDepth,
      nextVisited
    );
    results.push(...childKeys);
  }

  return results;
}

export function generateKeysCode(
  ir: TypeIR,
  declaredTypes?: ReadonlyMap<string, TypeIR>
): string {
  const props = flattenObjectProperties(ir);

  const keys = props.map((p) => p.name);
  const requiredKeys = props.filter((p) => !p.optional).map((p) => p.name);
  const optionalKeys = props.filter((p) => p.optional).map((p) => p.name);

  const deepKeysByDepth: Record<number, string[]> = {};
  for (let d = 1; d <= 10; d++) {
    deepKeysByDepth[d] = extractDeepKeys(ir, declaredTypes, "", 1, d);
  }

  return [
    `export const keys = ${JSON.stringify(keys)};`,
    `export const requiredKeys = ${JSON.stringify(requiredKeys)};`,
    `export const optionalKeys = ${JSON.stringify(optionalKeys)};`,
    `const _deepKeysByDepth = ${JSON.stringify(deepKeysByDepth)};`,
    `export function deepKeys(options) {`,
    `  const d = Math.min(Math.max(options && typeof options.maxDepth === "number" ? options.maxDepth : 5, 1), 10);`,
    `  return _deepKeysByDepth[d] || _deepKeysByDepth[5];`,
    `}`,
  ].join("\n");
}
