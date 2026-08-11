import ts from "typescript";
import type {
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
} from "./types.ts";
import { isUserNamedType } from "./types.ts";

let idCounter = 0;
function nextId(): string {
  return `t_${++idCounter}`;
}

function displayPartsToString(
  parts: ts.SymbolDisplayPart[] | string | undefined
): string {
  if (!parts) return "";
  if (typeof parts === "string") return parts;
  return parts.map((p) => p.text).join("");
}

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
    case "default": {
      try {
        return JSON.parse(trimmed);
      } catch {
        return trimmed;
      }
    }
    case "pattern":
    case "format":
    default:
      return trimmed;
  }
}

function extractJSDocInfo(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker
): {
  description?: string;
  deprecated?: DeprecatedInfo;
  constraints: Constraint[];
  fieldNumber?: number;
} {
  const constraints: Constraint[] = [];
  let deprecated: DeprecatedInfo | undefined;
  let description: string | undefined;
  let fieldNumber: number | undefined;
  if (!symbol) {
    return { constraints };
  }

  const docComments = symbol.getDocumentationComment(checker);
  if (docComments && docComments.length > 0) {
    const docStr = displayPartsToString(docComments).trim();
    if (docStr) {
      description = docStr;
    }
  }
  if (symbol.declarations) {
    for (const decl of symbol.declarations) {
      const astTags = ts.getJSDocTags(decl);
      for (const tag of astTags) {
        const tagName = tag.tagName.text.toLowerCase();
        const tagText = (
          typeof tag.comment === "string"
            ? tag.comment
            : (tag.comment ?? []).map((part) => part.text).join("")
        ).trim();

        if (tagName === "fieldnumber" || tagName === "id" || tagName === "tag") {
          const parsedFn = parseInt(tagText, 10);
          if (!Number.isNaN(parsedFn)) {
            fieldNumber = parsedFn;
          }
        }
      }
    }
  }

  const jsDocTags = symbol.getJsDocTags(checker);
  for (const tag of jsDocTags) {
    const tagName = tag.name.toLowerCase();
    const tagText = displayPartsToString(tag.text).trim();

    if (tagName === "deprecated") {
      deprecated = {
        isDeprecated: true,
        note: tagText || undefined,
      };
      continue;
    }

    if (tagName === "fieldnumber" || tagName === "id" || tagName === "tag") {
      const parsedFn = parseInt(tagText, 10);
      if (!Number.isNaN(parsedFn)) {
        fieldNumber = parsedFn;
      }
      continue;
    }

    const tagKindMap: Record<string, ConstraintKind> = {
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
      default: "default",
      multipleof: "multipleOf",
      minitems: "minItems",
      maxitems: "maxItems",
      uniqueitems: "uniqueItems",
    };

    const mappedKind = tagKindMap[tagName];
    if (mappedKind) {
      const val = parseJSDocValue(mappedKind, tagText);
      constraints.push({ kind: mappedKind, value: val });
    }
  }

  return { description, deprecated, constraints, fieldNumber };
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
        id: nextId(),
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
    : { constraints: [] as Constraint[] };

  // Primitive Boolean (union of true and false)
  if (type.flags & ts.TypeFlags.Boolean) {
    const res: TypeIR = {
      id: nextId(),
      kind: "primitive",
      type: "boolean",
      name: typeName,
      description: jsDocInfo.description,
      deprecated: jsDocInfo.deprecated,
      constraints: jsDocInfo.constraints.length > 0 ? jsDocInfo.constraints : undefined,
    };
    cache.set(type, res);
    return res;
  }

  // String
  if (type.flags & ts.TypeFlags.String) {
    const res: TypeIR = {
      id: nextId(),
      kind: "primitive",
      type: "string",
      name: typeName,
      description: jsDocInfo.description,
      deprecated: jsDocInfo.deprecated,
      constraints: jsDocInfo.constraints.length > 0 ? jsDocInfo.constraints : undefined,
    };
    cache.set(type, res);
    return res;
  }

  // Number
  if (type.flags & ts.TypeFlags.Number) {
    const res: TypeIR = {
      id: nextId(),
      kind: "primitive",
      type: "number",
      name: typeName,
      description: jsDocInfo.description,
      deprecated: jsDocInfo.deprecated,
      constraints: jsDocInfo.constraints.length > 0 ? jsDocInfo.constraints : undefined,
    };
    cache.set(type, res);
    return res;
  }

  // BigInt
  if (type.flags & ts.TypeFlags.BigInt) {
    const res: TypeIR = {
      id: nextId(),
      kind: "primitive",
      type: "bigint",
      name: typeName,
      description: jsDocInfo.description,
      deprecated: jsDocInfo.deprecated,
      constraints: jsDocInfo.constraints.length > 0 ? jsDocInfo.constraints : undefined,
    };
    cache.set(type, res);
    return res;
  }

  // Null
  if (type.flags & ts.TypeFlags.Null) {
    const res: TypeIR = { id: nextId(), kind: "primitive", type: "null" };
    cache.set(type, res);
    return res;
  }

  // Undefined
  if (type.flags & ts.TypeFlags.Undefined) {
    const res: TypeIR = { id: nextId(), kind: "primitive", type: "undefined" };
    cache.set(type, res);
    return res;
  }

  // Symbol
  if (type.flags & (ts.TypeFlags.ESSymbol | ts.TypeFlags.UniqueESSymbol)) {
    const res: TypeIR = { id: nextId(), kind: "primitive", type: "symbol" };
    cache.set(type, res);
    return res;
  }

  // Unknown
  if (type.flags & ts.TypeFlags.Unknown) {
    const res: TypeIR = { id: nextId(), kind: "primitive", type: "unknown" };
    cache.set(type, res);
    return res;
  }

  // Any
  if (type.flags & ts.TypeFlags.Any) {
    const res: TypeIR = { id: nextId(), kind: "primitive", type: "any" };
    cache.set(type, res);
    return res;
  }

  // Void
  if (type.flags & ts.TypeFlags.Void) {
    const res: TypeIR = { id: nextId(), kind: "primitive", type: "void" };
    cache.set(type, res);
    return res;
  }

  // Never
  if (type.flags & ts.TypeFlags.Never) {
    const res: TypeIR = { id: nextId(), kind: "primitive", type: "never" };
    cache.set(type, res);
    return res;
  }

  // Literals
  if (type.isStringLiteral()) {
    const res: TypeIR = {
      id: nextId(),
      kind: "literal",
      value: type.value,
      description: jsDocInfo.description,
      deprecated: jsDocInfo.deprecated,
      constraints: jsDocInfo.constraints.length > 0 ? jsDocInfo.constraints : undefined,
    };
    cache.set(type, res);
    return res;
  }

  if (type.isNumberLiteral()) {
    const res: TypeIR = {
      id: nextId(),
      kind: "literal",
      value: type.value,
      description: jsDocInfo.description,
      deprecated: jsDocInfo.deprecated,
      constraints: jsDocInfo.constraints.length > 0 ? jsDocInfo.constraints : undefined,
    };
    cache.set(type, res);
    return res;
  }

  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    const isTrue = "intrinsicName" in type && (type as ts.Type & { intrinsicName?: string }).intrinsicName === "true";
    const res: TypeIR = {
      id: nextId(),
      kind: "literal",
      value: isTrue,
      description: jsDocInfo.description,
      deprecated: jsDocInfo.deprecated,
      constraints: jsDocInfo.constraints.length > 0 ? jsDocInfo.constraints : undefined,
    };
    cache.set(type, res);
    return res;
  }

  if (type.flags & ts.TypeFlags.BigIntLiteral) {
    const bigintVal = (type as ts.BigIntLiteralType).value;
    const res: TypeIR = {
      id: nextId(),
      kind: "literal",
      value: BigInt(`${bigintVal.negative ? "-" : ""}${bigintVal.base10Value}`),
      description: jsDocInfo.description,
      deprecated: jsDocInfo.deprecated,
      constraints: jsDocInfo.constraints.length > 0 ? jsDocInfo.constraints : undefined,
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
      id: nextId(),
      kind: "enum",
      name: typeName,
      members,
      description: jsDocInfo.description,
      deprecated: jsDocInfo.deprecated,
    };
    cache.set(type, res);
    return res;
  }

  // Arrays
  if (checker.isArrayType(type)) {
    const typeArgs = checker.getTypeArguments(type as ts.TypeReference);
    const elemType = typeArgs[0] ?? checker.getAnyType();
    const placeholder: ArrayTypeIR = {
      id: nextId(),
      kind: "array",
      element: { id: "placeholder", kind: "primitive", type: "any" },
      name: typeName,
      description: jsDocInfo.description,
      deprecated: jsDocInfo.deprecated,
      constraints: jsDocInfo.constraints.length > 0 ? jsDocInfo.constraints : undefined,
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
      id: nextId(),
      kind: "tuple",
      elements: [],
      name: typeName,
      description: jsDocInfo.description,
      deprecated: jsDocInfo.deprecated,
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
  if (type.isUnion()) {
    const placeholder: UnionTypeIR = {
      id: nextId(),
      kind: "union",
      types: [],
      name: typeName,
      description: jsDocInfo.description,
      deprecated: jsDocInfo.deprecated,
    };
    cache.set(type, placeholder);

    const typesIR = type.types.map((subType) => extractTypeIR(subType, checker, cache));
    placeholder.types = typesIR;
    placeholder.discriminator = findDiscriminatorProperty(typesIR);
    return placeholder;
  }

  // Intersections
  if (type.isIntersection()) {
    const placeholder: IntersectionTypeIR = {
      id: nextId(),
      kind: "intersection",
      types: [],
      name: typeName,
      description: jsDocInfo.description,
      deprecated: jsDocInfo.deprecated,
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
      id: nextId(),
      kind: "record",
      keyType: {
        id: nextId(),
        kind: "primitive",
        type: stringIndexType ? "string" : "number",
      },
      valueType: { id: "placeholder", kind: "primitive", type: "any" },
      name: typeName,
      description: jsDocInfo.description,
      deprecated: jsDocInfo.deprecated,
    };
    cache.set(type, placeholder);

    const valIR = extractTypeIR(valType, checker, cache);
    placeholder.valueType = valIR;
    return placeholder;
  }

  // Objects & Interfaces
  const objectPlaceholder: ObjectTypeIR = {
    id: nextId(),
    kind: "object",
    properties: [],
    additionalProperties: stringIndexType ? true : undefined,
    name: typeName,
    description: jsDocInfo.description,
    deprecated: jsDocInfo.deprecated,
    constraints: jsDocInfo.constraints.length > 0 ? jsDocInfo.constraints : undefined,
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
    const propTypeIR = extractTypeIR(propType, checker, cache);

    propIRs.push({
      name: propSymbol.name,
      type: propTypeIR,
      optional: Boolean(isOptional),
      readonly: isReadonly,
      fieldNumber: propDocInfo.fieldNumber,
      description: propDocInfo.description,
      deprecated: propDocInfo.deprecated,
      constraints: propDocInfo.constraints.length > 0 ? propDocInfo.constraints : undefined,
    });
  }

  if (stringIndexType) {
    const indexIR = extractTypeIR(stringIndexType, checker, cache);
    objectPlaceholder.additionalProperties = indexIR;
  }

  objectPlaceholder.properties = propIRs;
  return objectPlaceholder;
}
