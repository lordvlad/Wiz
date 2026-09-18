import type { Generator, GeneratorContext, GeneratedFiles } from "./generator.ts";
import type { ApiIR } from "../ir/api.ts";
import type { TypeIR, PropertyIR, EnumMemberIR, Constraint } from "../ir/types.ts";

export interface JavaGeneratorOptions {
  /**
   * Generation style: "record" (default) or "pojo".
   */
  style?: "record" | "pojo";
  /**
   * Package name for generated classes (e.g. "com.example.model").
   */
  package?: string;
  /**
   * Whether to include Jackson annotations (@JsonProperty, @JsonInclude, @JsonCreator, etc.).
   * Defaults to true.
   */
  jackson?: boolean;
  /**
   * Whether to include Jakarta Validation annotations (@NotNull, @Size, @Min, @Max, @Pattern, etc.).
   * Defaults to true.
   */
  validation?: boolean;
  /**
   * Whether to include Lombok annotations (@Data, @Builder, @NoArgsConstructor, @AllArgsConstructor, etc.).
   * When enabled on POJOs, explicit getters/setters/constructors are omitted in favor of Lombok annotations.
   */
  lombok?: boolean;
}

/**
 * Sanitizes a name to a valid Java identifier.
 */
function sanitizeIdentifier(name: string): string {
  let clean = name.replace(/[^a-zA-Z0-9_$]/g, "_");
  if (/^[0-9]/.test(clean)) clean = `_${clean}`;
  return clean;
}

/**
 * Converts a string to PascalCase for Java class names.
 */
function toPascalCase(name: string): string {
  const clean = sanitizeIdentifier(name);
  return clean
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("") || "Model";
}

/**
 * Converts a string to camelCase for Java field names.
 */
function toCamelCase(name: string): string {
  const pascal = toPascalCase(name);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/**
 * Map TypeIR to a Java type name.
 */
function toJavaType(ir: TypeIR, typeNameMap: Map<string, string>): string {
  switch (ir.kind) {
    case "primitive": {
      switch (ir.type) {
        case "string":
          return "String";
        case "number":
          return "Double";
        case "boolean":
          return "Boolean";
        case "bigint":
          return "Long";
        case "date":
          return "java.time.OffsetDateTime";
        case "null":
          return "Object";
        case "undefined":
        case "void":
          return "Void";
        case "unknown":
        case "any":
        case "never":
        default:
          return "Object";
      }
    }
    case "literal": {
      if (typeof ir.value === "string") return "String";
      if (typeof ir.value === "number") return "Double";
      if (typeof ir.value === "boolean") return "Boolean";
      return "Object";
    }
    case "array": {
      const elemType = toJavaType(ir.element, typeNameMap);
      return `java.util.List<${elemType}>`;
    }
    case "tuple": {
      return "java.util.List<Object>";
    }
    case "record": {
      const valType = toJavaType(ir.valueType, typeNameMap);
      return `java.util.Map<String, ${valType}>`;
    }
    case "ref": {
      return typeNameMap.get(ir.targetId) ?? toPascalCase(ir.name ?? ir.targetId);
    }
    case "enum": {
      return ir.name ? toPascalCase(ir.name) : "String";
    }
    case "object": {
      return ir.name ? toPascalCase(ir.name) : "java.util.Map<String, Object>";
    }
    case "union":
    case "intersection":
    default:
      return "Object";
  }
}

/**
 * Generate Jakarta validation annotations from property constraints and nullability.
 */
function getValidationAnnotations(prop: PropertyIR): string[] {
  const annotations: string[] = [];

  if (!prop.optional) {
    annotations.push("@jakarta.validation.constraints.NotNull");
  }

  for (const c of prop.constraints ?? []) {
    switch (c.kind) {
      case "minimum":
      case "min":
        annotations.push(`@jakarta.validation.constraints.Min(${c.value})`);
        break;
      case "maximum":
      case "max":
        annotations.push(`@jakarta.validation.constraints.Max(${c.value})`);
        break;
      case "exclusiveMinimum":
        annotations.push(`@jakarta.validation.constraints.DecimalMin(value = "${c.value}", inclusive = false)`);
        break;
      case "exclusiveMaximum":
        annotations.push(`@jakarta.validation.constraints.DecimalMax(value = "${c.value}", inclusive = false)`);
        break;
      case "minLength":
      case "minItems":
        annotations.push(`@jakarta.validation.constraints.Size(min = ${c.value})`);
        break;
      case "maxLength":
      case "maxItems":
        annotations.push(`@jakarta.validation.constraints.Size(max = ${c.value})`);
        break;
      case "pattern":
        annotations.push(`@jakarta.validation.constraints.Pattern(regexp = ${JSON.stringify(String(c.value))})`);
        break;
    }
  }

  return annotations;
}

/**
 * Emits Java enum class.
 */
function generateEnumSource(
  name: string,
  members: EnumMemberIR[],
  options: JavaGeneratorOptions
): string {
  const includeJackson = options.jackson !== false;
  const lines: string[] = [];
  if (options.package) {
    lines.push(`package ${options.package};`, "");
  }

  if (includeJackson) {
    lines.push("import com.fasterxml.jackson.annotation.JsonValue;");
    lines.push("import com.fasterxml.jackson.annotation.JsonCreator;");
  }

  lines.push(`public enum ${name} {`);

  const memberEntries = members.map((m) => {
    const enumId = sanitizeIdentifier(String(m.name)).toUpperCase();
    const valLit = typeof m.value === "string" ? JSON.stringify(m.value) : String(m.value);
    return `  ${enumId}(${valLit})`;
  });

  lines.push(memberEntries.join(",\n") + ";", "");
  lines.push("  private final Object value;", "");
  lines.push(`  ${name}(Object value) {`);
  lines.push("    this.value = value;");
  lines.push("  }", "");

  if (includeJackson) {
    lines.push("  @JsonValue");
  }
  lines.push("  public Object getValue() {");
  lines.push("    return this.value;");
  lines.push("  }", "");

  if (includeJackson) {
    lines.push("  @JsonCreator");
    lines.push(`  public static ${name} fromValue(Object value) {`);
    lines.push(`    for (${name} b : ${name}.values()) {`);
    lines.push("      if (java.util.Objects.equals(b.value, value)) {");
    lines.push("        return b;");
    lines.push("      }");
    lines.push("    }");
    lines.push(`    throw new IllegalArgumentException("Unexpected value '" + value + "'");`);
    lines.push("  }");
  }

  lines.push("}");
  return lines.join("\n");
}

/**
 * Emits Java Record or POJO source for an object TypeIR.
 */
function generateClassSource(
  className: string,
  ir: TypeIR,
  options: JavaGeneratorOptions,
  typeNameMap: Map<string, string>
): string {
  const style = options.style ?? "record";
  const includeJackson = options.jackson !== false;
  const includeValidation = options.validation !== false;
  const lines: string[] = [];

  if (options.package) {
    lines.push(`package ${options.package};`, "");
  }

  if (ir.kind !== "object") {
    // Wrapper class or type alias
    lines.push(`public class ${className} {`);
    lines.push("}");
    return lines.join("\n");
  }

  const properties = ir.properties;

  if (style === "record") {
    // Java Record
    if (includeJackson) {
      lines.push("import com.fasterxml.jackson.annotation.JsonProperty;");
      lines.push("import com.fasterxml.jackson.annotation.JsonInclude;");
      lines.push("@JsonInclude(JsonInclude.Include.NON_NULL)");
    }

    const componentDecls = properties.map((prop) => {
      const fieldName = toCamelCase(prop.name);
      const fieldType = toJavaType(prop.type, typeNameMap);
      const annos: string[] = [];

      if (includeJackson) {
        annos.push(`@JsonProperty("${prop.name}")`);
      }
      if (includeValidation) {
        annos.push(...getValidationAnnotations(prop));
      }

      const prefix = annos.length > 0 ? `${annos.join(" ")} ` : "";
      return `    ${prefix}${fieldType} ${fieldName}`;
    });

    lines.push(`public record ${className}(`);
    lines.push(componentDecls.join(",\n"));
    lines.push(") {}");
    return lines.join("\n");
  }

  // POJO Style
  if (options.lombok) {
    lines.push("import lombok.Data;");
    lines.push("import lombok.Builder;");
    lines.push("import lombok.NoArgsConstructor;");
    lines.push("import lombok.AllArgsConstructor;");
    if (includeJackson) {
      lines.push("import lombok.extern.jackson.Jacksonized;");
    }
    lines.push("");
    lines.push("@Data");
    lines.push("@Builder");
    lines.push("@NoArgsConstructor");
    lines.push("@AllArgsConstructor");
    if (includeJackson) {
      // @Jacksonized configures Lombok's @Builder to work seamlessly with Jackson deserialization
      lines.push("@Jacksonized");
    }
  }

  if (includeJackson) {
    lines.push("import com.fasterxml.jackson.annotation.JsonProperty;");
    lines.push("import com.fasterxml.jackson.annotation.JsonInclude;");
    lines.push("@JsonInclude(JsonInclude.Include.NON_NULL)");
  }

  lines.push(`public class ${className} {`);

  // Fields
  for (const prop of properties) {
    const fieldName = toCamelCase(prop.name);
    const fieldType = toJavaType(prop.type, typeNameMap);

    if (includeJackson) {
      lines.push(`  @JsonProperty("${prop.name}")`);
    }
    if (includeValidation) {
      for (const va of getValidationAnnotations(prop)) {
        lines.push(`  ${va}`);
      }
    }
    lines.push(`  private ${fieldType} ${fieldName};`);
    lines.push("");
  }

  // When Lombok is NOT used, generate explicit constructors, getters, and setters
  if (!options.lombok) {
    // Default constructor
    lines.push(`  public ${className}() {}`, "");

    // All-args constructor
    if (properties.length > 0) {
      const ctorParams = properties
        .map((prop) => `${toJavaType(prop.type, typeNameMap)} ${toCamelCase(prop.name)}`)
        .join(", ");
      lines.push(`  public ${className}(${ctorParams}) {`);
      for (const prop of properties) {
        const fieldName = toCamelCase(prop.name);
        lines.push(`    this.${fieldName} = ${fieldName};`);
      }
      lines.push("  }", "");
    }

    // Getters and Setters
    for (const prop of properties) {
      const fieldName = toCamelCase(prop.name);
      const fieldType = toJavaType(prop.type, typeNameMap);
      const capName = fieldName.charAt(0).toUpperCase() + fieldName.slice(1);

      lines.push(`  public ${fieldType} get${capName}() {`);
      lines.push(`    return this.${fieldName};`);
      lines.push("  }", "");

      lines.push(`  public void set${capName}(${fieldType} ${fieldName}) {`);
      lines.push(`    this.${fieldName} = ${fieldName};`);
      lines.push("  }", "");
    }
  }

  lines.push("}");
  return lines.join("\n");
}

/**
 * Generate Java model files from intermediate representations.
 */
export function generateJavaModels(
  types: Iterable<readonly [string, TypeIR]>,
  options: JavaGeneratorOptions = {}
): GeneratedFiles {
  const files: GeneratedFiles = {};
  const typeNameMap = new Map<string, string>();

  for (const [name] of types) {
    typeNameMap.set(name, toPascalCase(name));
  }

  for (const [name, ir] of types) {
    const className = typeNameMap.get(name) ?? toPascalCase(name);
    const fileName = `${className}.java`;

    if (ir.kind === "enum") {
      files[fileName] = generateEnumSource(className, ir.members, options);
    } else {
      files[fileName] = generateClassSource(className, ir, options, typeNameMap);
    }
  }

  return files;
}

export const javaGenerator: Generator<JavaGeneratorOptions> = {
  name: "java-models",

  api(ir: ApiIR, context: GeneratorContext<JavaGeneratorOptions>): GeneratedFiles {
    return generateJavaModels(ir.types, context.options);
  },

  type(ir: TypeIR, context: GeneratorContext<JavaGeneratorOptions>): GeneratedFiles {
    const name = ir.name ?? "Model";
    return generateJavaModels([[name, ir]], context.options);
  },
};
