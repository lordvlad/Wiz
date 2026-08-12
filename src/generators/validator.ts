import type { Constraint, ObjectTypeIR, PropertyIR, TypeIR } from "../types.ts";

/** A JS boolean expression testing whether `varName` matches `ir`. */
export function generateTypeCheckExpression(ir: TypeIR, varName: string): string {
  switch (ir.kind) {
    case "primitive":
      switch (ir.type) {
        case "string":
          return `typeof ${varName} === "string"`;
        case "number":
          return `typeof ${varName} === "number" && !Number.isNaN(${varName})`;
        case "boolean":
          return `typeof ${varName} === "boolean"`;
        case "bigint":
          return `typeof ${varName} === "bigint"`;
        case "null":
          return `${varName} === null`;
        case "undefined":
          return `${varName} === undefined`;
        case "symbol":
          return `typeof ${varName} === "symbol"`;
        case "bytes":
          return `${varName} instanceof Uint8Array || ${varName} instanceof ArrayBuffer`;
        case "date":
          return `${varName} instanceof Date && !Number.isNaN(${varName}.getTime())`;
        case "unknown":
        case "any":
          return `true`;
        case "void":
        case "never":
          return `${varName} === undefined`;
      }
      return `true`;

    case "literal":
      if (typeof ir.value === "bigint") {
        return `${varName} === BigInt(${JSON.stringify(ir.value.toString())})`;
      }
      return `${varName} === ${JSON.stringify(ir.value)}`;

    case "enum": {
      const allowed = ir.members.map((m) => m.value);
      return `${JSON.stringify(allowed)}.includes(${varName})`;
    }

    case "object":
      return `${varName} !== null && typeof ${varName} === "object" && !Array.isArray(${varName})`;

    case "array":
    case "tuple":
      return `Array.isArray(${varName})`;

    case "record":
      return `${varName} !== null && typeof ${varName} === "object" && !Array.isArray(${varName})`;

    case "union": {
      const checks = ir.types.map((t) => generateTypeCheckExpression(t, varName));
      return `(${checks.join(" || ")})`;
    }

    case "intersection": {
      const checks = ir.types.map((t) => generateTypeCheckExpression(t, varName));
      return `(${checks.join(" && ")})`;
    }

    case "ref":
      return `true`;
  }
}

function generateConstraintCheckStatements(
  constraints: Constraint[] | undefined,
  varName: string,
  pathVar: string
): string[] {
  if (!constraints || constraints.length === 0) return [];
  const statements: string[] = [];

  for (const c of constraints) {
    const val = c.value;
    const jsonVal = JSON.stringify(val);

    switch (c.kind) {
      case "min":
      case "minimum":
        statements.push(
          `if (${varName} < ${jsonVal}) errors.push({ path: ${pathVar}, message: "Expected value >= " + ${jsonVal}, constraint: "minimum", expected: ">= " + ${jsonVal}, actual: ${varName} });`
        );
        break;
      case "max":
      case "maximum":
        statements.push(
          `if (${varName} > ${jsonVal}) errors.push({ path: ${pathVar}, message: "Expected value <= " + ${jsonVal}, constraint: "maximum", expected: "<= " + ${jsonVal}, actual: ${varName} });`
        );
        break;
      case "exclusiveMinimum":
        statements.push(
          `if (${varName} <= ${jsonVal}) errors.push({ path: ${pathVar}, message: "Expected value > " + ${jsonVal}, constraint: "exclusiveMinimum", expected: "> " + ${jsonVal}, actual: ${varName} });`
        );
        break;
      case "exclusiveMaximum":
        statements.push(
          `if (${varName} >= ${jsonVal}) errors.push({ path: ${pathVar}, message: "Expected value < " + ${jsonVal}, constraint: "exclusiveMaximum", expected: "< " + ${jsonVal}, actual: ${varName} });`
        );
        break;
      case "minLength":
        statements.push(
          `if (typeof ${varName} === "string" && __wizLength(${varName}) < ${jsonVal}) errors.push({ path: ${pathVar}, message: "Expected length >= " + ${jsonVal}, constraint: "minLength", expected: ">= " + ${jsonVal}, actual: __wizLength(${varName}) });`
        );
        break;
      case "maxLength":
        statements.push(
          `if (typeof ${varName} === "string" && __wizLength(${varName}) > ${jsonVal}) errors.push({ path: ${pathVar}, message: "Expected length <= " + ${jsonVal}, constraint: "maxLength", expected: "<= " + ${jsonVal}, actual: __wizLength(${varName}) });`
        );
        break;
      case "pattern":
        statements.push(
          `if (typeof ${varName} === "string" && !__wizPattern(${jsonVal}).test(${varName})) errors.push({ path: ${pathVar}, message: "Expected string matching pattern " + ${jsonVal}, constraint: "pattern", expected: ${jsonVal}, actual: ${varName} });`
        );
        break;
      case "format": {
        if (val === "email") {
          statements.push(
            `if (typeof ${varName} === "string" && !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(${varName})) errors.push({ path: ${pathVar}, message: "Invalid email format", constraint: "format", expected: "email", actual: ${varName} });`
          );
        } else if (val === "uuid") {
          statements.push(
            `if (typeof ${varName} === "string" && !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(${varName})) errors.push({ path: ${pathVar}, message: "Invalid UUID format", constraint: "format", expected: "uuid", actual: ${varName} });`
          );
        }
        break;
      }
      case "minItems":
        statements.push(
          `if (Array.isArray(${varName}) && ${varName}.length < ${jsonVal}) errors.push({ path: ${pathVar}, message: "Expected array items count >= " + ${jsonVal}, constraint: "minItems", expected: ">= " + ${jsonVal}, actual: ${varName}.length });`
        );
        break;
      case "maxItems":
        statements.push(
          `if (Array.isArray(${varName}) && ${varName}.length > ${jsonVal}) errors.push({ path: ${pathVar}, message: "Expected array items count <= " + ${jsonVal}, constraint: "maxItems", expected: "<= " + ${jsonVal}, actual: ${varName}.length });`
        );
        break;
      case "multipleOf":
        // Integer division rather than a remainder, matching JSON Schema and
        // Ajv: `0.3 % 0.1` is not 0 in binary floating point, and a tolerance
        // here would accept values the schema rejects.
        statements.push(
          `if (typeof ${varName} === "number" && !Number.isInteger(${varName} / ${jsonVal})) errors.push({ path: ${pathVar}, message: "Expected a multiple of " + ${jsonVal}, constraint: "multipleOf", expected: "multiple of " + ${jsonVal}, actual: ${varName} });`
        );
        break;
      case "uniqueItems":
        // `@uniqueItems false` states no requirement, so it must not impose one.
        if (val === false) break;
        statements.push(
          `if (Array.isArray(${varName}) && !__wizUnique(${varName})) errors.push({ path: ${pathVar}, message: "Array items must be unique", constraint: "uniqueItems", actual: ${varName} });`
        );
        break;
    }
  }

  return statements;
}

function generateValidationBlock(
  ir: TypeIR,
  varName: string,
  pathVar: string,
  depth = 0
): string {
  const lines: string[] = [];

  switch (ir.kind) {
    case "primitive":
    case "literal":
    case "enum": {
      const checkExpr = generateTypeCheckExpression(ir, varName);
      lines.push(`if (!(${checkExpr})) {`);
      lines.push(
        `  errors.push({ path: ${pathVar}, message: "Expected ${ir.kind} matching specification", expected: ${JSON.stringify(ir.kind)}, actual: ${varName} });`
      );
      lines.push(`} else {`);
      const constraintChecks = generateConstraintCheckStatements(ir.constraints, varName, pathVar);
      for (const st of constraintChecks) {
        lines.push(`  ${st}`);
      }
      lines.push(`}`);
      break;
    }

    case "object": {
      lines.push(`if (${varName} === null || typeof ${varName} !== "object" || Array.isArray(${varName})) {`);
      lines.push(
        `  errors.push({ path: ${pathVar}, message: "Expected object", expected: "object", actual: ${varName} === null ? "null" : typeof ${varName} });`
      );
      lines.push(`} else {`);

      const propConstraintChecks = generateConstraintCheckStatements(ir.constraints, varName, pathVar);
      for (const st of propConstraintChecks) {
        lines.push(`  ${st}`);
      }

      for (const prop of ir.properties) {
        const propVar = `v_${depth}_${prop.name.replace(/[^a-zA-Z0-9]/g, "_")}`;
        const propPathVar = `p_${depth}_${prop.name.replace(/[^a-zA-Z0-9]/g, "_")}`;

        lines.push(`  const ${propPathVar} = ${pathVar} ? ${pathVar} + "." + ${JSON.stringify(prop.name)} : ${JSON.stringify(prop.name)};`);
        lines.push(`  const ${propVar} = ${varName}[${JSON.stringify(prop.name)}];`);

        if (prop.optional) {
          lines.push(`  if (${propVar} !== undefined) {`);
          lines.push(
            generateValidationBlock(prop.type, propVar, propPathVar, depth + 1)
              .split("\n")
              .map((l) => "    " + l)
              .join("\n")
          );
          const propConstraints = generateConstraintCheckStatements(prop.constraints, propVar, propPathVar);
          for (const st of propConstraints) {
            lines.push(`    ${st}`);
          }
          lines.push(`  }`);
        } else {
          lines.push(`  if (${propVar} === undefined) {`);
          lines.push(
            `    errors.push({ path: ${propPathVar}, message: "Required property is missing", constraint: "required", expected: "defined", actual: undefined });`
          );
          lines.push(`  } else {`);
          lines.push(
            generateValidationBlock(prop.type, propVar, propPathVar, depth + 1)
              .split("\n")
              .map((l) => "    " + l)
              .join("\n")
          );
          const propConstraints = generateConstraintCheckStatements(prop.constraints, propVar, propPathVar);
          for (const st of propConstraints) {
            lines.push(`    ${st}`);
          }
          lines.push(`  }`);
        }
      }

      lines.push(`}`);
      break;
    }

    case "array": {
      lines.push(`if (!Array.isArray(${varName})) {`);
      lines.push(
        `  errors.push({ path: ${pathVar}, message: "Expected array", expected: "array", actual: typeof ${varName} });`
      );
      lines.push(`} else {`);

      const arrConstraints = generateConstraintCheckStatements(ir.constraints, varName, pathVar);
      for (const st of arrConstraints) {
        lines.push(`  ${st}`);
      }

      const elemVar = `elem_${depth}`;
      const idxVar = `i_${depth}`;
      const elemPathVar = `elemPath_${depth}`;

      lines.push(`  for (let ${idxVar} = 0; ${idxVar} < ${varName}.length; ${idxVar}++) {`);
      lines.push(`    const ${elemVar} = ${varName}[${idxVar}];`);
      lines.push(`    const ${elemPathVar} = (${pathVar} ? ${pathVar} : "") + "[" + ${idxVar} + "]";`);
      lines.push(
        generateValidationBlock(ir.element, elemVar, elemPathVar, depth + 1)
          .split("\n")
          .map((l) => "    " + l)
          .join("\n")
      );
      lines.push(`  }`);
      lines.push(`}`);
      break;
    }

    case "tuple": {
      lines.push(`if (!Array.isArray(${varName})) {`);
      lines.push(
        `  errors.push({ path: ${pathVar}, message: "Expected tuple array", expected: "array", actual: typeof ${varName} });`
      );
      lines.push(`} else {`);

      ir.elements.forEach((elem, idx) => {
        const elemVar = `tuple_${depth}_${idx}`;
        const elemPathVar = `tuplePath_${depth}_${idx}`;
        lines.push(`  const ${elemPathVar} = (${pathVar} ? ${pathVar} : "") + "[" + ${idx} + "]";`);
        lines.push(`  const ${elemVar} = ${varName}[${idx}];`);

        if (elem.optional) {
          lines.push(`  if (${elemVar} !== undefined) {`);
          lines.push(
            generateValidationBlock(elem.type, elemVar, elemPathVar, depth + 1)
              .split("\n")
              .map((l) => "    " + l)
              .join("\n")
          );
          lines.push(`  }`);
        } else {
          lines.push(`  if (${elemVar} === undefined) {`);
          lines.push(
            `    errors.push({ path: ${elemPathVar}, message: "Tuple element missing", expected: "defined", actual: undefined });`
          );
          lines.push(`  } else {`);
          lines.push(
            generateValidationBlock(elem.type, elemVar, elemPathVar, depth + 1)
              .split("\n")
              .map((l) => "    " + l)
              .join("\n")
          );
          lines.push(`  }`);
        }
      });

      lines.push(`}`);
      break;
    }

    case "union": {
      const branchErrorsVar = `unionErrs_${depth}`;
      const branchValidVar = `unionValid_${depth}`;

      lines.push(`let ${branchValidVar} = false;`);
      for (let i = 0; i < ir.types.length; i++) {
        const subType = ir.types[i]!;
        lines.push(`if (!${branchValidVar}) {`);
        lines.push(`  const errors = [];`);
        lines.push(
          generateValidationBlock(subType, varName, pathVar, depth + 1)
            .split("\n")
            .map((l) => "  " + l)
            .join("\n")
        );
        lines.push(`  if (errors.length === 0) {`);
        lines.push(`    ${branchValidVar} = true;`);
        lines.push(`  }`);
        lines.push(`}`);
      }

      lines.push(`if (!${branchValidVar}) {`);
      lines.push(
        `  errors.push({ path: ${pathVar}, message: "Value does not match any union variant", expected: "union variant", actual: ${varName} });`
      );
      lines.push(`}`);
      break;
    }

    case "intersection": {
      for (const subType of ir.types) {
        lines.push(generateValidationBlock(subType, varName, pathVar, depth + 1));
      }
      break;
    }

    case "record": {
      lines.push(`if (${varName} === null || typeof ${varName} !== "object" || Array.isArray(${varName})) {`);
      lines.push(
        `  errors.push({ path: ${pathVar}, message: "Expected record object", expected: "object", actual: ${varName} === null ? "null" : typeof ${varName} });`
      );
      lines.push(`} else {`);

      const keyVar = `k_${depth}`;
      const valVar = `v_${depth}`;
      const entryPathVar = `entryPath_${depth}`;

      lines.push(`  for (const [${keyVar}, ${valVar}] of Object.entries(${varName})) {`);
      lines.push(`    const ${entryPathVar} = ${pathVar} ? ${pathVar} + "." + ${keyVar} : ${keyVar};`);
      lines.push(
        generateValidationBlock(ir.valueType, valVar, entryPathVar, depth + 1)
          .split("\n")
          .map((l) => "    " + l)
          .join("\n")
      );
      lines.push(`  }`);
      lines.push(`}`);
      break;
    }

    case "ref": {
      break;
    }
  }

  return lines.join("\n");
}

/**
 * Helpers the checks rely on, emitted once per module.
 *
 * Both exist because the obvious JS spelling is not what JSON Schema means:
 * `String.length` counts UTF-16 units, and `Set` compares objects by
 * reference.
 */
const RUNTIME_HELPERS = [
  `function __wizLength(str) {`,
  `  // JSON Schema counts characters, so an astral character such as an emoji`,
  `  // is one, where String.length would call it two.`,
  `  let length = 0;`,
  `  let pos = 0;`,
  `  while (pos < str.length) {`,
  `    length++;`,
  `    const value = str.charCodeAt(pos++);`,
  `    if (value >= 0xd800 && value <= 0xdbff && pos < str.length) {`,
  `      if ((str.charCodeAt(pos) & 0xfc00) === 0xdc00) pos++;`,
  `    }`,
  `  }`,
  `  return length;`,
  `}`,
  ``,
  `function __wizEqual(a, b) {`,
  `  if (a === b) return true;`,
  `  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;`,
  `  if (Array.isArray(a) !== Array.isArray(b)) return false;`,
  `  if (Array.isArray(a)) {`,
  `    if (a.length !== b.length) return false;`,
  `    return a.every((item, i) => __wizEqual(item, b[i]));`,
  `  }`,
  `  const keys = Object.keys(a);`,
  `  if (keys.length !== Object.keys(b).length) return false;`,
  `  // Key order carries no meaning in JSON, so it carries none here.`,
  `  return keys.every((k) => Object.hasOwn(b, k) && __wizEqual(a[k], b[k]));`,
  `}`,
  ``,
  `function __wizUnique(items) {`,
  `  for (let i = 1; i < items.length; i++) {`,
  `    for (let j = 0; j < i; j++) {`,
  `      if (__wizEqual(items[i], items[j])) return false;`,
  `    }`,
  `  }`,
  `  return true;`,
  `}`,
  ``,
  `const __wizPatterns = new Map();`,
  `function __wizPattern(src) {`,
  `  // A pattern is a constant, so compiling it per call is pure waste; a Map`,
  `  // rather than an object so a pattern of "__proto__" cannot reach one.`,
  `  let re = __wizPatterns.get(src);`,
  `  if (re === undefined) {`,
  `    re = new RegExp(src);`,
  `    __wizPatterns.set(src, re);`,
  `  }`,
  `  return re;`,
  `}`,
].join("\n");

export function generateValidatorCode(ir: TypeIR): string {
  const validationBody = generateValidationBlock(ir, "arg", "path", 0);

  return [
    RUNTIME_HELPERS,
    ``,
    `export function validate(arg, path = "") {`,
    `  const errors = [];`,
    validationBody
      .split("\n")
      .map((line) => "  " + line)
      .join("\n"),
    `  return errors;`,
    `}`,
    ``,
    `export function is(arg) {`,
    `  return validate(arg).length === 0;`,
    `}`,
  ].join("\n");
}
