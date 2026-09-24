import { createRequire } from 'node:module';
import {
  declaredFormat,
  flattenObjectProperties,
  walkTypeIR,
  type Annotated,
  type TypeIR,
} from '../types.ts';

/**
 * Apache Arrow support.
 *
 * Arrow is columnar and batch-oriented, so unlike protobuf and Avro a value is
 * a *table* of records rather than one record. An IPC stream is a schema
 * message followed by record batches, each a FlatBuffers header plus a body of
 * validity bitmaps, offsets and values.
 *
 * That splits neatly by what each part depends on:
 *
 *   schema message      the type alone     precomputed here, inlined as bytes
 *   record batch header row count, sizes   generated code, small writer
 *   body                the data           generated code, columnar writes
 *
 * `apache-arrow` produces the schema message at build time, so the reference
 * implementation owns the part where all the type complexity lives - nested
 * types, dictionaries, field metadata - and none of it reaches a bundle. The
 * generated code has no dependencies at all.
 */

/** Arrow's fixed-width numeric types, as `@format` selects them. */
const FORMAT_TO_ARROW: Record<string, string> = {
  int32: 'Int32',
  int64: 'Int64',
  uint32: 'Uint32',
  uint64: 'Uint64',
  sint32: 'Int32',
  sint64: 'Int64',
  fixed32: 'Uint32',
  sfixed32: 'Int32',
  fixed64: 'Uint64',
  sfixed64: 'Int64',
  float: 'Float32',
  double: 'Float64',
  byte: 'Binary',
  binary: 'Binary',
  // Arrow has native columns at these widths, so nothing has to widen.
  int8: 'Int8',
  int16: 'Int16',
  uint8: 'Uint8',
  uint16: 'Uint16',
  // 64-bit on the wire, but carried by a `number`, which is what the format
  // states: an integer a double holds exactly.
  'double-int': 'Int64',
  unixtime: 'Int64',
  'sf-integer': 'Int64',
  'sf-decimal': 'Float64',
};

/**
 * How a leaf value is laid out, which is what the codec needs to know.
 *
 * `buffers` counts the body buffers the field occupies, validity included:
 * fixed-width types have two, the variable-length ones add an offsets buffer.
 */
export interface ArrowLeaf {
  kind: 'int' | 'uint' | 'float' | 'bool' | 'utf8' | 'binary' | 'timestamp' | 'date';
  /** Bit width for numeric and boolean layouts. */
  width: 8 | 16 | 32 | 64 | 1;
  /**
   * Which JS type the column round-trips as.
   *
   * A 64-bit column is a bigint when the property is one, and a number when it
   * is a number - `@format double-int` is 64 bits wide and still a number.
   * Getting this wrong changes the type on the way back, which is a silent
   * round-trip failure rather than a wrong value.
   */
  js?: 'number' | 'bigint';
  /** Arrow type name, for the schema builder. */
  arrow: string;
}

export interface ArrowField {
  name: string;
  nullable: boolean;
  /** Present for a leaf; absent when `children` describes a nested layout. */
  leaf?: ArrowLeaf;
  /** `list`, `struct` or `map` when the field nests. */
  nested?: 'list' | 'struct' | 'map';
  children: ArrowField[];
}

const LEAVES: Record<string, ArrowLeaf> = {
  Int32: { kind: 'int', width: 32, arrow: 'Int32' },
  Int64: { kind: 'int', width: 64, arrow: 'Int64' },
  Uint32: { kind: 'uint', width: 32, arrow: 'Uint32' },
  Uint64: { kind: 'uint', width: 64, arrow: 'Uint64' },
  Float32: { kind: 'float', width: 32, arrow: 'Float32' },
  Float64: { kind: 'float', width: 64, arrow: 'Float64' },
  Bool: { kind: 'bool', width: 1, arrow: 'Bool' },
  Utf8: { kind: 'utf8', width: 32, arrow: 'Utf8' },
  Binary: { kind: 'binary', width: 32, arrow: 'Binary' },
  TimestampMillisecond: { kind: 'timestamp', width: 64, arrow: 'TimestampMillisecond' },
  Int8: { kind: 'int', width: 8, arrow: 'Int8' },
  Int16: { kind: 'int', width: 16, arrow: 'Int16' },
  Uint8: { kind: 'uint', width: 8, arrow: 'Uint8' },
  Uint16: { kind: 'uint', width: 16, arrow: 'Uint16' },
};

/** `T | undefined` reaching us is what makes an Arrow field nullable. */
function unwrapNullable(ir: TypeIR): { nullable: boolean; inner: TypeIR } {
  if (ir.kind !== 'union') {
    return { nullable: false, inner: ir };
  }
  const absent = (t: TypeIR) =>
    t.kind === 'primitive' && (t.type === 'undefined' || t.type === 'null' || t.type === 'void');

  const meaningful = ir.types.filter((t) => !absent(t));
  if (meaningful.length === ir.types.length) {
    return { nullable: false, inner: ir };
  }
  return {
    nullable: true,
    inner: meaningful.length === 1 ? meaningful[0]! : { ...ir, types: meaningful },
  };
}

/** A union of same-typed literals is that primitive, exactly as elsewhere. */
function collapseLiteralUnion(ir: TypeIR): TypeIR | undefined {
  if (ir.kind !== 'union') {
    return undefined;
  }
  const types = new Set<string>();
  for (const member of ir.types) {
    if (member.kind !== 'literal') {
      return undefined;
    }
    types.add(typeof member.value === 'bigint' ? 'bigint' : typeof member.value);
  }
  if (types.size !== 1) {
    return undefined;
  }
  const only = [...types][0];
  if (only !== 'string' && only !== 'number' && only !== 'bigint' && only !== 'boolean') {
    return undefined;
  }
  return { id: `${ir.id}_collapsed`, kind: 'primitive', type: only };
}

function leafFor(ir: TypeIR, carrier?: Annotated): ArrowLeaf | undefined {
  if (ir.kind === 'enum') {
    return LEAVES.Utf8;
  }
  if (ir.kind === 'literal') {
    const type = typeof ir.value === 'bigint' ? 'bigint' : typeof ir.value;
    return leafFor({ id: `${ir.id}_p`, kind: 'primitive', type: type as never }, carrier);
  }
  if (ir.kind !== 'primitive') {
    return undefined;
  }

  const declared = declaredFormat(carrier, ir);
  const named = declared ? FORMAT_TO_ARROW[declared] : undefined;

  switch (ir.type) {
    case 'string':
    case 'symbol':
      // `@format binary` says the string carries opaque bytes.
      return named === 'Binary' ? LEAVES.Binary : LEAVES.Utf8;
    case 'boolean':
      return LEAVES.Bool;
    case 'bytes':
      return LEAVES.Binary;
    case 'date':
      return LEAVES.TimestampMillisecond;
    case 'bigint': {
      // 64-bit by definition, though `@format int32` may still narrow it.
      const leaf = LEAVES[named ?? 'Int64'] ?? LEAVES.Int64!;
      return { ...leaf, js: 'bigint' };
    }
    case 'number': {
      // A JS number is a double; `@format` is what narrows it. The carrier
      // stays a number even at 64 bits, which is what `double-int` means.
      const leaf = LEAVES[named ?? 'Float64'] ?? LEAVES.Float64!;
      return { ...leaf, js: 'number' };
    }
    default:
      return undefined;
  }
}

/** The reason a type cannot be an Arrow column, or undefined. */
function arrowBlocker(ir: TypeIR, name: string, carrier?: Annotated): string | undefined {
  const { inner } = unwrapNullable(ir);
  const collapsed = collapseLiteralUnion(inner) ?? inner;

  if (leafFor(collapsed, carrier)) {
    return undefined;
  }
  if (collapsed.kind === 'array') {
    return arrowBlocker(collapsed.element, `${name} item`, carrier);
  }
  if (collapsed.kind === 'record') {
    return arrowBlocker(collapsed.valueType, `${name} value`, carrier);
  }
  if (collapsed.kind === 'object' || collapsed.kind === 'intersection') {
    for (const property of flattenObjectProperties(collapsed)) {
      const blocker = arrowBlocker(property.type, `${name}.${property.name}`, property);
      if (blocker) {
        return blocker;
      }
    }
    return undefined;
  }
  if (collapsed.kind === 'union') {
    return `[wiz] '${name}' is a union, which Arrow represents as a union column; wiz does not emit those yet. Wrap the variants in their own type, or narrow the field.`;
  }
  return `[wiz] '${name}' has no Arrow column type (${collapsed.kind}${
    collapsed.kind === 'primitive' ? ` ${collapsed.type}` : ''
  }).`;
}

function fieldFor(name: string, ir: TypeIR, optional: boolean, carrier?: Annotated): ArrowField {
  const { nullable, inner } = unwrapNullable(ir);
  const target = collapseLiteralUnion(inner) ?? inner;
  const isNullable = optional || nullable;

  const leaf = leafFor(target, carrier);
  if (leaf) {
    return { name, nullable: isNullable, leaf, children: [] };
  }

  if (target.kind === 'array') {
    return {
      name,
      nullable: isNullable,
      nested: 'list',
      // Arrow names a list's child `item` by convention.
      children: [fieldFor('item', target.element, false, carrier)],
    };
  }

  if (target.kind === 'record') {
    // Arrow models a map as a list of a non-nullable `entries` struct. The
    // field tree has to carry that level, because buffers are counted per
    // field and skipping it would shift every buffer after it.
    return {
      name,
      nullable: isNullable,
      nested: 'map',
      children: [
        {
          name: 'entries',
          nullable: false,
          nested: 'struct',
          children: [
            fieldFor('key', target.keyType, false),
            fieldFor('value', target.valueType, true, carrier),
          ],
        },
      ],
    };
  }

  return {
    name,
    nullable: isNullable,
    nested: 'struct',
    children: flattenObjectProperties(target).map((property) =>
      fieldFor(property.name, property.type, Boolean(property.optional), property)
    ),
  };
}

/** The columns a record type becomes. */
export function arrowFields(ir: TypeIR): ArrowField[] {
  const { inner } = unwrapNullable(ir);
  return flattenObjectProperties(inner).map((property) =>
    fieldFor(property.name, property.type, Boolean(property.optional), property)
  );
}

/** Rejects a type Arrow cannot describe, so the failure names the field. */
export function arrowTypeBlocker(ir: TypeIR, name: string): string | undefined {
  const { inner } = unwrapNullable(ir);
  const properties = flattenObjectProperties(inner);
  if (properties.length === 0) {
    return `[wiz] Type '${name}' has no properties, so it has no Arrow columns.`;
  }
  for (const property of properties) {
    const blocker = arrowBlocker(property.type, `${name}.${property.name}`, property);
    if (blocker) {
      return blocker;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Schema message, built by the reference implementation
// ---------------------------------------------------------------------------

interface ArrowModule {
  Schema: new (fields: unknown[]) => unknown;
  Field: new (name: string, type: unknown, nullable: boolean) => unknown;
  Table: new (schema: unknown) => unknown;
  tableToIPC: (table: unknown, variant: 'stream' | 'file') => Uint8Array;
  List: new (child: unknown) => unknown;
  Struct: new (children: unknown[]) => unknown;
  Map_: new (child: unknown, keysSorted?: boolean) => unknown;
  [key: string]: unknown;
}

let arrowModule: ArrowModule | undefined;

/**
 * Loads `apache-arrow`, which is needed to build a schema and never at runtime.
 *
 * Required synchronously because the transform is synchronous; a dynamic import
 * would make every generator async for one optional back end.
 */
function loadArrow(): ArrowModule {
  if (arrowModule) {
    return arrowModule;
  }
  try {
    const require = createRequire(import.meta.url);
    arrowModule = require('apache-arrow') as ArrowModule;
    return arrowModule;
  } catch {
    throw new Error(
      "[wiz] Arrow support needs 'apache-arrow' at build time: run 'bun add -d apache-arrow'. " +
        'It builds the schema during the transform and never reaches your bundle.'
    );
  }
}

function arrowTypeOf(field: ArrowField, A: ArrowModule): unknown {
  if (field.leaf) {
    const Ctor = A[field.leaf.arrow] as new () => unknown;
    return new Ctor();
  }
  const children = field.children.map(
    (child) => new A.Field(child.name, arrowTypeOf(child, A), child.nullable)
  );
  if (field.nested === 'list') {
    return new A.List(children[0]);
  }
  if (field.nested === 'map') {
    // The entries struct is a real level in the field tree now, so it is
    // already the single child.
    return new A.Map_(children[0], false);
  }
  return new A.Struct(children);
}

/**
 * The IPC schema message for these columns, framed and padded, ready to be the
 * first bytes of a stream.
 */
export function arrowSchemaMessage(fields: ArrowField[]): Uint8Array {
  const A = loadArrow();
  const schema = new A.Schema(
    fields.map((field) => new A.Field(field.name, arrowTypeOf(field, A), field.nullable))
  );
  const stream = A.tableToIPC(new A.Table(schema), 'stream');

  // An empty table is the schema message followed by the end-of-stream marker,
  // and only the message belongs to us.
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const metadataLength = view.getUint32(4, true);
  return stream.slice(0, 8 + metadataLength);
}

/** A readable description of the columns, for `arrowSchema<[T]>()`. */
export function arrowSchemaJson(fields: ArrowField[]): unknown {
  const describe = (field: ArrowField): unknown => ({
    name: field.name,
    type: field.leaf ? field.leaf.arrow : field.nested,
    nullable: field.nullable,
    ...(field.children.length > 0 ? { children: field.children.map(describe) } : {}),
  });
  return { fields: fields.map(describe) };
}

/** Every leaf column, depth first, which is the order Arrow's buffers follow. */
export function flattenArrowFields(fields: ArrowField[]): ArrowField[] {
  const out: ArrowField[] = [];
  const walk = (field: ArrowField): void => {
    out.push(field);
    for (const child of field.children) {
      walk(child);
    }
  };
  for (const field of fields) {
    walk(field);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Record batch metadata, templated from the reference implementation
// ---------------------------------------------------------------------------

/**
 * A minimal FlatBuffers table reader.
 *
 * Only what Message and RecordBatch need. Fields are found through a vtable,
 * and the two structs involved are inline and fixed size, so this is far less
 * code than an encoder - which is why the write side is templated instead.
 */
function fbFieldOffset(view: DataView, table: number, field: number): number {
  const vtable = table - view.getInt32(table, true);
  const vtableSize = view.getUint16(vtable, true);
  const index = 4 + field * 2;
  if (index >= vtableSize) {
    return 0;
  }
  return view.getUint16(vtable + index, true);
}

/** Where the numbers a batch has to fill in are found. */
export interface BatchTemplate {
  /** The framed message, with the sample batch's numbers still in it. */
  bytes: Uint8Array;
  bodyLengthAt: number;
  rowCountAt: number;
  /** Byte offset of each FieldNode struct, in field order. */
  nodeAt: number[];
  /** Byte offset of each Buffer struct, in buffer order. */
  bufferAt: number[];
}

/**
 * Locates the varying integers in a record batch message.
 *
 * A FlatBuffers layout is decided by structure, not values, so for one schema
 * these offsets are constant. Taking them from a message the reference
 * implementation produced means never writing a FlatBuffers encoder, and the
 * framing is Arrow's own by construction.
 */
export function readBatchTemplate(message: Uint8Array): BatchTemplate {
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  // The FlatBuffers root sits after the continuation marker and length prefix.
  const base = 8;
  const root = base + view.getUint32(base, true);

  const bodyLengthOffset = fbFieldOffset(view, root, 3);
  const headerOffset = fbFieldOffset(view, root, 2);
  if (bodyLengthOffset === 0 || headerOffset === 0) {
    throw new Error('[wiz] arrow template has no bodyLength or header');
  }
  const headerPtr = root + headerOffset;
  const batch = headerPtr + view.getUint32(headerPtr, true);

  const rowCountOffset = fbFieldOffset(view, batch, 0);
  const nodesOffset = fbFieldOffset(view, batch, 1);
  const buffersOffset = fbFieldOffset(view, batch, 2);
  if (rowCountOffset === 0 || nodesOffset === 0 || buffersOffset === 0) {
    throw new Error('[wiz] arrow template has no length, nodes or buffers');
  }

  const vectorAt = (fieldPtr: number) => {
    const vector = fieldPtr + view.getUint32(fieldPtr, true);
    return { start: vector + 4, length: view.getUint32(vector, true) };
  };
  const nodes = vectorAt(batch + nodesOffset);
  const buffers = vectorAt(batch + buffersOffset);

  return {
    bytes: message,
    bodyLengthAt: root + bodyLengthOffset,
    rowCountAt: batch + rowCountOffset,
    // FieldNode is {int64 length, int64 null_count}, Buffer is {int64 offset,
    // int64 length}; both are 16 bytes.
    nodeAt: Array.from({ length: nodes.length }, (_, i) => nodes.start + i * 16),
    bufferAt: Array.from({ length: buffers.length }, (_, i) => buffers.start + i * 16),
  };
}

/** One row of data, so no buffer in the template is empty. */
function sampleColumn(field: ArrowField, A: ArrowModule): unknown {
  const make = A.vectorFromArray as (values: unknown[], type: unknown) => unknown;
  const type = arrowTypeOf(field, A);
  switch (field.leaf?.kind) {
    case 'utf8':
      return make(['x'], type);
    case 'binary':
      return make([new Uint8Array([1])], type);
    case 'bool':
      return make([true], type);
    case 'timestamp':
      return make([new Date(1)], type);
    case 'int':
    case 'uint':
      // A 64-bit arrow column takes a bigint sample even when the property is
      // a number, because that is what the builder for that type accepts.
      return make([field.leaf.width === 64 ? 1n : 1], type);
    case 'float':
      return make([1], type);
    default:
      throw new Error(
        `[wiz] Arrow batches are only generated for flat columns; '${field.name}' nests. ` +
          `arrowSchema() describes it, but encodeArrow()/decodeArrow() cannot carry it yet.`
      );
  }
}

/**
 * A record batch message for this schema, ready to be patched per batch.
 *
 * Built from one row of non-empty data deliberately: FlatBuffers omits a table
 * field equal to its default, so a zero row count or body length would leave
 * the very numbers we need to patch out of the layout entirely.
 */
export function arrowBatchTemplate(fields: ArrowField[]): BatchTemplate {
  const A = loadArrow();
  const columns = Object.fromEntries(fields.map((field) => [field.name, sampleColumn(field, A)]));
  const stream = A.tableToIPC(new A.Table(columns as never), 'stream');
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);

  const schemaLength = view.getUint32(4, true);
  const batchAt = 8 + schemaLength;
  const batchLength = view.getUint32(batchAt + 4, true);
  return readBatchTemplate(stream.slice(batchAt, batchAt + 8 + batchLength));
}

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

const BYTES = JSON.stringify;

/** A byte array as source, compact enough not to dominate the module. */
function byteLiteral(bytes: Uint8Array): string {
  return `new Uint8Array([${[...bytes].join(',')}])`;
}

/** Writes one column's values, given `n` rows and a `get(i)` accessor. */
function emitValues(leaf: ArrowLeaf, access: string): string[] {
  switch (leaf.kind) {
    case 'bool':
      return [
        `      len = Math.ceil(n / 8);`,
        `      buf.fill(0, o, o + len);`,
        `      for (let i = 0; i < n; i++) if (${access}) buf[o + (i >> 3)] |= 1 << (i & 7);`,
      ];
    case 'int':
    case 'uint':
    case 'timestamp': {
      if (leaf.width === 64) {
        const setter = leaf.kind === 'uint' ? 'setBigUint64' : 'setBigInt64';
        const coerce =
          leaf.kind === 'timestamp'
            ? `BigInt(v instanceof Date ? v.getTime() : Number(v ?? 0))`
            : `typeof v === "bigint" ? v : BigInt(Math.trunc(Number(v ?? 0)))`;
        return [
          `      len = n * 8;`,
          `      for (let i = 0; i < n; i++) {`,
          `        const v = ${access.replace('!= null', '')};`,
          `        view.${setter}(o + i * 8, v === undefined || v === null ? 0n : (${coerce}), true);`,
          `      }`,
        ];
      }
      // Arrow stores narrow integers at their real width, so the buffer is
      // n * 1 or n * 2 bytes rather than widened to four.
      const bytes = leaf.width === 8 ? 1 : leaf.width === 16 ? 2 : 4;
      const setter =
        leaf.kind === 'uint'
          ? bytes === 1
            ? 'setUint8'
            : bytes === 2
              ? 'setUint16'
              : 'setUint32'
          : bytes === 1
            ? 'setInt8'
            : bytes === 2
              ? 'setInt16'
              : 'setInt32';
      // The value is already known to fit: the validator enforces the declared
      // range, so this is a store, not a truncation.
      const args = bytes === 1 ? '' : ', true';
      return [
        `      len = n * ${bytes};`,
        `      for (let i = 0; i < n; i++) {`,
        `        const v = ${access.replace('!= null', '')};`,
        `        view.${setter}(o + i * ${bytes}, Number(v ?? 0)${args});`,
        `      }`,
      ];
    }
    case 'float':
      return [
        `      len = n * ${leaf.width === 32 ? 4 : 8};`,
        `      for (let i = 0; i < n; i++) {`,
        `        const v = ${access.replace('!= null', '')};`,
        `        view.${leaf.width === 32 ? 'setFloat32' : 'setFloat64'}(o + i * ${leaf.width === 32 ? 4 : 8}, Number(v ?? 0), true);`,
        `      }`,
      ];
    default:
      return [];
  }
}

/**
 * The Arrow IPC codec for a record type.
 *
 * A value is an array of records, because Arrow is columnar: the rows are
 * transposed into one buffer set per column, then framed as a schema message
 * and a single record batch.
 */
export function generateArrowCode(ir: TypeIR): string {
  const typeName = ir.name ?? 'Target';
  const blocker = arrowTypeBlocker(ir, typeName);
  if (blocker) {
    return [
      `export function encodeArrow(rows, buf, offset = 0) {`,
      `  throw new Error(${BYTES(blocker)});`,
      `}`,
      ``,
      `export function decodeArrow(buf, offset = 0) {`,
      `  throw new Error(${BYTES(blocker)});`,
      `}`,
    ].join('\n');
  }

  const fields = arrowFields(ir);
  let schemaMessage: Uint8Array;
  let template: BatchTemplate;
  try {
    schemaMessage = arrowSchemaMessage(fields);
    template = arrowBatchTemplate(fields);
  } catch (error) {
    const message = (error as Error).message;
    return [
      `export function encodeArrow(rows, buf, offset = 0) {`,
      `  throw new Error(${BYTES(message)});`,
      `}`,
      ``,
      `export function decodeArrow(buf, offset = 0) {`,
      `  throw new Error(${BYTES(message)});`,
      `}`,
    ].join('\n');
  }

  const encode: string[] = [];
  const decode: string[] = [];
  let bufferIndex = 0;

  fields.forEach((field) => {
    // Buffers accumulate across fields: a fixed-width column takes two and a
    // variable-width one takes three, so a field's slots start after every
    // preceding field's.
    const bufferStart = bufferIndex;
    const leaf = field.leaf!;
    const prop = BYTES(field.name);
    const value = `rows[i][${prop}]`;
    const variable = leaf.kind === 'utf8' || leaf.kind === 'binary';

    encode.push(
      `    // ${field.name}: ${leaf.arrow}`,
      `    {`,
      `      let nullCount = 0;`,
      `      for (let i = 0; i < n; i++) if (${value} === undefined || ${value} === null) nullCount++;`,
      `      nodes.push(n, nullCount);`,
      ``,
      `      // Validity is omitted entirely when nothing is null, which is what`,
      `      // Arrow expects: the slot stays, with zero length.`,
      `      let len = 0;`,
      `      if (nullCount > 0) {`,
      `        len = Math.ceil(n / 8);`,
      `        buf.fill(0, o, o + len);`,
      `        for (let i = 0; i < n; i++) {`,
      `          const v = ${value};`,
      `          if (v !== undefined && v !== null) buf[o + (i >> 3)] |= 1 << (i & 7);`,
      `        }`,
      `      }`,
      `      bufs.push(o - bodyAt, len);`,
      `      o = bodyAt + align(o + len - bodyAt);`,
      `    }`
    );
    bufferIndex += 1;

    if (variable) {
      const encodeItem =
        leaf.kind === 'utf8'
          ? `textEncoder.encode(String(v))`
          : `v instanceof Uint8Array ? v : new Uint8Array(v ?? [])`;
      encode.push(
        `    {`,
        `      // offsets, then the packed values they point into`,
        `      const parts = [];`,
        `      let total = 0;`,
        `      for (let i = 0; i < n; i++) {`,
        `        const v = ${value};`,
        `        const bytes = v === undefined || v === null ? EMPTY : ${encodeItem};`,
        `        parts.push(bytes);`,
        `        total += bytes.length;`,
        `      }`,
        `      let len = (n + 1) * 4;`,
        `      let at = 0;`,
        `      view.setInt32(o, 0, true);`,
        `      for (let i = 0; i < n; i++) {`,
        `        at += parts[i].length;`,
        `        view.setInt32(o + (i + 1) * 4, at, true);`,
        `      }`,
        `      bufs.push(o - bodyAt, len);`,
        `      o = bodyAt + align(o + len - bodyAt);`,
        ``,
        `      bufs.push(o - bodyAt, total);`,
        `      for (const bytes of parts) { buf.set(bytes, o); o += bytes.length; }`,
        `      o = bodyAt + align(o - bodyAt);`,
        `    }`
      );
      bufferIndex += 2;
    } else {
      encode.push(
        `    {`,
        `      let len = 0;`,
        ...emitValues(leaf, value),
        `      bufs.push(o - bodyAt, len);`,
        `      o = bodyAt + align(o + len - bodyAt);`,
        `    }`
      );
      bufferIndex += 1;
    }

    decode.push(...emitDecodeColumn(field, bufferStart));
  });

  return [
    `var textEncoder;`,
    `var textDecoder;`,
    `const EMPTY = new Uint8Array(0);`,
    `const __arrowSchema = ${byteLiteral(schemaMessage)};`,
    `const __arrowBatch = ${byteLiteral(template.bytes)};`,
    `const __arrowNodeAt = ${BYTES(template.nodeAt)};`,
    `const __arrowBufferAt = ${BYTES(template.bufferAt)};`,
    `const __arrowRowCountAt = ${template.rowCountAt};`,
    `const __arrowBodyLengthAt = ${template.bodyLengthAt};`,
    ``,
    `// Arrow requires each buffer to start on an 8-byte boundary.`,
    `function align(n) { return (n + 7) & ~7; }`,
    ``,
    `export function encodeArrow(rows, buf, offset = 0) {`,
    `  textEncoder ??= new TextEncoder();`,
    `  const n = rows.length;`,
    `  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);`,
    `  let o = offset;`,
    ``,
    `  buf.set(__arrowSchema, o); o += __arrowSchema.length;`,
    `  // The batch metadata is a fixed-size template, so the body position is`,
    `  // known before the body is written and nothing needs moving afterwards.`,
    `  const metaAt = o;`,
    `  buf.set(__arrowBatch, o); o += __arrowBatch.length;`,
    `  const bodyAt = o;`,
    ``,
    `  const nodes = [];`,
    `  const bufs = [];`,
    `  {`,
    ...encode,
    `  }`,
    ``,
    `  const bodyLength = o - bodyAt;`,
    `  view.setBigInt64(metaAt + __arrowRowCountAt, BigInt(n), true);`,
    `  view.setBigInt64(metaAt + __arrowBodyLengthAt, BigInt(bodyLength), true);`,
    `  for (let i = 0; i < __arrowNodeAt.length; i++) {`,
    `    view.setBigInt64(metaAt + __arrowNodeAt[i], BigInt(nodes[i * 2]), true);`,
    `    view.setBigInt64(metaAt + __arrowNodeAt[i] + 8, BigInt(nodes[i * 2 + 1]), true);`,
    `  }`,
    `  for (let i = 0; i < __arrowBufferAt.length; i++) {`,
    `    view.setBigInt64(metaAt + __arrowBufferAt[i], BigInt(bufs[i * 2]), true);`,
    `    view.setBigInt64(metaAt + __arrowBufferAt[i] + 8, BigInt(bufs[i * 2 + 1]), true);`,
    `  }`,
    ``,
    `  // End of stream.`,
    `  view.setUint32(o, 0xffffffff, true); o += 4;`,
    `  view.setUint32(o, 0, true); o += 4;`,
    `  return o - offset;`,
    `}`,
    ``,
    ARROW_READER,
    ``,
    `export function decodeArrow(buf, offset = 0) {`,
    `  textDecoder ??= new TextDecoder();`,
    `  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);`,
    `  const batch = __arrowReadBatch(view, buf, offset);`,
    `  const n = batch.rowCount;`,
    `  const body = batch.bodyAt;`,
    `  const bufs = batch.buffers;`,
    `  const rows = [];`,
    `  for (let i = 0; i < n; i++) rows.push({});`,
    ...decode,
    `  return rows;`,
    `}`,
  ].join('\n');
}

/**
 * The runtime half of the FlatBuffers reader.
 *
 * Decoding cannot use the template: a stream from another implementation is
 * free to lay its metadata out differently, so the buffers have to be found
 * through the vtable like any conformant reader would.
 */
const ARROW_READER = [
  `function __fbOffset(view, table, field) {`,
  `  const vtable = table - view.getInt32(table, true);`,
  `  const vtableSize = view.getUint16(vtable, true);`,
  `  const index = 4 + field * 2;`,
  `  if (index >= vtableSize) return 0;`,
  `  return view.getUint16(vtable + index, true);`,
  `}`,
  ``,
  `/** Skips the schema message and reads the first record batch. */`,
  `function __arrowReadBatch(view, buf, offset) {`,
  `  let at = offset;`,
  `  for (let message = 0; message < 2; message++) {`,
  `    if (view.getUint32(at, true) !== 0xffffffff) {`,
  `      throw new Error("[wiz] not an Arrow IPC stream: no continuation marker");`,
  `    }`,
  `    const metaLength = view.getUint32(at + 4, true);`,
  `    if (metaLength === 0) throw new Error("[wiz] Arrow stream ended before a record batch");`,
  `    const root = at + 8 + view.getUint32(at + 8, true);`,
  `    const headerType = __fbOffset(view, root, 1)`,
  `      ? view.getUint8(root + __fbOffset(view, root, 1))`,
  `      : 0;`,
  `    const bodyLengthAt = __fbOffset(view, root, 3);`,
  `    const bodyLength = bodyLengthAt ? Number(view.getBigInt64(root + bodyLengthAt, true)) : 0;`,
  `    const bodyAt = at + 8 + metaLength;`,
  ``,
  `    // MessageHeader.RecordBatch is 3; Schema is 1 and carries no body.`,
  `    if (headerType === 3) {`,
  `      const headerAt = root + __fbOffset(view, root, 2);`,
  `      const batch = headerAt + view.getUint32(headerAt, true);`,
  `      const rowCountAt = __fbOffset(view, batch, 0);`,
  `      const buffersAt = __fbOffset(view, batch, 2);`,
  `      const vector = batch + buffersAt + view.getUint32(batch + buffersAt, true);`,
  `      const count = view.getUint32(vector, true);`,
  `      const buffers = [];`,
  `      for (let i = 0; i < count; i++) {`,
  `        buffers.push(`,
  `          Number(view.getBigInt64(vector + 4 + i * 16, true)),`,
  `          Number(view.getBigInt64(vector + 4 + i * 16 + 8, true))`,
  `        );`,
  `      }`,
  `      return {`,
  `        rowCount: rowCountAt ? Number(view.getBigInt64(batch + rowCountAt, true)) : 0,`,
  `        bodyAt,`,
  `        buffers,`,
  `      };`,
  `    }`,
  `    at = bodyAt + bodyLength;`,
  `  }`,
  `  throw new Error("[wiz] Arrow stream has no record batch");`,
  `}`,
].join('\n');

function emitDecodeColumn(field: ArrowField, slot: number): string[] {
  const leaf = field.leaf!;
  const prop = BYTES(field.name);
  const variable = leaf.kind === 'utf8' || leaf.kind === 'binary';
  // Buffers arrive in field order: validity, then values, with offsets between
  // them for the variable-width layouts.
  // Slots hold (offset, length) pairs, so slot k lives at bufs[k * 2].
  const validity = slot * 2;
  const first = validity + 2;
  const second = first + 2;

  const lines = [
    `  // ${field.name}: ${leaf.arrow}`,
    `  {`,
    `    const validAt = body + bufs[${validity}];`,
    `    const validLen = bufs[${validity} + 1];`,
    `    const valid = (i) => validLen === 0 || (buf[validAt + (i >> 3)] & (1 << (i & 7))) !== 0;`,
  ];

  if (variable) {
    const decodeItem =
      leaf.kind === 'utf8'
        ? `textDecoder.decode(buf.subarray(valuesAt + from, valuesAt + to))`
        : `buf.slice(valuesAt + from, valuesAt + to)`;
    lines.push(
      `    const offsetsAt = body + bufs[${first}];`,
      `    const valuesAt = body + bufs[${second}];`,
      `    for (let i = 0; i < n; i++) {`,
      `      if (!valid(i)) { rows[i][${prop}] = null; continue; }`,
      `      const from = view.getInt32(offsetsAt + i * 4, true);`,
      `      const to = view.getInt32(offsetsAt + (i + 1) * 4, true);`,
      `      rows[i][${prop}] = ${decodeItem};`,
      `    }`
    );
  } else {
    const at = `valuesAt`;
    const read = (() => {
      // A 64-bit column reads back as a bigint unless the property is a number,
      // which `@format double-int` and `unixtime` both are: returning the wrong
      // JS type round-trips the value and loses the type.
      const wide = (getter: string) =>
        leaf.js === 'number'
          ? `Number(view.${getter}(${at} + i * 8, true))`
          : `view.${getter}(${at} + i * 8, true)`;

      switch (leaf.kind) {
        case 'bool':
          return `(buf[${at} + (i >> 3)] & (1 << (i & 7))) !== 0`;
        case 'timestamp':
          return `new Date(Number(view.getBigInt64(${at} + i * 8, true)))`;
        case 'float':
          return leaf.width === 32
            ? `view.getFloat32(${at} + i * 4, true)`
            : `view.getFloat64(${at} + i * 8, true)`;
        case 'uint':
          if (leaf.width === 64) {
            return wide('getBigUint64');
          }
          if (leaf.width === 8) {
            return `view.getUint8(${at} + i)`;
          }
          if (leaf.width === 16) {
            return `view.getUint16(${at} + i * 2, true)`;
          }
          return `view.getUint32(${at} + i * 4, true)`;
        default:
          if (leaf.width === 64) {
            return wide('getBigInt64');
          }
          if (leaf.width === 8) {
            return `view.getInt8(${at} + i)`;
          }
          if (leaf.width === 16) {
            return `view.getInt16(${at} + i * 2, true)`;
          }
          return `view.getInt32(${at} + i * 4, true)`;
      }
    })();
    lines.push(
      `    const valuesAt = body + bufs[${first}];`,
      `    for (let i = 0; i < n; i++) {`,
      `      rows[i][${prop}] = valid(i) ? ${read} : null;`,
      `    }`
    );
  }

  lines.push(`  }`);
  return lines;
}

/** A readable description of the columns, for `arrowSchema<[T]>()`. */
export function generateArrowSchemaCode(types: Array<{ name: string; ir: TypeIR }>): string {
  const documents = types.map(({ name, ir }) => {
    const blocker = arrowTypeBlocker(ir, name);
    if (blocker) {
      throw new Error(blocker);
    }
    return { name, ...(arrowSchemaJson(arrowFields(ir)) as object) };
  });
  const value = documents.length === 1 ? documents[0] : documents;

  return [
    `export function arrowSchema(options = {}) {`,
    `  const indent = options.indent ?? "  ";`,
    `  return JSON.stringify(${BYTES(value)}, null, indent);`,
    `}`,
  ].join('\n');
}
