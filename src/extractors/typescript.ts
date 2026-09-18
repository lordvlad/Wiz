import * as ts from "typescript";
import type {
  Annotated,
  ArrayTypeIR,
  Constraint,
  ConstraintKind,
  DeprecatedInfo,
  EnumMemberIR,
  IntersectionTypeIR,
  ObjectTypeIR,
  PropertyIR,
  RecordTypeIR,
  TupleElementIR,
  TupleTypeIR,
  TypeIR,
  UnionTypeIR,
} from "../ir/types.ts";
import { isUserNamedType } from "../ir/types.ts";

/**
 * Node ids are minted per extraction rather than per process, so extracting one
 * type twice yields equal IR — and therefore one structural hash and one
 * virtual module. The counter rides the extraction's own type cache, which
 * every top-level call creates fresh and threads through the recursion, and is
 * collected with it. A process-wide counter made the hash of any type holding a
 * `ref` depend on how much had been extracted before it.
 */
const extractionIds = new WeakMap<Map<ts.Type, TypeIR>, number>();

function nextId(cache: Map<ts.Type, TypeIR>): string {
  const id = (extractionIds.get(cache) ?? 0) + 1;
  extractionIds.set(cache, id);
  return `t_${id}`;
}

function displayPartsToString(
  parts: ts.SymbolDisplayPart[] | string | undefined
): string {
  if (!parts) return "";
  if (typeof parts === "string") return parts;
  return parts.map((p) => p.text).join("");
}
/**
 * Runtime classes every target treats as a scalar rather than a struct.
 * Their structural shape is a list of methods, which is never what a schema
 * should describe.
 */
const WELL_KNOWN_SCALARS: Record<string, "bytes" | "date"> = {
  Uint8Array: "bytes",
  Uint8ClampedArray: "bytes",
  ArrayBuffer: "bytes",
  SharedArrayBuffer: "bytes",
  Date: "date",
};

function parseJSDocValue(kind: ConstraintKind, text: string): unknown {
  const trimmed = text.trim();
  switch (kind) {
    case "min":
    case "minimum":
    case "max":
    case "maximum":
    case "exclusiveMinimum":
    case "exclusiveMaximum":
    case "minLength":
    case "maxLength":
    case "minItems":
    case "maxItems":
    case "multipleOf": {
      const num = Number(trimmed);
      return Number.isNaN(num) ? trimmed : num;
    }
    case "uniqueItems": {
      if (trimmed === "false") return false;
      return true;
    }
    case "pattern": {
      const match = trimmed.match(/^\/(.*)\/([gimsuyv]*)$/);
      if (match) {
        const body = match[1]!;
        return body.replace(/\\(?=\/)/g, "");
      }
      return trimmed;
    }
    case "format":
    default:
      return trimmed;
  }
}

/** Tags consumed elsewhere; they must not leak into `meta`. */
const HANDLED_TAGS = new Set(["deprecated", "fieldnumber", "id", "tag", "example", "default"]);

const CONSTRAINT_TAGS: Record<string, ConstraintKind> = {
  min: "minimum",
  minimum: "minimum",
  max: "maximum",
  maximum: "maximum",
  exclusiveminimum: "exclusiveMinimum",
  exclusivemaximum: "exclusiveMaximum",
  minlength: "minLength",
  maxlength: "maxLength",
  pattern: "pattern",
  format: "format",
  multipleof: "multipleOf",
  minitems: "minItems",
  maxitems: "maxItems",
  uniqueitems: "uniqueItems",
};

/** `@example { "id": 1 }` should land as an object, not the literal text. */
function parseAnnotationValue(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

export interface JSDocInfo extends Annotated {
  constraints: Constraint[];
  examples: unknown[];
  meta: Record<string, (string | true)[]>;
  fieldNumber?: number;
}

export function extractJSDocInfo(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker
): JSDocInfo {
  const constraints: Constraint[] = [];
  const examples: unknown[] = [];
  const meta: Record<string, (string | true)[]> = {};
  let deprecated: DeprecatedInfo | undefined;
  let description: string | undefined;
  let defaultValue: unknown;
  let fieldNumber: number | undefined;

  if (!symbol) {
    return { constraints, examples, meta };
  }

  const docComments = symbol.getDocumentationComment(checker);
  if (docComments && docComments.length > 0) {
    const docStr = displayPartsToString(docComments).trim();
    if (docStr) {
      description = docStr;
    }
  }

  // The checker drops `@fieldNumber` on some declarations, so the AST tags are
  // read too. Only that one tag is recovered here to keep the sources apart.
  if (symbol.declarations) {
    for (const decl of symbol.declarations) {
      for (const tag of ts.getJSDocTags(decl)) {
        const tagName = tag.tagName.text.toLowerCase();
        if (tagName !== "fieldnumber" && tagName !== "id" && tagName !== "tag") {
          continue;
        }
        const tagText = (
          typeof tag.comment === "string"
            ? tag.comment
            : (tag.comment ?? []).map((part) => part.text).join("")
        ).trim();
        const parsed = parseInt(tagText, 10);
        if (!Number.isNaN(parsed)) fieldNumber = parsed;
      }
    }
  }

  for (const tag of symbol.getJsDocTags(checker)) {
    const tagName = tag.name.toLowerCase();
    const tagText = displayPartsToString(tag.text).trim();

    if (tagName === "deprecated") {
      deprecated = { isDeprecated: true, note: tagText || undefined };
      continue;
    }

    if (tagName === "fieldnumber" || tagName === "id" || tagName === "tag") {
      const parsed = parseInt(tagText, 10);
      if (!Number.isNaN(parsed)) fieldNumber = parsed;
      continue;
    }

    if (tagName === "example") {
      examples.push(parseAnnotationValue(tagText));
      continue;
    }

    if (tagName === "default") {
      defaultValue = parseAnnotationValue(tagText);
      continue;
    }

    const constraintKind = CONSTRAINT_TAGS[tagName];
    if (constraintKind) {
      constraints.push({
        kind: constraintKind,
        value: parseJSDocValue(constraintKind, tagText),
      });
      continue;
    }

    // Anything wiz does not model is preserved rather than discarded.
    if (!HANDLED_TAGS.has(tagName)) {
      (meta[tag.name] ??= []).push(tagText === "" ? true : tagText);
    }
  }

  return {
    description,
    deprecated,
    constraints,
    examples,
    default: defaultValue,
    meta,
    fieldNumber,
  };
}

/**
 * The annotation fields every IR node carries, built once per extraction.
 * `name` is omitted rather than set to `undefined`, because this object is
 * spread last and would otherwise erase a name the caller already set.
 */
function annotationsOf(info: JSDocInfo, name?: string): Annotated & { name?: string } {
  return {
    ...(name === undefined ? {} : { name }),
    description: info.description,
    deprecated: info.deprecated,
    constraints: info.constraints.length > 0 ? info.constraints : undefined,
    examples: info.examples.length > 0 ? info.examples : undefined,
    default: info.default,
    meta: Object.keys(info.meta).length > 0 ? info.meta : undefined,
  };
}

export function extractTypeIR(
  type: ts.Type,
  checker: ts.TypeChecker,
  cache = new Map<ts.Type, TypeIR>()
): TypeIR {
  const existing = cache.get(type);
  if (existing) {
    if (existing.kind === "object" || existing.kind === "array" || existing.kind === "tuple") {
      return {
        id: nextId(cache),
        kind: "ref",
        targetId: existing.id,
        name: existing.name,
      };
    }
    return existing;
  }

  const symbol = type.aliasSymbol ?? type.symbol;
  const typeName = symbol && isUserNamedType(symbol.name) ? symbol.name : undefined;
  // Documentation on `Partial`/`Record`/... describes the utility, not this
  // type, so it must not leak into generated schemas.
  const jsDocInfo = typeName
    ? extractJSDocInfo(symbol, checker)
    : { constraints: [], examples: [], meta: {} };
  const annotations = annotationsOf(jsDocInfo, typeName);
  // Runtime classes that are scalars to every schema language we target.
  // Expanding them structurally yields a record of their own methods: a single
  // `Uint8Array` field otherwise produced 45 component schemas.
  const wellKnown = symbol ? WELL_KNOWN_SCALARS[symbol.name] : undefined;
  if (wellKnown) {
    const res: TypeIR = {
      id: nextId(cache),
      kind: "primitive",
      type: wellKnown,
      ...annotations,
      // The class name is not a domain schema name.
      name: undefined,
    };
    cache.set(type, res);
    return res;
  }

  // Primitive Boolean (union of true and false)
  if (type.flags & ts.TypeFlags.Boolean) {
    const res: TypeIR = {
      id: nextId(cache),
      kind: "primitive",
      type: "boolean",
      ...annotations,
    };
    cache.set(type, res);
    return res;
  }

  // String
  if (type.flags & ts.TypeFlags.String) {
    const res: TypeIR = {
      id: nextId(cache),
      kind: "primitive",
      type: "string",
      ...annotations,
    };
    cache.set(type, res);
    return res;
  }

  // Number
  if (type.flags & ts.TypeFlags.Number) {
    const res: TypeIR = {
      id: nextId(cache),
      kind: "primitive",
      type: "number",
      ...annotations,
    };
    cache.set(type, res);
    return res;
  }

  // BigInt
  if (type.flags & ts.TypeFlags.BigInt) {
    const res: TypeIR = {
      id: nextId(cache),
      kind: "primitive",
      type: "bigint",
      ...annotations,
    };
    cache.set(type, res);
    return res;
  }

  // Null
  if (type.flags & ts.TypeFlags.Null) {
    const res: TypeIR = { id: nextId(cache), kind: "primitive", type: "null" };
    cache.set(type, res);
    return res;
  }

  // Undefined
  if (type.flags & ts.TypeFlags.Undefined) {
    const res: TypeIR = { id: nextId(cache), kind: "primitive", type: "undefined" };
    cache.set(type, res);
    return res;
  }

  // Symbol
  if (type.flags & (ts.TypeFlags.ESSymbol | ts.TypeFlags.UniqueESSymbol)) {
    const res: TypeIR = { id: nextId(cache), kind: "primitive", type: "symbol" };
    cache.set(type, res);
    return res;
  }

  // Unknown
  if (type.flags & ts.TypeFlags.Unknown) {
    const res: TypeIR = { id: nextId(cache), kind: "primitive", type: "unknown" };
    cache.set(type, res);
    return res;
  }

  // Any
  if (type.flags & ts.TypeFlags.Any) {
    const res: TypeIR = { id: nextId(cache), kind: "primitive", type: "any" };
    cache.set(type, res);
    return res;
  }

  // Void
  if (type.flags & ts.TypeFlags.Void) {
    const res: TypeIR = { id: nextId(cache), kind: "primitive", type: "void" };
    cache.set(type, res);
    return res;
  }

  // Never
  if (type.flags & ts.TypeFlags.Never) {
    const res: TypeIR = { id: nextId(cache), kind: "primitive", type: "never" };
    cache.set(type, res);
    return res;
  }

  // Literals
  if (type.isStringLiteral()) {
    const res: TypeIR = {
      id: nextId(cache),
      kind: "literal",
      value: type.value,
      ...annotations,
    };
    cache.set(type, res);
    return res;
  }

  if (type.isNumberLiteral()) {
    const res: TypeIR = {
      id: nextId(cache),
      kind: "literal",
      value: type.value,
      ...annotations,
    };
    cache.set(type, res);
    return res;
  }

  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    const isTrue = "intrinsicName" in type && (type as ts.Type & { intrinsicName?: string }).intrinsicName === "true";
    const res: TypeIR = {
      id: nextId(cache),
      kind: "literal",
      value: isTrue,
      ...annotations,
    };
    cache.set(type, res);
    return res;
  }

  if (type.flags & ts.TypeFlags.BigIntLiteral) {
    const bigintVal = (type as ts.BigIntLiteralType).value;
    const res: TypeIR = {
      id: nextId(cache),
      kind: "literal",
      value: BigInt(`${bigintVal.negative ? "-" : ""}${bigintVal.base10Value}`),
      ...annotations,
    };
    cache.set(type, res);
    return res;
  }

  // Enums
  if (symbol && (symbol.flags & ts.SymbolFlags.Enum)) {
    const members: EnumMemberIR[] = [];
    if (symbol.exports) {
      symbol.exports.forEach((memberSymbol) => {
        const valueDecl = memberSymbol.valueDeclaration;
        let value: string | number = memberSymbol.name;
        if (valueDecl && ts.isEnumMember(valueDecl) && valueDecl.initializer) {
          const initType = checker.getTypeAtLocation(valueDecl.initializer);
          if (initType.isStringLiteral() || initType.isNumberLiteral()) {
            value = initType.value;
          }
        }
        members.push({ name: memberSymbol.name, value });
      });
    }
    const res: TypeIR = {
      id: nextId(cache),
      kind: "enum",
      name: typeName,
      members,
      ...annotations,
    };
    cache.set(type, res);
    return res;
  }

  // Arrays
  if (checker.isArrayType(type)) {
    const typeArgs = checker.getTypeArguments(type as ts.TypeReference);
    const elemType = typeArgs[0] ?? checker.getAnyType();
    const placeholder: ArrayTypeIR = {
      id: nextId(cache),
      kind: "array",
      element: { id: "placeholder", kind: "primitive", type: "any" },
      name: typeName,
      ...annotations,
    };
    cache.set(type, placeholder);

    const elemIR = extractTypeIR(elemType, checker, cache);
    placeholder.element = elemIR;
    return placeholder;
  }

  // Tuples
  if (checker.isTupleType(type)) {
    const typeArgs = checker.getTypeArguments(type as ts.TypeReference);
    const target = (type as ts.TypeReference).target as ts.TupleType;
    const elementFlags = target?.elementFlags ?? [];

    const placeholder: TupleTypeIR = {
      id: nextId(cache),
      kind: "tuple",
      elements: [],
      name: typeName,
      ...annotations,
    };
    cache.set(type, placeholder);

    const elements: TupleElementIR[] = typeArgs.map((argType, idx) => {
      const flags = elementFlags[idx] ?? ts.ElementFlags.Required;
      const isOptional = (flags & ts.ElementFlags.Optional) !== 0;
      return {
        type: extractTypeIR(argType, checker, cache),
        optional: isOptional,
      };
    });

    placeholder.elements = elements;
    return placeholder;
  }

  // Unions
function findDiscriminatorProperty(types: TypeIR[]): { propertyName: string } | undefined {
  const objectTypes = types.filter((t): t is ObjectTypeIR => t.kind === "object");
  if (objectTypes.length !== types.length || objectTypes.length < 2) {
    return undefined;
  }

  const firstObj = objectTypes[0]!;
  const candidateProps = firstObj.properties.filter(
    (p) => !p.optional && p.type.kind === "literal"
  );

  for (const candidate of candidateProps) {
    const propName = candidate.name;
    const seenValues = new Set<unknown>();
    let isValid = true;

    for (const obj of objectTypes) {
      const matchProp = obj.properties.find((p) => p.name === propName);
      if (!matchProp || matchProp.optional || matchProp.type.kind !== "literal") {
        isValid = false;
        break;
      }
      const litVal = matchProp.type.value;
      if (seenValues.has(litVal)) {
        isValid = false;
        break;
      }
      seenValues.add(litVal);
    }

    if (isValid) {
      return { propertyName: propName };
    }
  }

  return undefined;
}
/**
 * Reads `NumberedUnion<{ 1: A; 2: B }>` off a type node.
 *
 * The numbering cannot be recovered from the resolved type: TypeScript resolves
 * the helper to a plain union and records only the outermost alias, so the map
 * survives on the declaration alone. One level of naming is followed, which is
 * what `type Shape = NumberedUnion<...>` plus `shape: Shape` needs.
 */
function numberedUnionEntries(
  node: ts.TypeNode | undefined,
  checker: ts.TypeChecker,
  depth = 0
): Array<{ fieldNumber: number; type: ts.Type }> | undefined {
  if (!node || depth > 8 || !ts.isTypeReferenceNode(node)) return undefined;

  if (node.typeName.getText() !== "NumberedUnion") {
    // A named alias standing in for the helper; resolve it and look again.
    let symbol = checker.getSymbolAtLocation(node.typeName);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
      symbol = checker.getAliasedSymbol(symbol);
    }
    const declaration = symbol?.declarations?.[0];
    return declaration && ts.isTypeAliasDeclaration(declaration)
      ? numberedUnionEntries(declaration.type, checker, depth + 1)
      : undefined;
  }

  const map = node.typeArguments?.[0];
  if (!map || !ts.isTypeLiteralNode(map)) return undefined;

  const entries: Array<{ fieldNumber: number; type: ts.Type }> = [];
  for (const member of map.members) {
    if (!ts.isPropertySignature(member) || !member.type) return undefined;
    const fieldNumber = Number(member.name.getText());
    if (!Number.isInteger(fieldNumber) || fieldNumber < 1) return undefined;
    entries.push({
      fieldNumber,
      type: checker.getTypeFromTypeNode(member.type),
    });
  }
  return entries.length > 0 ? entries : undefined;
}

/**
 * The enum every non-nullable member of `type` belongs to, when there is
 * exactly one and the union covers nothing else.
 *
 * A partial union — `PetStatus.Sold | PetStatus.Pending` written by hand, or an
 * enum member mixed with a string — is deliberately not an enum: collapsing it
 * would widen the type to values the declaration excluded.
 */
function sharedEnumSymbol(
  type: ts.UnionType,
  checker: ts.TypeChecker
): ts.Symbol | undefined {
  const members = type.types.filter(
    (member) => !(member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null))
  );
  if (members.length === 0) return undefined;

  let owner: ts.Symbol | undefined;
  for (const member of members) {
    if (!(member.flags & ts.TypeFlags.EnumLiteral)) return undefined;
    const parent = (member.symbol as ts.Symbol & { parent?: ts.Symbol })?.parent;
    if (!parent || !(parent.flags & ts.SymbolFlags.Enum)) return undefined;
    if (owner && owner !== parent) return undefined;
    owner ??= parent;
  }
  if (!owner) return undefined;

  // Every member of the enum must be present, or the union is a subset.
  const declared = checker.getDeclaredTypeOfSymbol(owner);
  const declaredCount = declared.isUnion() ? declared.types.length : 1;
  return members.length === declaredCount ? owner : undefined;
}
  // `status?: PetStatus` reaches here as `Available | Pending | Sold |
  // undefined`: TypeScript models an enum as the union of its members, and the
  // optional marker hides the enum's own symbol. Decomposing that yields one
  // named `const` schema per member and loses the enum, so the parent enum is
  // recovered before the union is taken apart.
  if (type.isUnion()) {
    const enumSymbol = sharedEnumSymbol(type, checker);
    if (enumSymbol) {
      const enumType = checker.getDeclaredTypeOfSymbol(enumSymbol);
      const enumIR = extractTypeIR(enumType, checker, cache);
      const nullable = type.types.filter((member) =>
        Boolean(member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null))
      );
      if (nullable.length === 0) {
        cache.set(type, enumIR);
        return enumIR;
      }
      const res: UnionTypeIR = {
        id: nextId(cache),
        kind: "union",
        types: [
          enumIR,
          ...nullable.map((member) => extractTypeIR(member, checker, cache)),
        ],
        name: typeName,
        ...annotations,
      };
      cache.set(type, res);
      return res;
    }
  }

  if (type.isUnion()) {
    const placeholder: UnionTypeIR = {
      id: nextId(cache),
      kind: "union",
      types: [],
      name: typeName,
      ...annotations,
    };
    cache.set(type, placeholder);

    // A `NumberedUnion` is built from its declared entries rather than from
    // `type.types`, so members stay positionally paired with their numbers.
    const aliasDeclaration = type.aliasSymbol?.declarations?.[0];
    const numbered =
      aliasDeclaration && ts.isTypeAliasDeclaration(aliasDeclaration)
        ? numberedUnionEntries(aliasDeclaration.type, checker)
        : undefined;

    const typesIR = (numbered?.map((e) => e.type) ?? type.types).map((subType) =>
      extractTypeIR(subType, checker, cache)
    );
    placeholder.types = typesIR;
    if (numbered) placeholder.fieldNumbers = numbered.map((e) => e.fieldNumber);
    placeholder.discriminator = findDiscriminatorProperty(typesIR);
    return placeholder;
  }

  // Intersections
  if (type.isIntersection()) {
    const placeholder: IntersectionTypeIR = {
      id: nextId(cache),
      kind: "intersection",
      types: [],
      name: typeName,
      ...annotations,
    };
    cache.set(type, placeholder);

    const typesIR = type.types.map((subType) => extractTypeIR(subType, checker, cache));
    placeholder.types = typesIR;
    return placeholder;
  }

  // Index Signatures / Records vs Objects
  const stringIndexType = checker.getIndexTypeOfType(type, ts.IndexKind.String);
  const numberIndexType = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  const properties = type.getProperties();

  if ((stringIndexType || numberIndexType) && properties.length === 0) {
    const valType = stringIndexType || numberIndexType!;
    const placeholder: RecordTypeIR = {
      id: nextId(cache),
      kind: "record",
      keyType: {
        id: nextId(cache),
        kind: "primitive",
        type: stringIndexType ? "string" : "number",
      },
      valueType: { id: "placeholder", kind: "primitive", type: "any" },
      name: typeName,
      ...annotations,
    };
    cache.set(type, placeholder);

    const valIR = extractTypeIR(valType, checker, cache);
    placeholder.valueType = valIR;
    return placeholder;
  }

  // Objects & Interfaces
  const objectPlaceholder: ObjectTypeIR = {
    id: nextId(cache),
    kind: "object",
    properties: [],
    additionalProperties: stringIndexType ? true : undefined,
    ...annotations,
  };
  cache.set(type, objectPlaceholder);

  const propIRs: PropertyIR[] = [];
  for (const propSymbol of properties) {
    const propDecl = propSymbol.valueDeclaration ?? propSymbol.declarations?.[0];
    const propType = propDecl
      ? checker.getTypeOfSymbolAtLocation(propSymbol, propDecl)
      : checker.getAnyType();

    const isOptional = (propSymbol.flags & ts.SymbolFlags.Optional) !== 0 ||
      (propDecl && ts.isPropertySignature(propDecl) && Boolean(propDecl.questionToken));

    let isReadonly = false;
    if (propDecl) {
      const modifierFlags = ts.getCombinedModifierFlags(propDecl);
      isReadonly = (modifierFlags & ts.ModifierFlags.Readonly) !== 0;
    }

    const propDocInfo = extractJSDocInfo(propSymbol, checker);
    let propTypeIR = extractTypeIR(propType, checker, cache);

    // `shape?: Shape` widens to `Circle | Square | undefined`, a fresh union
    // carrying no alias, so the numbering is recovered from the annotation.
    // The result is deliberately not cached: the numbering belongs to this
    // declaration, while the widened union type is shared.
    if (propTypeIR.kind === "union" && propTypeIR.fieldNumbers === undefined) {
      const declaredType = propDecl && ts.isPropertySignature(propDecl) ? propDecl.type : undefined;
      const numbered = numberedUnionEntries(declaredType, checker);
      if (numbered) {
        const types = numbered.map((e) => extractTypeIR(e.type, checker, cache));
        propTypeIR = {
          ...propTypeIR,
          id: nextId(cache),
          types,
          fieldNumbers: numbered.map((e) => e.fieldNumber),
          discriminator: findDiscriminatorProperty(types),
        };
      }
    }

    propIRs.push({
      name: propSymbol.name,
      type: propTypeIR,
      optional: Boolean(isOptional),
      readonly: isReadonly,
      fieldNumber: propDocInfo.fieldNumber,
      ...annotationsOf(propDocInfo),
    });
  }

  if (stringIndexType) {
    const indexIR = extractTypeIR(stringIndexType, checker, cache);
    objectPlaceholder.additionalProperties = indexIR;
  }

  objectPlaceholder.properties = propIRs;
  return objectPlaceholder;
}
