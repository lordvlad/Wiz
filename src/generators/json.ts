import type { TypeIR } from '../ir/types.ts';

function needsTransform(ir: TypeIR, visited = new Set<TypeIR>()): boolean {
  if (visited.has(ir)) {
    return false;
  }
  visited.add(ir);

  switch (ir.kind) {
    case 'primitive':
      return ir.type === 'bigint' || ir.type === 'date' || ir.type === 'bytes';
    case 'literal':
      return typeof ir.value === 'bigint';
    case 'object':
      for (const prop of ir.properties) {
        if (needsTransform(prop.type, visited)) {
          return true;
        }
      }
      if (typeof ir.additionalProperties === 'object') {
        if (needsTransform(ir.additionalProperties, visited)) {
          return true;
        }
      }
      return false;
    case 'array':
      return needsTransform(ir.element, visited);
    case 'tuple':
      for (const elem of ir.elements) {
        if (needsTransform(elem.type, visited)) {
          return true;
        }
      }
      return ir.rest ? needsTransform(ir.rest, visited) : false;
    case 'union':
    case 'intersection':
      return ir.types.some((t) => needsTransform(t, visited));
    case 'record':
      return needsTransform(ir.keyType, visited) || needsTransform(ir.valueType, visited);
    case 'enum':
      return ir.members.some((m) => typeof m.value === 'bigint');
    case 'ref':
      return false;
  }
}

let varSeq = 0;

function encodeExpr(ir: TypeIR, expr: string): string {
  if (!needsTransform(ir)) {
    return expr;
  }
  const seq = ++varSeq;

  switch (ir.kind) {
    case 'primitive':
      if (ir.type === 'bigint') {
        return `(typeof ${expr} === "bigint" ? String(${expr}) : ${expr})`;
      }
      if (ir.type === 'date') {
        return `(${expr} instanceof Date ? ${expr}.toISOString() : ${expr})`;
      }
      if (ir.type === 'bytes') {
        return `(${expr} instanceof Uint8Array ? (typeof Buffer !== "undefined" ? Buffer.from(${expr}).toString("base64") : btoa(Array.from(${expr}, (x) => String.fromCharCode(x)).join(""))) : ${expr})`;
      }
      return expr;

    case 'literal':
      if (typeof ir.value === 'bigint') {
        return `(typeof ${expr} === "bigint" ? String(${expr}) : ${expr})`;
      }
      return expr;

    case 'object': {
      const propsToTransform = ir.properties.filter((p) => needsTransform(p.type));
      if (propsToTransform.length === 0) {
        return expr;
      }

      const varOut = `_out${seq}`;
      const assignments = propsToTransform
        .map(
          (p) =>
            `if (${varOut}[${JSON.stringify(p.name)}] !== undefined) ${varOut}[${JSON.stringify(
              p.name
            )}] = ${encodeExpr(p.type, `${varOut}[${JSON.stringify(p.name)}]`)};`
        )
        .join(' ');

      return `(() => { if (${expr} === null || typeof ${expr} !== "object") return ${expr}; const ${varOut} = { ...${expr} }; ${assignments} return ${varOut}; })()`;
    }

    case 'array':
      return `(Array.isArray(${expr}) ? ${expr}.map((_item${seq}) => ${encodeExpr(
        ir.element,
        `_item${seq}`
      )}) : ${expr})`;

    case 'union':
    case 'intersection': {
      const varV = `_v${seq}`;
      const varOut = `_out${seq}`;
      const branches: string[] = [];
      for (const t of ir.types) {
        if (needsTransform(t)) {
          if (t.kind === 'object') {
            const propsToTransform = t.properties.filter((p) => needsTransform(p.type));
            for (const p of propsToTransform) {
              branches.push(
                `if (${varV}[${JSON.stringify(p.name)}] !== undefined) ${varOut}[${JSON.stringify(p.name)}] = ${encodeExpr(p.type, `${varV}[${JSON.stringify(p.name)}]`)};`
              );
            }
          }
        }
      }
      return `(() => {
        const ${varV} = ${expr};
        if (${varV} === null || ${varV} === undefined) return ${varV};
        if (typeof ${varV} === "bigint") return String(${varV});
        if (${varV} instanceof Date) return ${varV}.toISOString();
        if (${varV} instanceof Uint8Array) return typeof Buffer !== "undefined" ? Buffer.from(${varV}).toString("base64") : btoa(Array.from(${varV}, (x) => String.fromCharCode(x)).join(""));
        if (typeof ${varV} === "object") {
          // An array member of the union carries no keys to rewrite, so it is
          // copied and returned as-is; only the object members are walked.
          if (Array.isArray(${varV})) return [...${varV}];
          const ${varOut} = { ...${varV} };
          ${branches.join('\n          ')}
          return ${varOut};
        }
        return ${varV};
      })()`;
    }
    default:
      return expr;
  }
}

function decodeStatements(ir: TypeIR, target: string): string[] {
  if (!needsTransform(ir)) {
    return [];
  }

  switch (ir.kind) {
    case 'primitive':
      if (ir.type === 'bigint') {
        return [
          `if (typeof ${target} === "string" || typeof ${target} === "number") ${target} = BigInt(${target});`,
        ];
      }
      if (ir.type === 'date') {
        return [
          `if (typeof ${target} === "string" || typeof ${target} === "number") ${target} = new Date(${target});`,
        ];
      }
      if (ir.type === 'bytes') {
        return [
          `if (typeof ${target} === "string") ${target} = typeof Buffer !== "undefined" ? new Uint8Array(Buffer.from(${target}, "base64")) : Uint8Array.from(atob(${target}), (c) => c.charCodeAt(0));`,
        ];
      }
      return [];

    case 'literal':
      if (typeof ir.value === 'bigint') {
        return [
          `if (typeof ${target} === "string" || typeof ${target} === "number") ${target} = BigInt(${target});`,
        ];
      }
      return [];

    case 'object': {
      const stmts: string[] = [];
      for (const prop of ir.properties) {
        if (needsTransform(prop.type)) {
          const propRef = `${target}[${JSON.stringify(prop.name)}]`;
          const subStmts = decodeStatements(prop.type, propRef);
          if (subStmts.length > 0) {
            stmts.push(
              `if (${target} && typeof ${target} === "object" && ${propRef} !== undefined) { ${subStmts.join(
                ' '
              )} }`
            );
          }
        }
      }
      return stmts;
    }

    case 'array': {
      const subStmts = decodeStatements(ir.element, `${target}[_i]`);
      if (subStmts.length > 0) {
        return [
          `if (Array.isArray(${target})) { for (let _i = 0; _i < ${target}.length; _i++) { ${subStmts.join(
            ' '
          )} } }`,
        ];
      }
      return [];
    }

    case 'record': {
      const subStmts = decodeStatements(ir.valueType, `${target}[_k]`);
      if (subStmts.length > 0) {
        return [
          `if (${target} && typeof ${target} === "object") { for (const _k of Object.keys(${target})) { ${subStmts.join(
            ' '
          )} } }`,
        ];
      }
      return [];
    }
    case 'union':
    case 'intersection': {
      const stmts: string[] = [
        `if (typeof ${target} === "string") {`,
        `  if (/^-?\\d+$/.test(${target})) { try { ${target} = BigInt(${target}); } catch {} }`,
        `  else if (!Number.isNaN(Date.parse(${target}))) { ${target} = new Date(${target}); }`,
        `}`,
      ];
      for (const t of ir.types) {
        if (needsTransform(t)) {
          const subStmts = decodeStatements(t, target);
          if (subStmts.length > 0) {
            stmts.push(...subStmts);
          }
        }
      }
      return stmts;
    }
    default:
      return [];
  }
}

/**
 * Generates Virtual Module code for `encodeJson` and `decodeJson` for a single TypeIR.
 */
export function generateJsonCode(ir: TypeIR): string {
  const enc = encodeExpr(ir, 'val');
  const decStmts = decodeStatements(ir, 'val');

  const encodeBody =
    enc === 'val'
      ? '  return JSON.stringify(val, null, indent);'
      : `  const obj = ${enc};\n  return JSON.stringify(obj, null, indent);`;

  const decodeBody =
    decStmts.length === 0
      ? '  return typeof raw === "string" ? JSON.parse(raw) : raw;'
      : `  let val = typeof raw === "string" ? JSON.parse(raw) : raw;\n  ${decStmts.join('\n  ')}\n  return val;`;

  return [
    `export function encodeJson(val, indent) {`,
    encodeBody,
    `}`,
    ``,
    `export function decodeJson(raw) {`,
    decodeBody,
    `}`,
  ].join('\n');
}

/**
 * Generates codec file content (e.g. `codec.ts`) for a list of named types.
 */
export function generateJsonCodecCode(
  types: Array<{ name: string; ir: TypeIR }>,
  options: { modelModule?: string; identifiers?: ReadonlyMap<string, string> } = {}
): string {
  const identifierFor = (name: string): string => {
    const mapped = options.identifiers?.get(name);
    if (mapped) {
      return mapped;
    }
    const sanitized = name.replace(/[^A-Za-z0-9_$]/g, '_');
    return /^[A-Za-z_$]/.test(sanitized) ? sanitized : `_${sanitized}`;
  };

  const exported = (kind: 'encode' | 'decode', identifier: string): string =>
    `${kind}${identifier.charAt(0).toUpperCase()}${identifier.slice(1)}`;

  const codeBlocks: string[] = [];
  const modelTypes: string[] = [];

  types.forEach(({ name, ir }) => {
    const identifier = identifierFor(name);
    const valueType = options.modelModule ? identifier : 'unknown';
    if (options.modelModule) {
      modelTypes.push(identifier);
    }

    // The encode transform rewrites fields to their wire types - a bigint
    // leaves as a string, a Date as an ISO string - so the value being walked
    // no longer satisfies the model type it came from. It is widened once, at
    // the boundary where that stops being true, rather than assigning wire
    // values into the model's own field types, which does not typecheck in the
    // consumer's build.
    const enc = encodeExpr(ir, 'source');
    const decStmts = decodeStatements(ir, 'val');

    const encodeBody =
      enc === 'source'
        ? '  return JSON.stringify(val);'
        : `  const source = val as unknown as Record<string, unknown>;\n  const obj = ${enc};\n  return JSON.stringify(obj);`;

    const decodeBody =
      decStmts.length === 0
        ? '  return typeof raw === "string" ? JSON.parse(raw) : raw;'
        : `  let val = typeof raw === "string" ? JSON.parse(raw) : raw;\n  ${decStmts.join('\n  ')}\n  return val;`;
    codeBlocks.push(
      `export function ${exported('encode', identifier)}(val: ${valueType}): string {\n${encodeBody}\n}`,
      `export function ${exported('decode', identifier)}(raw: string): ${valueType} {\n${decodeBody}\n}`
    );
  });

  const imports =
    options.modelModule && modelTypes.length > 0
      ? `import type { ${[...new Set(modelTypes)].sort().join(', ')} } from "${options.modelModule}";\n\n`
      : '';

  return imports + codeBlocks.join('\n\n');
}
