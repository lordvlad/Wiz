import {
  declaredFormat,
  flattenObjectProperties,
  type Annotated,
  type TypeIR,
} from "../types.ts";

/**
 * Avro's primitive type names. `int` is 32-bit and `long` is 64-bit; both are
 * zig-zag varints on the wire, while `float`/`double` are fixed-width IEEE 754.
 */
export type AvroPrimitive =
  | "null"
  | "boolean"
  | "int"
  | "long"
  | "float"
  | "double"
  | "bytes"
  | "string";

/**
 * Numeric width comes from `@format`, reusing the OpenAPI Format Registry
 * values rather than a format-specific tag. One annotation drives the JSON
 * Schema output, the OpenAPI output and the binary width chosen here.
 *
 * Avro has no unsigned types, so the unsigned widths widen to the next signed
 * type that can hold their full range.
 */
const FORMAT_TO_AVRO: Record<string, AvroPrimitive> = {
  int32: "int",
  int64: "long",
  uint32: "long",
  uint64: "long",
  sint32: "int",
  sint64: "long",
  fixed32: "int",
  sfixed32: "int",
  fixed64: "long",
  sfixed64: "long",
  float: "float",
  double: "double",
  byte: "bytes",
  binary: "bytes",
};

/**
 * Avro annotates a primitive with a logical type rather than adding a new one,
 * so a uuid is still a string and a timestamp is still a long.
 */
const FORMAT_TO_LOGICAL: Record<string, { type: AvroPrimitive; logicalType: string }> = {
  uuid: { type: "string", logicalType: "uuid" },
  date: { type: "int", logicalType: "date" },
  time: { type: "int", logicalType: "time-millis" },
  "date-time": { type: "long", logicalType: "timestamp-millis" },
};

/** `T | undefined` is how an optional property reaches us; Avro spells it `["null", T]`. */
function unwrapNullable(ir: TypeIR): { nullable: boolean; inner: TypeIR } {
  if (ir.kind !== "union") return { nullable: false, inner: ir };
  const isAbsent = (t: TypeIR) =>
    t.kind === "primitive" &&
    (t.type === "null" || t.type === "undefined" || t.type === "void");
  const present = ir.types.filter((t) => !isAbsent(t));
  if (present.length === 1 && present.length < ir.types.length) {
    return { nullable: true, inner: present[0]! };
  }
  return { nullable: false, inner: ir };
}

/** A logical type when `@format` names one, otherwise undefined. */
function avroLogicalFor(
  ir: TypeIR,
  carrier?: Annotated
): { type: AvroPrimitive; logicalType: string } | undefined {
  if (ir.kind === "primitive" && ir.type === "date") {
    return { type: "long", logicalType: "timestamp-millis" };
  }
  if (ir.kind !== "primitive" || ir.type !== "string") return undefined;
  const format = declaredFormat(carrier, ir);
  return format ? FORMAT_TO_LOGICAL[format] : undefined;
}

function avroPrimitiveFor(
  ir: TypeIR,
  carrier?: Annotated
): AvroPrimitive | undefined {
  if (ir.kind !== "primitive") return undefined;
  const format = declaredFormat(carrier, ir);
  const declared = format ? FORMAT_TO_AVRO[format] : undefined;
  switch (ir.type) {
    case "string":
    case "symbol":
      // `@format byte`/`binary` means the string is really opaque bytes.
      return declared === "bytes" ? "bytes" : "string";
    case "boolean":
      return "boolean";
    case "bytes":
      return "bytes";
    case "date":
      return "long";
    case "bigint":
      // A JS bigint is 64-bit by definition; `@format int32` may still narrow it.
      return declared ?? "long";
    case "number":
      // A JS number *is* a double, so that is the honest default. `@format`
      // narrows it when the field is really an int32/int64/float.
      return declared ?? "double";
    case "null":
    case "undefined":
    case "void":
      return "null";
    default:
      return undefined;
  }
}

interface Ctx {
  /** Module-level constants hoisted out of the hot path (enum symbol tables). */
  prelude: string[];
  next: () => number;
  /** Record names already defined, so Avro's "define once, reference by name" holds. */
  defined: Set<string>;
}

function newCtx(): Ctx {
  let counter = 0;
  return { prelude: [], next: () => counter++, defined: new Set() };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

function irToAvroSchema(
  ir: TypeIR,
  ctx: Ctx,
  carrier?: Annotated,
  fallbackName?: string
): unknown {
  const { nullable, inner } = unwrapNullable(ir);
  if (nullable) {
    return ["null", irToAvroSchema(inner, ctx, carrier, fallbackName)];
  }

  const logical = avroLogicalFor(inner, carrier);
  if (logical) return logical;

  const primitive = avroPrimitiveFor(inner, carrier);
  if (primitive) return primitive;

  switch (inner.kind) {
    case "literal":
      if (typeof inner.value === "string") return "string";
      if (typeof inner.value === "boolean") return "boolean";
      if (typeof inner.value === "bigint") return "long";
      return "double";

    case "enum": {
      const name = inner.name ?? fallbackName ?? `Enum${ctx.next()}`;
      if (ctx.defined.has(name)) return name;
      ctx.defined.add(name);
      return {
        type: "enum",
        name,
        symbols: inner.members.map((m) => m.name),
      };
    }

    case "array":
      return {
        type: "array",
        items: irToAvroSchema(inner.element, ctx, undefined, fallbackName),
      };

    case "record":
      return {
        type: "map",
        values: irToAvroSchema(inner.valueType, ctx, undefined, fallbackName),
      };

    case "object":
    case "intersection": {
      const name = inner.name ?? fallbackName ?? `Record${ctx.next()}`;
      if (ctx.defined.has(name)) return name;
      ctx.defined.add(name);
      return {
        type: "record",
        name,
        ...(inner.description ? { doc: inner.description } : {}),
        fields: flattenObjectProperties(inner).map((p) => {
          const { nullable: propNullable } = unwrapNullable(p.type);
          const optional = p.optional || propNullable;
          return {
            name: p.name,
            type: optional
              ? ["null", irToAvroSchema(unwrapNullable(p.type).inner, ctx, p, p.name)]
              : irToAvroSchema(p.type, ctx, p, p.name),
            ...(p.description ? { doc: p.description } : {}),
            ...(optional ? { default: null } : {}),
          };
        }),
      };
    }

    case "union":
      return inner.types.map((t) => irToAvroSchema(t, ctx, undefined, fallbackName));

    default:
      return "string";
  }
}

export function generateAvroSchemaCode(
  types: Array<{ name: string; ir: TypeIR }>
): string {
  const ctx = newCtx();
  const schemas = types.map(({ name, ir }) => irToAvroSchema(ir, ctx, undefined, name));
  // A .avsc file holds one schema; several roots form a union.
  const root = schemas.length === 1 ? schemas[0] : schemas;

  return [
    `export function avroSchema(options = {}) {`,
    `  const indent = options.indent ?? "  ";`,
    `  return JSON.stringify(${JSON.stringify(root)}, null, indent);`,
    `}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Binary codec
// ---------------------------------------------------------------------------

function emitEncode(
  ir: TypeIR,
  expr: string,
  ctx: Ctx,
  carrier?: Annotated
): string[] {
  const { nullable, inner } = unwrapNullable(ir);
  if (nullable) {
    return [
      `if (${expr} === undefined || ${expr} === null) {`,
      `  o += writeIndex(buf, o, 0);`,
      `} else {`,
      `  o += writeIndex(buf, o, 1);`,
      ...emitEncode(inner, expr, ctx, carrier).map((l) => `  ${l}`),
      `}`,
    ];
  }

  // A Date is carried by its logical type's underlying long.
  if (inner.kind === "primitive" && inner.type === "date") {
    return [`o += writeLong(buf, o, BigInt(${expr}.getTime()));`];
  }

  const primitive = avroPrimitiveFor(inner, carrier);
  if (primitive) {
    switch (primitive) {
      case "null":
        return [];
      case "boolean":
        return [`buf[o++] = ${expr} ? 1 : 0;`];
      case "int":
      case "long":
        return [`o += writeLong(buf, o, ${expr});`];
      case "float":
        return [`view.setFloat32(o, Number(${expr}), true); o += 4;`];
      case "double":
        return [`view.setFloat64(o, Number(${expr}), true); o += 8;`];
      case "string":
        return [`o += writeString(buf, o, String(${expr}));`];
      case "bytes":
        return [`o += writeBytes(buf, o, ${expr});`];
    }
  }

  switch (inner.kind) {
    case "literal":
      if (typeof inner.value === "string") {
        return [`o += writeString(buf, o, String(${expr}));`];
      }
      if (typeof inner.value === "boolean") {
        return [`buf[o++] = ${expr} ? 1 : 0;`];
      }
      if (typeof inner.value === "bigint") {
        return [`o += writeLong(buf, o, ${expr});`];
      }
      return [`view.setFloat64(o, Number(${expr}), true); o += 8;`];

    case "enum": {
      const table = `__avroEnum${ctx.next()}`;
      ctx.prelude.push(
        `const ${table} = ${JSON.stringify(inner.members.map((m) => m.value))};`
      );
      return [`o += writeIndex(buf, o, ${table}.indexOf(${expr}));`];
    }

    case "array": {
      const item = `item${ctx.next()}`;
      return [
        `if (Array.isArray(${expr}) && ${expr}.length > 0) {`,
        `  o += writeIndex(buf, o, ${expr}.length);`,
        `  for (const ${item} of ${expr}) {`,
        ...emitEncode(inner.element, item, ctx).map((l) => `    ${l}`),
        `  }`,
        `}`,
        `o += writeIndex(buf, o, 0);`,
      ];
    }

    case "record": {
      const key = `key${ctx.next()}`;
      const value = `value${ctx.next()}`;
      return [
        `{`,
        `  const entries = Object.entries(${expr} ?? {});`,
        `  if (entries.length > 0) {`,
        `    o += writeIndex(buf, o, entries.length);`,
        `    for (const [${key}, ${value}] of entries) {`,
        `      o += writeString(buf, o, ${key});`,
        ...emitEncode(inner.valueType, value, ctx).map((l) => `      ${l}`),
        `    }`,
        `  }`,
        `  o += writeIndex(buf, o, 0);`,
        `}`,
      ];
    }

    case "object":
    case "intersection": {
      const lines: string[] = [];
      for (const property of flattenObjectProperties(inner)) {
        const access = `${expr}[${JSON.stringify(property.name)}]`;
        const target = property.optional
          ? { kind: "union" as const, id: "", types: [
              { kind: "primitive" as const, id: "", type: "undefined" as const },
              unwrapNullable(property.type).inner,
            ] }
          : property.type;
        lines.push(...emitEncode(target, access, ctx, property));
      }
      return lines;
    }

    default:
      // Anything unmodelled travels as its JSON text rather than being dropped.
      return [`o += writeString(buf, o, JSON.stringify(${expr}));`];
  }
}

function emitDecode(
  ir: TypeIR,
  target: string,
  ctx: Ctx,
  carrier?: Annotated
): string[] {
  const { nullable, inner } = unwrapNullable(ir);
  if (nullable) {
    const branch = `branch${ctx.next()}`;
    return [
      `let ${branch}; [${branch}, o] = readIndex(buf, o);`,
      `if (${branch} === 0) {`,
      `  ${target} = null;`,
      `} else {`,
      ...emitDecode(inner, target, ctx, carrier).map((l) => `  ${l}`),
      `}`,
    ];
  }

  if (inner.kind === "primitive" && inner.type === "date") {
    const tmp = `ms${ctx.next()}`;
    return [
      `let ${tmp}; [${tmp}, o] = readLong(buf, o);`,
      `${target} = new Date(Number(${tmp}));`,
    ];
  }

  const primitive = avroPrimitiveFor(inner, carrier);
  if (primitive) {
    switch (primitive) {
      case "null":
        return [`${target} = null;`];
      case "boolean":
        return [`${target} = buf[o++] !== 0;`];
      case "int":
      case "long": {
        const tmp = `n${ctx.next()}`;
        // The wire is always 64-bit; the JS type decides what comes back.
        const asNumber = !(inner.kind === "primitive" && inner.type === "bigint");
        return [
          `let ${tmp}; [${tmp}, o] = readLong(buf, o);`,
          `${target} = ${asNumber ? `Number(${tmp})` : tmp};`,
        ];
      }
      case "float":
        return [`${target} = view.getFloat32(o, true); o += 4;`];
      case "double":
        return [`${target} = view.getFloat64(o, true); o += 8;`];
      case "string":
        return [`[${target}, o] = readString(buf, o);`];
      case "bytes":
        return [`[${target}, o] = readBytes(buf, o);`];
    }
  }

  switch (inner.kind) {
    case "literal":
      if (typeof inner.value === "string") return [`[${target}, o] = readString(buf, o);`];
      if (typeof inner.value === "boolean") return [`${target} = buf[o++] !== 0;`];
      if (typeof inner.value === "bigint") {
        const tmp = `n${ctx.next()}`;
        return [`let ${tmp}; [${tmp}, o] = readLong(buf, o);`, `${target} = ${tmp};`];
      }
      return [`${target} = view.getFloat64(o, true); o += 8;`];

    case "enum": {
      const table = `__avroEnum${ctx.next()}`;
      ctx.prelude.push(
        `const ${table} = ${JSON.stringify(inner.members.map((m) => m.value))};`
      );
      const idx = `idx${ctx.next()}`;
      return [
        `let ${idx}; [${idx}, o] = readIndex(buf, o);`,
        `${target} = ${table}[${idx}];`,
      ];
    }

    case "array": {
      const arr = `arr${ctx.next()}`;
      const count = `count${ctx.next()}`;
      const size = `size${ctx.next()}`;
      const i = `i${ctx.next()}`;
      const item = `item${ctx.next()}`;
      return [
        `const ${arr} = [];`,
        `while (true) {`,
        `  let ${count}; [${count}, o] = readIndex(buf, o);`,
        `  if (${count} === 0) break;`,
        `  if (${count} < 0) { ${count} = -${count}; let ${size}; [${size}, o] = readIndex(buf, o); }`,
        `  for (let ${i} = 0; ${i} < ${count}; ${i}++) {`,
        `    let ${item};`,
        ...emitDecode(inner.element, item, ctx).map((l) => `    ${l}`),
        `    ${arr}.push(${item});`,
        `  }`,
        `}`,
        `${target} = ${arr};`,
      ];
    }

    case "record": {
      const map = `map${ctx.next()}`;
      const count = `count${ctx.next()}`;
      const size = `size${ctx.next()}`;
      const i = `i${ctx.next()}`;
      const key = `key${ctx.next()}`;
      const value = `value${ctx.next()}`;
      return [
        `const ${map} = {};`,
        `while (true) {`,
        `  let ${count}; [${count}, o] = readIndex(buf, o);`,
        `  if (${count} === 0) break;`,
        `  if (${count} < 0) { ${count} = -${count}; let ${size}; [${size}, o] = readIndex(buf, o); }`,
        `  for (let ${i} = 0; ${i} < ${count}; ${i}++) {`,
        `    let ${key}; [${key}, o] = readString(buf, o);`,
        `    let ${value};`,
        ...emitDecode(inner.valueType, value, ctx).map((l) => `    ${l}`),
        `    ${map}[${key}] = ${value};`,
        `  }`,
        `}`,
        `${target} = ${map};`,
      ];
    }

    case "object":
    case "intersection": {
      const obj = `obj${ctx.next()}`;
      const lines: string[] = [`const ${obj} = {};`];
      for (const property of flattenObjectProperties(inner)) {
        const slot = `${obj}[${JSON.stringify(property.name)}]`;
        const source = property.optional
          ? { kind: "union" as const, id: "", types: [
              { kind: "primitive" as const, id: "", type: "undefined" as const },
              unwrapNullable(property.type).inner,
            ] }
          : property.type;
        lines.push(...emitDecode(source, slot, ctx, property));
      }
      lines.push(`${target} = ${obj};`);
      return lines;
    }

    default: {
      const raw = `raw${ctx.next()}`;
      return [
        `let ${raw}; [${raw}, o] = readString(buf, o);`,
        `try { ${target} = JSON.parse(${raw}); } catch { ${target} = ${raw}; }`,
      ];
    }
  }
}

export function generateAvroCode(ir: TypeIR): string {
  const ctx = newCtx();
  const encodeBody = emitEncode(ir, "val", ctx);
  const decodeBody = emitDecode(ir, "out", ctx);

  return [
    `var textEncoder = typeof textEncoder !== "undefined" ? textEncoder : new TextEncoder();`,
    `var textDecoder = typeof textDecoder !== "undefined" ? textDecoder : new TextDecoder();`,
    ...ctx.prelude,
    ``,
    `// Avro longs are zig-zag varints. Everything goes through BigInt because`,
    `// a long is 64-bit and Number would round past 2^53.`,
    `function writeLong(buf, offset, value) {`,
    `  let o = offset;`,
    `  let v = typeof value === "bigint" ? value : BigInt(Math.trunc(Number(value) || 0));`,
    `  v = BigInt.asUintN(64, (v << 1n) ^ (v >> 63n));`,
    `  while (v >= 0x80n) {`,
    `    buf[o++] = Number((v & 0x7fn) | 0x80n);`,
    `    v >>= 7n;`,
    `  }`,
    `  buf[o++] = Number(v & 0x7fn);`,
    `  return o - offset;`,
    `}`,
    ``,
    `function readLong(buf, offset) {`,
    `  let o = offset;`,
    `  let res = 0n;`,
    `  let shift = 0n;`,
    `  while (true) {`,
    `    const b = buf[o++];`,
    `    res |= BigInt(b & 0x7f) << shift;`,
    `    if ((b & 0x80) === 0) break;`,
    `    shift += 7n;`,
    `  }`,
    `  return [(res >> 1n) ^ -(res & 1n), o];`,
    `}`,
    ``,
    `// Counts, union branches and enum indexes are small non-negative longs,`,
    `// where zig-zag is just a doubling, so they skip BigInt entirely.`,
    `function writeIndex(buf, offset, n) {`,
    `  let o = offset;`,
    `  let v = n < 0 ? (-n * 2) - 1 : n * 2;`,
    `  while (v >= 0x80) {`,
    `    buf[o++] = (v % 128) | 0x80;`,
    `    v = Math.floor(v / 128);`,
    `  }`,
    `  buf[o++] = v % 128;`,
    `  return o - offset;`,
    `}`,
    ``,
    `function readIndex(buf, offset) {`,
    `  const [value, next] = readLong(buf, offset);`,
    `  return [Number(value), next];`,
    `}`,
    ``,
    `function writeString(buf, offset, str) {`,
    `  const bytes = textEncoder.encode(str);`,
    `  let o = offset;`,
    `  o += writeIndex(buf, o, bytes.length);`,
    `  buf.set(bytes, o);`,
    `  return o + bytes.length - offset;`,
    `}`,
    ``,
    `function readString(buf, offset) {`,
    `  const [len, start] = readIndex(buf, offset);`,
    `  return [textDecoder.decode(buf.subarray(start, start + len)), start + len];`,
    `}`,
    ``,
    `function writeBytes(buf, offset, value) {`,
    `  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value ?? []);`,
    `  let o = offset;`,
    `  o += writeIndex(buf, o, bytes.length);`,
    `  buf.set(bytes, o);`,
    `  return o + bytes.length - offset;`,
    `}`,
    ``,
    `function readBytes(buf, offset) {`,
    `  const [len, start] = readIndex(buf, offset);`,
    `  return [buf.slice(start, start + len), start + len];`,
    `}`,
    ``,
    `export function encodeAvro(val, buf, offset = 0) {`,
    `  let o = offset;`,
    `  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);`,
    ...encodeBody.map((l) => `  ${l}`),
    `  return o - offset;`,
    `}`,
    ``,
    `export function decodeAvro(buf, offset = 0) {`,
    `  let o = offset;`,
    `  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);`,
    `  let out;`,
    ...decodeBody.map((l) => `  ${l}`),
    `  return out;`,
    `}`,
  ].join("\n");
}
