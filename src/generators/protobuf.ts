import {
  collectNamedTypes,
  flattenObjectProperties,
  type TypeIR,
} from "../types.ts";

export function generateProtobufCode(ir: TypeIR): string {
  const typeName = ir.name ?? "Target";
  const props = flattenObjectProperties(ir);

  // Check if any property is missing @fieldNumber
  const missingProp = props.find(
    (p) => p.fieldNumber === undefined || Number.isNaN(p.fieldNumber)
  );

  if (missingProp || props.length === 0) {
    const errMessage = missingProp
      ? `[wiz] Property '${missingProp.name}' on type '${typeName}' is missing required '@fieldNumber <N>' JSDoc tag for protobuf encoding/decoding.`
      : `[wiz] Type '${typeName}' has no properties for protobuf encoding/decoding.`;

    return [
      `export function encodeProto(val, buf, offset = 0) {`,
      `  throw new Error(${JSON.stringify(errMessage)});`,
      `}`,
      ``,
      `export function decodeProto(buf, offset = 0) {`,
      `  throw new Error(${JSON.stringify(errMessage)});`,
      `}`,
    ].join("\n");
  }

  // Sort properties by field number
  const sortedProps = [...props].sort(
    (a, b) => a.fieldNumber! - b.fieldNumber!
  );

  const encodeLines: string[] = [];
  const decodeCases: string[] = [];

  for (const p of sortedProps) {
    const fn = p.fieldNumber!;
    const propName = p.name;
    const jsonProp = JSON.stringify(propName);
    const pType = p.type;

    if (
      pType.kind === "primitive" &&
      (pType.type === "string" || pType.type === "symbol")
    ) {
      const tag = (fn << 3) | 2;
      encodeLines.push(`  if (val[${jsonProp}] !== undefined) {`);
      encodeLines.push(`    o += writeVarint(buf, o, ${tag});`);
      encodeLines.push(`    o += writeString(buf, o, String(val[${jsonProp}]));`);
      encodeLines.push(`  }`);

      decodeCases.push(`      case ${fn}: {`);
      decodeCases.push(`        let res; [res, o] = readString(buf, o);`);
      decodeCases.push(`        obj[${jsonProp}] = res;`);
      decodeCases.push(`        break;`);
      decodeCases.push(`      }`);
    } else if (
      pType.kind === "primitive" &&
      pType.type === "boolean"
    ) {
      const tag = (fn << 3) | 0;
      encodeLines.push(`  if (val[${jsonProp}] !== undefined) {`);
      encodeLines.push(`    o += writeVarint(buf, o, ${tag});`);
      encodeLines.push(`    o += writeVarint(buf, o, val[${jsonProp}] ? 1 : 0);`);
      encodeLines.push(`  }`);

      decodeCases.push(`      case ${fn}: {`);
      decodeCases.push(`        let res; [res, o] = readVarint(buf, o);`);
      decodeCases.push(`        obj[${jsonProp}] = Boolean(res);`);
      decodeCases.push(`        break;`);
      decodeCases.push(`      }`);
    } else if (pType.kind === "primitive" && pType.type === "bigint") {
      const tag = (fn << 3) | 0;
      encodeLines.push(`  if (val[${jsonProp}] !== undefined) {`);
      encodeLines.push(`    o += writeVarint(buf, o, ${tag});`);
      encodeLines.push(`    o += writeVarint64(buf, o, val[${jsonProp}]);`);
      encodeLines.push(`  }`);

      decodeCases.push(`      case ${fn}: {`);
      decodeCases.push(`        let res; [res, o] = readVarint64(buf, o);`);
      decodeCases.push(`        obj[${jsonProp}] = res;`);
      decodeCases.push(`        break;`);
      decodeCases.push(`      }`);
    } else if (pType.kind === "primitive" && pType.type === "number") {
      const tag = (fn << 3) | 0;
      encodeLines.push(`  if (val[${jsonProp}] !== undefined) {`);
      encodeLines.push(`    o += writeVarint(buf, o, ${tag});`);
      encodeLines.push(`    o += writeVarint(buf, o, val[${jsonProp}]);`);
      encodeLines.push(`  }`);

      decodeCases.push(`      case ${fn}: {`);
      decodeCases.push(`        let res; [res, o] = readVarint(buf, o);`);
      decodeCases.push(`        obj[${jsonProp}] = res;`);
      decodeCases.push(`        break;`);
      decodeCases.push(`      }`);
    } else if (pType.kind === "enum") {
      const tag = (fn << 3) | 0;
      encodeLines.push(`  if (val[${jsonProp}] !== undefined) {`);
      encodeLines.push(`    o += writeVarint(buf, o, ${tag});`);
      encodeLines.push(`    o += writeVarint(buf, o, val[${jsonProp}]);`);
      encodeLines.push(`  }`);

      decodeCases.push(`      case ${fn}: {`);
      decodeCases.push(`        let res; [res, o] = readVarint(buf, o);`);
      decodeCases.push(`        obj[${jsonProp}] = res;`);
      decodeCases.push(`        break;`);
      decodeCases.push(`      }`);
    } else if (pType.kind === "array") {
      const elemType = pType.element;
      if (elemType.kind === "primitive" && elemType.type === "string") {
        const tag = (fn << 3) | 2;
        encodeLines.push(`  if (Array.isArray(val[${jsonProp}])) {`);
        encodeLines.push(`    for (const item of val[${jsonProp}]) {`);
        encodeLines.push(`      o += writeVarint(buf, o, ${tag});`);
        encodeLines.push(`      o += writeString(buf, o, String(item));`);
        encodeLines.push(`    }`);
        encodeLines.push(`  }`);

        decodeCases.push(`      case ${fn}: {`);
        decodeCases.push(`        let res; [res, o] = readString(buf, o);`);
        decodeCases.push(`        obj[${jsonProp}] = obj[${jsonProp}] || [];`);
        decodeCases.push(`        obj[${jsonProp}].push(res);`);
        decodeCases.push(`        break;`);
        decodeCases.push(`      }`);
      } else {
        const tag = (fn << 3) | 0;
        encodeLines.push(`  if (Array.isArray(val[${jsonProp}])) {`);
        encodeLines.push(`    for (const item of val[${jsonProp}]) {`);
        encodeLines.push(`      o += writeVarint(buf, o, ${tag});`);
        encodeLines.push(`      o += writeVarint(buf, o, item);`);
        encodeLines.push(`    }`);
        encodeLines.push(`  }`);

        decodeCases.push(`      case ${fn}: {`);
        decodeCases.push(`        let res; [res, o] = readVarint(buf, o);`);
        decodeCases.push(`        obj[${jsonProp}] = obj[${jsonProp}] || [];`);
        decodeCases.push(`        obj[${jsonProp}].push(res);`);
        decodeCases.push(`        break;`);
        decodeCases.push(`      }`);
      }
    } else {
      const tag = (fn << 3) | 2;
      encodeLines.push(`  if (val[${jsonProp}] !== undefined) {`);
      encodeLines.push(`    o += writeVarint(buf, o, ${tag});`);
      encodeLines.push(`    o += writeString(buf, o, JSON.stringify(val[${jsonProp}]));`);
      encodeLines.push(`  }`);

      decodeCases.push(`      case ${fn}: {`);
      decodeCases.push(`        let res; [res, o] = readString(buf, o);`);
      decodeCases.push(`        try { obj[${jsonProp}] = JSON.parse(res); } catch { obj[${jsonProp}] = res; }`);
      decodeCases.push(`        break;`);
      decodeCases.push(`      }`);
    }
  }

  return [
    `var textEncoder = typeof textEncoder !== "undefined" ? textEncoder : new TextEncoder();`,
    `var textDecoder = typeof textDecoder !== "undefined" ? textDecoder : new TextDecoder();`,
    `function writeVarint(buf, offset, val) {`,
    `  let o = offset;`,
    `  let v = Number(val);`,
    `  if (!Number.isFinite(v)) v = 0;`,
    `  // % rather than & 0x7f: bitwise operands are coerced to int32, which`,
    `  // silently truncates anything past 2^31.`,
    `  while (v >= 0x80) {`,
    `    buf[o++] = (v % 128) | 0x80;`,
    `    v = Math.floor(v / 128);`,
    `  }`,
    `  buf[o++] = v % 128;`,
    `  return o - offset;`,
    `}`,
    ``,
    `function readVarint(buf, offset) {`,
    `  let o = offset;`,
    `  let res = 0;`,
    `  let shift = 0;`,
    `  while (true) {`,
    `    const b = buf[o++];`,
    `    res += (b & 0x7f) * Math.pow(2, shift);`,
    `    if ((b & 0x80) === 0) break;`,
    `    shift += 7;`,
    `  }`,
    `  return [res, o];`,
    `}`,
    ``,
    `// 64-bit fields go through BigInt end to end. Number would round anything`,
    `// past 2^53, which is exactly the range int64 exists to carry.`,
    `function writeVarint64(buf, offset, val) {`,
    `  let o = offset;`,
    `  let v = typeof val === "bigint" ? val : BigInt(Math.trunc(Number(val) || 0));`,
    `  // Negative int64 travels as its two's complement, per protobuf.`,
    `  v = BigInt.asUintN(64, v);`,
    `  while (v >= 0x80n) {`,
    `    buf[o++] = Number((v & 0x7fn) | 0x80n);`,
    `    v >>= 7n;`,
    `  }`,
    `  buf[o++] = Number(v & 0x7fn);`,
    `  return o - offset;`,
    `}`,
    ``,
    `function readVarint64(buf, offset) {`,
    `  let o = offset;`,
    `  let res = 0n;`,
    `  let shift = 0n;`,
    `  while (true) {`,
    `    const b = buf[o++];`,
    `    res |= BigInt(b & 0x7f) << shift;`,
    `    if ((b & 0x80) === 0) break;`,
    `    shift += 7n;`,
    `  }`,
    `  return [BigInt.asIntN(64, res), o];`,
    `}`,
    ``,
    `function writeString(buf, offset, str) {`,
    `  const bytes = textEncoder.encode(str);`,
    `  let o = offset;`,
    `  o += writeVarint(buf, o, bytes.length);`,
    `  buf.set(bytes, o);`,
    `  return o + bytes.length - offset;`,
    `}`,
    ``,
    `function readString(buf, offset) {`,
    `  const [len, newOff] = readVarint(buf, offset);`,
    `  const str = textDecoder.decode(buf.subarray(newOff, newOff + len));`,
    `  return [str, newOff + len];`,
    `}`,
    ``,
    `export function encodeProto(val, buf, offset = 0) {`,
    `  let o = offset;`,
    encodeLines.join("\n"),
    `  return o - offset;`,
    `}`,
    ``,
    `export function decodeProto(buf, offset = 0) {`,
    `  let o = offset;`,
    `  const end = buf.length;`,
    `  const obj = {};`,
    `  while (o < end) {`,
    `    let tag; [tag, o] = readVarint(buf, o);`,
    `    if (tag === 0) break;`,
    `    const fieldNum = tag >> 3;`,
    `    const wireType = tag & 7;`,
    `    switch (fieldNum) {`,
    decodeCases.join("\n"),
    `      default: {`,
    `        if (wireType === 0) { let _; [_, o] = readVarint(buf, o); }`,
    `        else if (wireType === 2) { let len; [len, o] = readVarint(buf, o); o += len; }`,
    `        else if (wireType === 1) { o += 8; }`,
    `        else if (wireType === 5) { o += 4; }`,
    `        break;`,
    `      }`,
    `    }`,
    `  }`,
    `  return obj;`,
    `}`,
  ].join("\n");
}

function mapIRToProtoType(ir: TypeIR): string {
  switch (ir.kind) {
    case "primitive":
      switch (ir.type) {
        case "string":
        case "symbol":
          return "string";
        case "number":
          return "int32";
        case "bigint":
          return "int64";
        case "boolean":
          return "bool";
        default:
          return "string";
      }
    case "literal":
      if (typeof ir.value === "boolean") return "bool";
      if (typeof ir.value === "number" || typeof ir.value === "bigint") return "int32";
      return "string";
    case "enum":
      return ir.name ?? "int32";
    case "array":
      return `repeated ${mapIRToProtoType(ir.element)}`;
    case "object":
      return ir.name ?? "bytes";
    case "ref":
      return ir.name ?? ir.targetId;
    default:
      return "string";
  }
}

export function generateProtobufSchemaCode(
  types: Array<{ name: string; ir: TypeIR }>
): string {
  const allNamedTypes = new Map<string, TypeIR>();

  for (const { name, ir } of types) {
    if (!allNamedTypes.has(name)) {
      allNamedTypes.set(name, ir);
    }
    const transitives = collectNamedTypes(ir);
    for (const [transitiveName, transitiveIR] of transitives.entries()) {
      if (!allNamedTypes.has(transitiveName)) {
        allNamedTypes.set(transitiveName, transitiveIR);
      }
    }
  }

  // Validate that every property across all named types has a @fieldNumber
  for (const [typeName, typeIR] of allNamedTypes.entries()) {
    const props = flattenObjectProperties(typeIR);
    for (const prop of props) {
      if (prop.fieldNumber === undefined || Number.isNaN(prop.fieldNumber)) {
        const errMessage = `[wiz] Property '${prop.name}' on type '${typeName}' is missing required '@fieldNumber <N>' JSDoc tag for protobuf schema generation.`;
        return [
          `export function protobufSchema(options = {}) {`,
          `  throw new Error(${JSON.stringify(errMessage)});`,
          `}`,
        ].join("\n");
      }
    }
  }

  const typeDefs: Array<{
    name: string;
    isEnum: boolean;
    description?: string;
    entries: Array<{
      name: string;
      type: string;
      fieldNumber: number;
      comments: string[];
      options: string[];
    }>;
  }> = [];

  for (const [typeName, typeIR] of allNamedTypes.entries()) {
    if (typeIR.kind === "enum") {
      typeDefs.push({
        name: typeName,
        isEnum: true,
        description: typeIR.description,
        entries: typeIR.members.map((m, idx) => ({
          name: m.name,
          type: "",
          fieldNumber: typeof m.value === "number" ? m.value : idx,
          comments: [],
          options: [],
        })),
      });
    } else {
      const props = flattenObjectProperties(typeIR);
      const sortedProps = [...props].sort((a, b) => a.fieldNumber! - b.fieldNumber!);
      typeDefs.push({
        name: typeName,
        isEnum: false,
        description: typeIR.description,
        entries: sortedProps.map((p) => {
          const comments: string[] = [];
          if (p.description) {
            comments.push(p.description);
          }
          if (p.constraints) {
            for (const c of p.constraints) {
              comments.push(`@${c.kind} ${c.value}`);
            }
          }
          const options: string[] = [];
          if (p.deprecated?.isDeprecated) {
            options.push("deprecated = true");
          }
          return {
            name: p.name,
            type: mapIRToProtoType(p.type),
            fieldNumber: p.fieldNumber!,
            comments,
            options,
          };
        }),
      });
    }
  }

  return [
    `export function protobufSchema(options = {}) {`,
    `  const indent = options.indent ?? "  ";`,
    `  const typeDefs = ${JSON.stringify(typeDefs, null, 2)};`,
    `  const lines = ['syntax = "proto3";', ''];`,
    `  for (const def of typeDefs) {`,
    `    if (def.description) {`,
    `      for (const line of def.description.split("\\n")) {`,
    `        if (line.trim()) lines.push('// ' + line.trim());`,
    `      }`,
    `    }`,
    `    if (def.isEnum) {`,
    `      lines.push('enum ' + def.name + ' {');`,
    `      for (const entry of def.entries) {`,
    `        if (entry.comments && entry.comments.length > 0) {`,
    `          for (const c of entry.comments) {`,
    `            lines.push(indent + '// ' + c);`,
    `          }`,
    `        }`,
    `        const optStr = entry.options && entry.options.length > 0 ? ' [' + entry.options.join(', ') + ']' : '';`,
    `        lines.push(indent + entry.name + ' = ' + entry.fieldNumber + optStr + ';');`,
    `      }`,
    `      lines.push('}');`,
    `    } else {`,
    `      lines.push('message ' + def.name + ' {');`,
    `      for (const entry of def.entries) {`,
    `        if (entry.comments && entry.comments.length > 0) {`,
    `          for (const c of entry.comments) {`,
    `            lines.push(indent + '// ' + c);`,
    `          }`,
    `        }`,
    `        const optStr = entry.options && entry.options.length > 0 ? ' [' + entry.options.join(', ') + ']' : '';`,
    `        lines.push(indent + entry.type + ' ' + entry.name + ' = ' + entry.fieldNumber + optStr + ';');`,
    `      }`,
    `      lines.push('}');`,
    `    }`,
    `    lines.push('');`,
    `  }`,
    `  return lines.join('\\n').trim();`,
    `}`,
  ].join("\n");
}
