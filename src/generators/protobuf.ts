import {
  collectNamedTypes,
  declaredFormat,
  flattenObjectProperties,
  type Annotated,
  type PropertyIR,
  type TypeIR,
  type UnionTypeIR,
} from "../types.ts";
import { generateTypeCheckExpression } from "./validator.ts";

/**
 * How a numeric field travels. protobuf has three encodings, and picking the
 * wrong one corrupts data silently: writing 3.14 as a varint truncates it to 3,
 * because the bytes land in a Uint8Array.
 *
 * `wire` is the protobuf wire type: 0 varint, 1 fixed 64-bit, 5 fixed 32-bit.
 */
interface ProtoNumeric {
  proto: string;
  wire: 0 | 1 | 5;
  write: (target: string) => string;
  read: string;
}

const PROTO_NUMERICS: Record<string, ProtoNumeric> = {
  int32: {
    proto: "int32",
    wire: 0,
    write: (t) => `o += writeVarint(buf, o, ${t});`,
    read: `let res; [res, o] = readVarint(buf, o);`,
  },
  int64: {
    proto: "int64",
    wire: 0,
    write: (t) => `o += writeVarint64(buf, o, ${t});`,
    read: `let res; [res, o] = readVarint64(buf, o);`,
  },
  uint32: {
    proto: "uint32",
    wire: 0,
    write: (t) => `o += writeVarint(buf, o, ${t});`,
    read: `let res; [res, o] = readVarint(buf, o);`,
  },
  uint64: {
    proto: "uint64",
    wire: 0,
    write: (t) => `o += writeVarint64(buf, o, ${t});`,
    read: `let res; [res, o] = readVarint64(buf, o);`,
  },
  // sint uses zig-zag, which is what makes small negatives cheap.
  sint32: {
    proto: "sint32",
    wire: 0,
    write: (t) => `o += writeZigZag(buf, o, ${t});`,
    read: `let res; [res, o] = readZigZag(buf, o);`,
  },
  sint64: {
    proto: "sint64",
    wire: 0,
    write: (t) => `o += writeZigZag(buf, o, ${t});`,
    read: `let res; [res, o] = readZigZag(buf, o);`,
  },
  fixed32: {
    proto: "fixed32",
    wire: 5,
    write: (t) => `view.setUint32(o, Number(${t}), true); o += 4;`,
    read: `const res = view.getUint32(o, true); o += 4;`,
  },
  sfixed32: {
    proto: "sfixed32",
    wire: 5,
    write: (t) => `view.setInt32(o, Number(${t}), true); o += 4;`,
    read: `const res = view.getInt32(o, true); o += 4;`,
  },
  fixed64: {
    proto: "fixed64",
    wire: 1,
    write: (t) => `view.setBigUint64(o, BigInt(${t}), true); o += 8;`,
    read: `const res = view.getBigUint64(o, true); o += 8;`,
  },
  sfixed64: {
    proto: "sfixed64",
    wire: 1,
    write: (t) => `view.setBigInt64(o, BigInt(${t}), true); o += 8;`,
    read: `const res = view.getBigInt64(o, true); o += 8;`,
  },
  float: {
    proto: "float",
    wire: 5,
    write: (t) => `view.setFloat32(o, Number(${t}), true); o += 4;`,
    read: `const res = view.getFloat32(o, true); o += 4;`,
  },
  double: {
    proto: "double",
    wire: 1,
    write: (t) => `view.setFloat64(o, Number(${t}), true); o += 8;`,
    read: `const res = view.getFloat64(o, true); o += 8;`,
  },
};

/** Widths that must round-trip as BigInt rather than Number. */
const BIGINT_FORMATS = new Set(["int64", "uint64", "fixed64", "sfixed64", "sint64"]);

/**
 * A JS number is a double, so that is the default. `@format` narrows it, using
 * the same OpenAPI registry values the avro codec reads. A bigint is 64-bit by
 * definition and defaults to int64.
 */
function protoNumericFor(
  ir: TypeIR,
  carrier?: Annotated
): ProtoNumeric | undefined {
  if (ir.kind !== "primitive") return undefined;
  const format = declaredFormat(carrier, ir);
  const declared = format ? PROTO_NUMERICS[format] : undefined;
  if (ir.type === "bigint") return declared ?? PROTO_NUMERICS.int64!;
  if (ir.type === "number") return declared ?? PROTO_NUMERICS.double!;
  if (ir.type === "date") return PROTO_NUMERICS.int64!;
  return undefined;
}

/** Does this field's JS value come back as a BigInt? */
function readsAsBigInt(ir: TypeIR, carrier?: Annotated): boolean {
  if (ir.kind !== "primitive") return false;
  if (ir.type === "bigint") {
    const format = declaredFormat(carrier, ir);
    return !format || BIGINT_FORMATS.has(format);
  }
  const format = declaredFormat(carrier, ir);
  return Boolean(format && BIGINT_FORMATS.has(format) && format !== "int64");
}

/** An object type that becomes its own protobuf message. */
interface MessagePlan {
  id: number;
  ir: TypeIR;
  name: string;
}

/** Root first, then every nested object reachable through its fields. */
function planMessages(root: TypeIR): MessagePlan[] {
  const plans: MessagePlan[] = [];
  const seen = new Map<TypeIR, number>();

  const visit = (ir: TypeIR, name: string): number => {
    const existing = seen.get(ir);
    if (existing !== undefined) return existing;

    const id = plans.length;
    seen.set(ir, id);
    plans.push({ id, ir, name });

    for (const property of flattenObjectProperties(ir)) {
      const oneof = oneofFor(property.type);
      const reachable = oneof ? oneof.types : [property.type];
      for (const candidate of reachable) {
        const target = messageTarget(candidate);
        if (target) visit(target, target.name ?? `${name}_${property.name}`);
      }
    }
    return id;
  };

  visit(root, root.name ?? "Target");
  return plans;
}

/** The object a field embeds, if it embeds one (directly or per array item). */
function messageTarget(ir: TypeIR): TypeIR | undefined {
  // An optional message still embeds; absence is field omission.
  const unwrapped = unwrapNullable(ir);
  const candidate = unwrapped.kind === "array" ? unwrapped.element : unwrapped;
  if (candidate.kind === "object" || candidate.kind === "intersection") {
    return flattenObjectProperties(candidate).length > 0 ? candidate : undefined;
  }
  return undefined;
}

/** Wraps `body` so it is written length-delimited, as wire type 2 requires. */
function lengthDelimited(body: string[], indent: string): string[] {
  return [
    `${indent}{`,
    `${indent}  const lenPos = o;`,
    `${indent}  o += 1;`,
    `${indent}  const start = o;`,
    ...body.map((l) => `${indent}  ${l}`),
    `${indent}  const len = o - start;`,
    `${indent}  const size = varintSize(len);`,
    `${indent}  if (size !== 1) {`,
    `${indent}    buf.copyWithin(start + size - 1, start, o);`,
    `${indent}    o += size - 1;`,
    `${indent}  }`,
    `${indent}  writeVarint(buf, lenPos, len);`,
    `${indent}}`,
  ];
}

interface ScalarCodec {
  wire: 0 | 1 | 2 | 5;
  write: (expr: string) => string;
  /** Leaves the value in `res`. */
  read: string;
  lift: (expr: string) => string;
}

/** How a non-message value travels, or undefined if it needs a sub-message. */
function scalarCodecFor(
  ir: TypeIR,
  carrier?: Annotated
): ScalarCodec | undefined {
  // A literal travels as its primitive: `kind: "circle"` is a string, not JSON.
  if (ir.kind === "literal") {
    const type = typeof ir.value === "bigint" ? "bigint" : typeof ir.value;
    if (type === "string" || type === "number" || type === "boolean" || type === "bigint") {
      return scalarCodecFor({ id: `${ir.id}_prim`, kind: "primitive", type }, carrier);
    }
  }

  if (ir.kind === "primitive") {
    if (ir.type === "string" || ir.type === "symbol") {
      return {
        wire: 2,
        write: (e) => `o += writeString(buf, o, String(${e}));`,
        read: `let res; [res, o] = readString(buf, o);`,
        lift: (e) => e,
      };
    }
    if (ir.type === "bytes") {
      return {
        wire: 2,
        write: (e) => `o += writeBytes(buf, o, ${e});`,
        read: `let res; [res, o] = readBytes(buf, o);`,
        lift: (e) => e,
      };
    }
    if (ir.type === "boolean") {
      return {
        wire: 0,
        write: (e) => `o += writeVarint(buf, o, ${e} ? 1 : 0);`,
        read: `let res; [res, o] = readVarint(buf, o);`,
        lift: (e) => `Boolean(${e})`,
      };
    }
    if (ir.type === "date") {
      return {
        wire: 0,
        write: (e) => `o += writeVarint64(buf, o, BigInt(${e}.getTime()));`,
        read: `let res; [res, o] = readVarint64(buf, o);`,
        lift: (e) => `new Date(Number(${e}))`,
      };
    }
  }

  if (ir.kind === "enum") {
    return {
      wire: 0,
      write: (e) => `o += writeVarint(buf, o, ${e});`,
      read: `let res; [res, o] = readVarint(buf, o);`,
      lift: (e) => e,
    };
  }

  const numeric = protoNumericFor(ir, carrier);
  if (numeric) {
    const asBigInt = readsAsBigInt(ir, carrier);
    return {
      wire: numeric.wire,
      write: numeric.write,
      read: numeric.read,
      lift: (e) => (asBigInt ? `BigInt(${e})` : `Number(${e})`),
    };
  }

  return undefined;
}

/** JSON text is the last resort for shapes protobuf cannot express. */
const JSON_FALLBACK: ScalarCodec = {
  wire: 2,
  write: (e) => `o += writeString(buf, o, JSON.stringify(${e}));`,
  read: `let res; [res, o] = readString(buf, o);\n        try { res = JSON.parse(res); } catch {}`,
  lift: (e) => e,
};

/**
 * Strips `undefined`, `null` and `void` from a union.
 *
 * Protobuf spells absence by omitting the field, so an optional `T` travels
 * exactly as a `T` does. Without this an optional field looks like a union and
 * falls through to the JSON fallback, silently encoding text.
 */
function unwrapNullable(ir: TypeIR): TypeIR {
  if (ir.kind !== "union") return ir;
  const meaningful = ir.types.filter(
    (t) =>
      !(
        t.kind === "primitive" &&
        (t.type === "undefined" || t.type === "null" || t.type === "void")
      )
  );
  return meaningful.length === 1 ? meaningful[0]! : { ...ir, types: meaningful };
}

/**
 * A union of same-typed literals is not a union on the wire, just its
 * primitive: `"a" | "b"` is a string. Returns that primitive, if it applies.
 */
function collapseLiteralUnion(ir: UnionTypeIR): TypeIR | undefined {
  const types = new Set<string>();
  for (const member of ir.types) {
    if (member.kind !== "literal") return undefined;
    types.add(typeof member.value === "bigint" ? "bigint" : typeof member.value);
  }
  if (types.size !== 1) return undefined;
  const only = [...types][0];
  // `boolean` reaches us as `true | false`, which is one wire type, not two.
  if (only !== "string" && only !== "number" && only !== "bigint" && only !== "boolean") {
    return undefined;
  }
  return { id: `${ir.id}_collapsed`, kind: "primitive", type: only };
}

/**
 * The type a field actually travels as: optionality stripped and a same-typed
 * literal union reduced. Shared so the schema cannot describe one shape while
 * the codec writes another.
 */
function wireFieldType(ir: TypeIR): TypeIR {
  const unwrapped = unwrapNullable(ir);
  if (unwrapped.kind !== "union") return unwrapped;
  return collapseLiteralUnion(unwrapped) ?? unwrapped;
}

/** The variants of a field encoded as a `oneof`, if it is one. */
function oneofFor(ir: TypeIR): UnionTypeIR | undefined {
  const inner = unwrapNullable(ir);
  if (inner.kind !== "union") return undefined;
  return collapseLiteralUnion(inner) ? undefined : inner;
}

/** The required property names of an object variant, as a stable signature. */
function requiredSignature(ir: TypeIR): string[] {
  return flattenObjectProperties(ir)
    .filter((p) => !p.optional)
    .map((p) => p.name)
    .sort();
}

/** A JS literal for a value that may be a bigint, which JSON cannot spell. */
function literalExpression(value: unknown): string {
  return typeof value === "bigint" ? `${value}n` : JSON.stringify(value);
}

/**
 * A test that tells one `oneof` variant from its siblings.
 *
 * The validator's object check is deliberately shallow — it asks only whether
 * the value is an object — so it cannot separate two record variants. The
 * discriminant property decides where the union has one, and the required
 * property names decide otherwise.
 */
function variantCheck(variant: TypeIR, union: UnionTypeIR, local: string): string {
  const target = unwrapNullable(variant);
  if (target.kind !== "object" && target.kind !== "intersection") {
    return generateTypeCheckExpression(target, local);
  }

  const tests = [`${local} !== null`, `typeof ${local} === "object"`];
  const properties = flattenObjectProperties(target);

  const discriminant = union.discriminator?.propertyName;
  const tag = discriminant
    ? properties.find((p) => p.name === discriminant)
    : undefined;
  if (tag?.type.kind === "literal") {
    tests.push(
      `${local}[${JSON.stringify(discriminant)}] === ${literalExpression(tag.type.value)}`
    );
    return tests.join(" && ");
  }

  for (const name of requiredSignature(target)) {
    tests.push(`${JSON.stringify(name)} in ${local}`);
  }
  return tests.join(" && ");
}

/**
 * The one reason this type cannot be encoded, or undefined.
 *
 * Reported up front rather than per field, so the generated module fails with
 * a single actionable message instead of encoding something unreadable.
 */
function protobufBlocker(plans: MessagePlan[]): string | undefined {
  for (const plan of plans) {
    const props = flattenObjectProperties(plan.ir);
    if (props.length === 0) {
      return `[wiz] Type '${plan.name}' has no properties for protobuf encoding/decoding.`;
    }

    // oneof members share the enclosing message's field-number space.
    const claimed = new Map<number, string>();
    const claim = (n: number, by: string): string | undefined => {
      const owner = claimed.get(n);
      if (owner !== undefined) {
        return `[wiz] Field number ${n} on type '${plan.name}' is claimed by both '${owner}' and '${by}'. A 'oneof' shares the enclosing message's field numbers, so every variant needs its own.`;
      }
      claimed.set(n, by);
      return undefined;
    };

    for (const p of props) {
      const oneof = oneofFor(p.type);

      if (!oneof) {
        if (p.fieldNumber === undefined || Number.isNaN(p.fieldNumber)) {
          return `[wiz] Property '${p.name}' on type '${plan.name}' is missing required '@fieldNumber <N>' JSDoc tag for protobuf encoding/decoding.`;
        }
        const clash = claim(p.fieldNumber, p.name);
        if (clash) return clash;
        continue;
      }

      if (!oneof.fieldNumbers) {
        return `[wiz] Property '${p.name}' on type '${plan.name}' is a union, which protobuf encodes as a 'oneof' and so needs a field number per variant. Declare it as NumberedUnion<{ 1: A; 2: B }> instead of A | B.`;
      }
      if (p.fieldNumber !== undefined && !Number.isNaN(p.fieldNumber)) {
        return `[wiz] Property '${p.name}' on type '${plan.name}' carries '@fieldNumber ${p.fieldNumber}' but its NumberedUnion already numbers each variant. Remove the tag.`;
      }
      for (const [index, n] of oneof.fieldNumbers.entries()) {
        const clash = claim(n, `${p.name} variant ${index + 1}`);
        if (clash) return clash;
      }

      // Encoding picks a variant by inspecting the value, so two variants that
      // no test can separate would silently encode under the wrong number.
      if (!oneof.discriminator) {
        const seen = new Map<string, number>();
        for (const [index, variant] of oneof.types.entries()) {
          const unwrapped = unwrapNullable(variant);
          if (unwrapped.kind !== "object" && unwrapped.kind !== "intersection") continue;
          const signature = requiredSignature(unwrapped).join(",");
          const first = seen.get(signature);
          if (first !== undefined) {
            return `[wiz] Variants ${first + 1} and ${index + 1} of property '${p.name}' on type '${plan.name}' have the same required properties (${signature || "none"}), so a value cannot be matched to one of them. Give the union a discriminant property with a distinct literal value.`;
          }
          seen.set(signature, index);
        }
      }
    }
  }
  return undefined;
}
export function generateProtobufCode(ir: TypeIR): string {
  const plans = planMessages(ir);

  const blocker = protobufBlocker(plans);
  if (blocker) {
    return [
      `export function encodeProto(val, buf, offset = 0) {`,
      `  throw new Error(${JSON.stringify(blocker)});`,
      `}`,
      ``,
      `export function decodeProto(buf, offset = 0) {`,
      `  throw new Error(${JSON.stringify(blocker)});`,
      `}`,
    ].join("\n");
  }

  const messageId = new Map<TypeIR, number>();
  for (const plan of plans) messageId.set(plan.ir, plan.id);

  const functions: string[] = [];

  for (const plan of plans) {
    const encodeLines: string[] = [];
    const decodeCases: string[] = [];
    // A oneof has no single number; it sorts by its lowest variant.
    const numberOf = (p: PropertyIR): number => {
      const variants = oneofFor(p.type)?.fieldNumbers;
      return variants ? Math.min(...variants) : p.fieldNumber!;
    };
    const sorted = [...flattenObjectProperties(plan.ir)].sort(
      (a, b) => numberOf(a) - numberOf(b)
    );

    for (const p of sorted) {
      const prop = JSON.stringify(p.name);
      const access = `val[${prop}]`;

      // ---- oneof ----------------------------------------------------------
      const oneof = oneofFor(p.type);
      if (oneof?.fieldNumbers) {
        const local = `oneof${numberOf(p)}`;
        encodeLines.push(`  const ${local} = ${access};`);
        encodeLines.push(`  if (${local} !== undefined && ${local} !== null) {`);

        oneof.types.forEach((variant, index) => {
          const n = oneof.fieldNumbers![index]!;
          const nested = messageId.get(messageTarget(variant) ?? variant);
          const check = variantCheck(variant, oneof, local);
          const branch = index === 0 ? "if" : "} else if";

          encodeLines.push(`    ${branch} (${check}) {`);
          if (nested !== undefined) {
            encodeLines.push(`      o += writeVarint(buf, o, ${(n << 3) | 2});`);
            encodeLines.push(
              ...lengthDelimited([`o = encodeMsg${nested}(${local}, buf, o, view);`], "      ")
            );
          } else {
            const codec = scalarCodecFor(variant, p) ?? JSON_FALLBACK;
            encodeLines.push(`      o += writeVarint(buf, o, ${(n << 3) | codec.wire});`);
            encodeLines.push(`      ${codec.write(local)}`);
          }

          decodeCases.push(`      case ${n}: {`);
          if (nested !== undefined) {
            decodeCases.push(`        let len; [len, o] = readVarint(buf, o);`);
            decodeCases.push(`        obj[${prop}] = decodeMsg${nested}(buf, o, o + len, view);`);
            decodeCases.push(`        o += len;`);
          } else {
            const codec = scalarCodecFor(variant, p) ?? JSON_FALLBACK;
            decodeCases.push(`        ${codec.read}`);
            decodeCases.push(`        obj[${prop}] = ${codec.lift("res")};`);
          }
          decodeCases.push(`        break;`);
          decodeCases.push(`      }`);
        });

        encodeLines.push(`    }`);
        encodeLines.push(`  }`);
        continue;
      }

      const fn = p.fieldNumber!;
      const pType = wireFieldType(p.type);

      const embedded = messageTarget(pType);

      // ---- repeated -------------------------------------------------------
      if (pType.kind === "array") {
        const element = pType.element;
        const nested = embedded ? messageId.get(embedded) : undefined;

        if (nested !== undefined) {
          // Repeated messages are never packed: each entry is its own record.
          const tag = (fn << 3) | 2;
          encodeLines.push(`  if (Array.isArray(${access})) {`);
          encodeLines.push(`    for (const item of ${access}) {`);
          encodeLines.push(`      o += writeVarint(buf, o, ${tag});`);
          encodeLines.push(
            ...lengthDelimited([`o = encodeMsg${nested}(item, buf, o, view);`], "      ")
          );
          encodeLines.push(`    }`);
          encodeLines.push(`  }`);

          decodeCases.push(`      case ${fn}: {`);
          decodeCases.push(`        let len; [len, o] = readVarint(buf, o);`);
          decodeCases.push(`        obj[${prop}] = obj[${prop}] || [];`);
          decodeCases.push(`        obj[${prop}].push(decodeMsg${nested}(buf, o, o + len, view));`);
          decodeCases.push(`        o += len;`);
          decodeCases.push(`        break;`);
          decodeCases.push(`      }`);
          continue;
        }

        // `@format` sits on the property but describes each element.
        const codec = scalarCodecFor(element, p) ?? JSON_FALLBACK;
        // proto3 packs repeated scalars by default; only length-delimited
        // element types stay unpacked, since they carry their own length.
        const packable = codec.wire !== 2;
        const tag = (fn << 3) | (packable ? 2 : codec.wire);

        encodeLines.push(`  if (Array.isArray(${access}) && ${access}.length > 0) {`);
        encodeLines.push(`    o += writeVarint(buf, o, ${tag});`);
        if (packable) {
          encodeLines.push(
            ...lengthDelimited(
              [`for (const item of ${access}) { ${codec.write("item")} }`],
              "    "
            )
          );
        } else {
          encodeLines.push(`    ${codec.write(`${access}[0]`)}`);
          encodeLines.push(`    for (let i = 1; i < ${access}.length; i++) {`);
          encodeLines.push(`      o += writeVarint(buf, o, ${tag});`);
          encodeLines.push(`      ${codec.write(`${access}[i]`)}`);
          encodeLines.push(`    }`);
        }
        encodeLines.push(`  }`);

        decodeCases.push(`      case ${fn}: {`);
        decodeCases.push(`        obj[${prop}] = obj[${prop}] || [];`);
        if (packable) {
          // A conformant reader accepts both framings regardless of what it writes.
          decodeCases.push(`        if (wireType === 2) {`);
          decodeCases.push(`          let len; [len, o] = readVarint(buf, o);`);
          decodeCases.push(`          const stop = o + len;`);
          decodeCases.push(`          while (o < stop) {`);
          decodeCases.push(`            ${codec.read}`);
          decodeCases.push(`            obj[${prop}].push(${codec.lift("res")});`);
          decodeCases.push(`          }`);
          decodeCases.push(`        } else {`);
          decodeCases.push(`          ${codec.read}`);
          decodeCases.push(`          obj[${prop}].push(${codec.lift("res")});`);
          decodeCases.push(`        }`);
        } else {
          decodeCases.push(`        ${codec.read}`);
          decodeCases.push(`        obj[${prop}].push(${codec.lift("res")});`);
        }
        decodeCases.push(`        break;`);
        decodeCases.push(`      }`);
        continue;
      }

      // ---- map ------------------------------------------------------------
      if (pType.kind === "record") {
        // `@format` on the property describes the map's value type.
        const valueCodec = scalarCodecFor(pType.valueType, p) ?? JSON_FALLBACK;
        const valueMsg = messageTarget(pType.valueType);
        const valueId = valueMsg ? messageId.get(valueMsg) : undefined;
        const tag = (fn << 3) | 2;

        // A protobuf map entry is a message with key = 1 and value = 2.
        const entryBody: string[] = [`o += writeVarint(buf, o, ${(1 << 3) | 2});`, `o += writeString(buf, o, mapKey);`];
        if (valueId !== undefined) {
          entryBody.push(`o += writeVarint(buf, o, ${(2 << 3) | 2});`);
          entryBody.push(...lengthDelimited([`o = encodeMsg${valueId}(mapVal, buf, o, view);`], ""));
        } else {
          entryBody.push(`o += writeVarint(buf, o, ${(2 << 3) | valueCodec.wire});`);
          entryBody.push(valueCodec.write("mapVal"));
        }

        encodeLines.push(`  if (${access} !== undefined && ${access} !== null) {`);
        encodeLines.push(`    for (const [mapKey, mapVal] of Object.entries(${access})) {`);
        encodeLines.push(`      o += writeVarint(buf, o, ${tag});`);
        encodeLines.push(...lengthDelimited(entryBody, "      "));
        encodeLines.push(`    }`);
        encodeLines.push(`  }`);

        decodeCases.push(`      case ${fn}: {`);
        decodeCases.push(`        let len; [len, o] = readVarint(buf, o);`);
        decodeCases.push(`        const stop = o + len;`);
        decodeCases.push(`        let mapKey = "";`);
        decodeCases.push(`        let mapVal;`);
        decodeCases.push(`        while (o < stop) {`);
        decodeCases.push(`          let entryTag; [entryTag, o] = readVarint(buf, o);`);
        decodeCases.push(`          if ((entryTag >> 3) === 1) {`);
        decodeCases.push(`            [mapKey, o] = readString(buf, o);`);
        decodeCases.push(`          } else {`);
        if (valueId !== undefined) {
          decodeCases.push(`            let vlen; [vlen, o] = readVarint(buf, o);`);
          decodeCases.push(`            mapVal = decodeMsg${valueId}(buf, o, o + vlen, view);`);
          decodeCases.push(`            o += vlen;`);
        } else {
          decodeCases.push(`            ${valueCodec.read}`);
          decodeCases.push(`            mapVal = ${valueCodec.lift("res")};`);
        }
        decodeCases.push(`          }`);
        decodeCases.push(`        }`);
        decodeCases.push(`        obj[${prop}] = obj[${prop}] || {};`);
        decodeCases.push(`        obj[${prop}][mapKey] = mapVal;`);
        decodeCases.push(`        break;`);
        decodeCases.push(`      }`);
        continue;
      }

      // ---- embedded message ------------------------------------------------
      const nestedId = embedded ? messageId.get(embedded) : undefined;
      if (nestedId !== undefined) {
        const tag = (fn << 3) | 2;
        encodeLines.push(`  if (${access} !== undefined && ${access} !== null) {`);
        encodeLines.push(`    o += writeVarint(buf, o, ${tag});`);
        encodeLines.push(
          ...lengthDelimited([`o = encodeMsg${nestedId}(${access}, buf, o, view);`], "    ")
        );
        encodeLines.push(`  }`);

        decodeCases.push(`      case ${fn}: {`);
        decodeCases.push(`        let len; [len, o] = readVarint(buf, o);`);
        decodeCases.push(`        obj[${prop}] = decodeMsg${nestedId}(buf, o, o + len, view);`);
        decodeCases.push(`        o += len;`);
        decodeCases.push(`        break;`);
        decodeCases.push(`      }`);
        continue;
      }

      // ---- scalar -----------------------------------------------------------
      const codec = scalarCodecFor(pType, p) ?? JSON_FALLBACK;
      const tag = (fn << 3) | codec.wire;
      encodeLines.push(`  if (${access} !== undefined) {`);
      encodeLines.push(`    o += writeVarint(buf, o, ${tag});`);
      encodeLines.push(`    ${codec.write(access)}`);
      encodeLines.push(`  }`);

      decodeCases.push(`      case ${fn}: {`);
      decodeCases.push(`        ${codec.read}`);
      decodeCases.push(`        obj[${prop}] = ${codec.lift("res")};`);
      decodeCases.push(`        break;`);
      decodeCases.push(`      }`);
    }

    functions.push(
      [
        `function encodeMsg${plan.id}(val, buf, offset, view) {`,
        `  let o = offset;`,
        ...encodeLines,
        `  return o;`,
        `}`,
        ``,
        `function decodeMsg${plan.id}(buf, offset, end, view) {`,
        `  let o = offset;`,
        `  const obj = {};`,
        `  while (o < end) {`,
        `    let tag; [tag, o] = readVarint(buf, o);`,
        `    if (tag === 0) break;`,
        `    const fieldNum = tag >> 3;`,
        `    const wireType = tag & 7;`,
        `    switch (fieldNum) {`,
        ...decodeCases,
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
      ].join("\n")
    );
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
    `// sint32/sint64: zig-zag maps small negatives onto small positives, so`,
    `// -1 costs one byte instead of ten.`,
    `function writeZigZag(buf, offset, value) {`,
    `  const v = typeof value === "bigint" ? value : BigInt(Math.trunc(Number(value) || 0));`,
    `  return writeVarint64(buf, offset, BigInt.asUintN(64, (v << 1n) ^ (v >> 63n)));`,
    `}`,
    ``,
    `function readZigZag(buf, offset) {`,
    `  const [raw, next] = readVarint64(buf, offset);`,
    `  const u = BigInt.asUintN(64, raw);`,
    `  return [(u >> 1n) ^ -(u & 1n), next];`,
    `}`,
    ``,
    `function writeBytes(buf, offset, value) {`,
    `  const bytes = value instanceof Uint8Array`,
    `    ? value`,
    `    : new Uint8Array(value ?? []);`,
    `  let o = offset;`,
    `  o += writeVarint(buf, o, bytes.length);`,
    `  buf.set(bytes, o);`,
    `  return o + bytes.length - offset;`,
    `}`,
    ``,
    `function readBytes(buf, offset) {`,
    `  const [len, start] = readVarint(buf, offset);`,
    `  return [buf.slice(start, start + len), start + len];`,
    `}`,
    ``,
    `function varintSize(n) {`,
    `  let size = 1;`,
    `  let v = n;`,
    `  while (v >= 0x80) { v = Math.floor(v / 128); size++; }`,
    `  return size;`,
    `}`,
    ``,
    ...functions,
    ``,
    `export function encodeProto(val, buf, offset = 0) {`,
    `  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);`,
    `  return encodeMsg0(val, buf, offset, view) - offset;`,
    `}`,
    ``,
    `export function decodeProto(buf, offset = 0) {`,
    `  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);`,
    `  return decodeMsg0(buf, offset, buf.length, view);`,
    `}`,
  ].join("\n");
}

function mapIRToProtoType(ir: TypeIR, carrier?: Annotated): string {
  const numeric = protoNumericFor(ir, carrier);
  if (numeric) return numeric.proto;

  switch (ir.kind) {
    case "primitive":
      switch (ir.type) {
        case "string":
        case "symbol":
          return "string";
        case "boolean":
          return "bool";
        case "bytes":
          return "bytes";
        default:
          return "string";
      }
    case "literal":
      if (typeof ir.value === "boolean") return "bool";
      if (typeof ir.value === "bigint") return "int64";
      if (typeof ir.value === "number") return "double";
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

/**
 * A protobuf field name for a `oneof` variant.
 *
 * `oneof` members are named fields, but the TypeScript union offers no names,
 * so the variant's own type name is used where it has one.
 */
function variantFieldName(ir: TypeIR, index: number): string {
  const base = unwrapNullable(ir).name;
  if (!base) return `variant_${index + 1}`;
  return base.charAt(0).toLowerCase() + base.slice(1);
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

  // Every property must be numbered, whether directly or through its variants.
  for (const [typeName, typeIR] of allNamedTypes.entries()) {
    for (const prop of flattenObjectProperties(typeIR)) {
      const oneof = oneofFor(prop.type);
      if (oneof && !oneof.fieldNumbers) {
        const errMessage = `[wiz] Property '${prop.name}' on type '${typeName}' is a union, which protobuf encodes as a 'oneof' and so needs a field number per variant. Declare it as NumberedUnion<{ 1: A; 2: B }> instead of A | B.`;
        return [
          `export function protobufSchema(options = {}) {`,
          `  throw new Error(${JSON.stringify(errMessage)});`,
          `}`,
        ].join("\n");
      }
      if (!oneof && (prop.fieldNumber === undefined || Number.isNaN(prop.fieldNumber))) {
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
      /** Set when this entry belongs to a `oneof` of that name. */
      oneof?: string;
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
      const numberOf = (p: PropertyIR): number => {
        const variants = oneofFor(p.type)?.fieldNumbers;
        return variants ? Math.min(...variants) : p.fieldNumber!;
      };
      const sortedProps = [...props].sort((a, b) => numberOf(a) - numberOf(b));

      typeDefs.push({
        name: typeName,
        isEnum: false,
        description: typeIR.description,
        entries: sortedProps.flatMap((p) => {
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

          const oneof = oneofFor(p.type);
          if (oneof?.fieldNumbers) {
            // Variants are named after their type; protobuf needs a field name
            // per member and the TypeScript side has none to offer.
            return oneof.types.map((variant, index) => ({
              name: variantFieldName(variant, index),
              type: mapIRToProtoType(variant, p),
              fieldNumber: oneof.fieldNumbers![index]!,
              comments: index === 0 ? comments : [],
              options,
              oneof: p.name,
            }));
          }

          return [
            {
              name: p.name,
              type: mapIRToProtoType(wireFieldType(p.type), p),
              fieldNumber: p.fieldNumber!,
              comments,
              options,
            },
          ];
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
    `      let openOneof = null;`,
    `      for (const entry of def.entries) {`,
    `        if (entry.oneof !== openOneof) {`,
    `          if (openOneof !== null) lines.push(indent + '}');`,
    `          if (entry.oneof) lines.push(indent + 'oneof ' + entry.oneof + ' {');`,
    `          openOneof = entry.oneof ?? null;`,
    `        }`,
    `        const pad = entry.oneof ? indent + indent : indent;`,
    `        if (entry.comments && entry.comments.length > 0) {`,
    `          for (const c of entry.comments) {`,
    `            lines.push(pad + '// ' + c);`,
    `          }`,
    `        }`,
    `        const optStr = entry.options && entry.options.length > 0 ? ' [' + entry.options.join(', ') + ']' : '';`,
    `        lines.push(pad + entry.type + ' ' + entry.name + ' = ' + entry.fieldNumber + optStr + ';');`,
    `      }`,
    `      if (openOneof !== null) lines.push(indent + '}');`,
    `      lines.push('}');`,
    `    }`,
    `    lines.push('');`,
    `  }`,
    `  return lines.join('\\n').trim();`,
    `}`,
  ].join("\n");
}
