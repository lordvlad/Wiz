import type { Generator, GeneratorContext, GeneratedFiles } from "./generator.ts";
import type { ApiIR } from "../ir/api.ts";
import type { TypeIR, PropertyIR, EnumMemberIR, Constraint } from "../ir/types.ts";
import { isHttpMethod, type HttpServiceMethodIR, type ServiceIR, type HttpResponseIR } from "../ir/service.ts";

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
  /**
   * HTTP Client generator option: "jakarta" (default), "mp" (MicroProfile @RegisterRestClient / @RestClient), or "off" / false.
   */
  client?: "jakarta" | "mp" | "off" | false;
  /**
   * Custom client class name override (defaults to `<ServiceName>Client` or `ApiClient`).
   */
  clientName?: string;
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
  return (
    clean
      .split("_")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join("") || "Model"
  );
}

/**
 * Converts a string to camelCase for Java field/method names.
 */
function toCamelCase(name: string): string {
  const pascal = toPascalCase(name);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/**
 * Derives a suffix based on a mimetype (e.g. "application/json" -> "AsJson", "application/xml" -> "AsXml").
 */
function mimetypeToSuffix(mimetype: string): string {
  const norm = mimetype.toLowerCase();
  if (norm.includes("json")) return "AsJson";
  if (norm.includes("xml")) return "AsXml";
  if (norm.includes("yaml")) return "AsYaml";
  if (norm.includes("csv")) return "AsCsv";
  if (norm.includes("octet-stream")) return "AsOctetStream";
  if (norm.includes("form-data")) return "AsFormData";
  if (norm.includes("x-www-form-urlencoded")) return "AsUrlEncoded";
  if (norm.includes("text")) return "AsText";
  const clean = norm.replace(/[^a-zA-Z0-9]/g, "_");
  return `As${toPascalCase(clean)}`;
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
        annotations.push(
          `@jakarta.validation.constraints.DecimalMin(value = "${c.value}", inclusive = false)`
        );
        break;
      case "exclusiveMaximum":
        annotations.push(
          `@jakarta.validation.constraints.DecimalMax(value = "${c.value}", inclusive = false)`
        );
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
        annotations.push(
          `@jakarta.validation.constraints.Pattern(regexp = ${JSON.stringify(String(c.value))})`
        );
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
    const valLit =
      typeof m.value === "string" ? JSON.stringify(m.value) : String(m.value);
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
    lines.push(
      `    throw new IllegalArgumentException("Unexpected value '" + value + "'");`
    );
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
    }
    lines.push("");
    if (includeJackson) {
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
  }

  if (includeJackson) {
    lines.push("import com.fasterxml.jackson.annotation.JsonProperty;");
    lines.push("import com.fasterxml.jackson.annotation.JsonInclude;");
  }
  lines.push("");

  if (options.lombok) {
    lines.push("@Data");
    lines.push("@Builder");
    lines.push("@NoArgsConstructor");
    lines.push("@AllArgsConstructor");
    if (includeJackson) {
      lines.push("@Jacksonized");
    }
  }

  if (includeJackson) {
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
    lines.push(`  public ${className}() {}`, "");

    if (properties.length > 0) {
      const ctorParams = properties
        .map(
          (prop) =>
            `${toJavaType(prop.type, typeNameMap)} ${toCamelCase(prop.name)}`
        )
        .join(", ");
      lines.push(`  public ${className}(${ctorParams}) {`);
      for (const prop of properties) {
        const fieldName = toCamelCase(prop.name);
        lines.push(`    this.${fieldName} = ${fieldName};`);
      }
      lines.push("  }", "");
    }

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

interface HttpMethodVariant {
  baseName: string;
  methodName: string;
  method: HttpServiceMethodIR;
  returnType: string;
  responseMimetype?: string;
  requestBodyParam?: { mimetype: string; content: TypeIR };
}

/**
 * Expands an HTTP method into distinct variants if multiple request or response media types are offered.
 */
function collectMethodVariants(
  method: HttpServiceMethodIR,
  typeNameMap: Map<string, string>
): HttpMethodVariant[] {
  const baseName = toCamelCase(
    method.address.methodName ??
      method.operationId ??
      `${method.address.method.toLowerCase()}_${method.address.path.replace(/[^a-zA-Z0-9]/g, "_")}`
  );

  const isSuccess = (r: HttpResponseIR) =>
    typeof r.status === "number" && r.status >= 200 && r.status < 300;
  const chosenResp = method.responses.filter(isSuccess)[0] ?? method.responses[0];
  const responseBodies = chosenResp?.body ?? [];

  const requestBodies = method.request.body ?? [];

  // If there are multiple response representations or multiple request representations
  const hasMultipleResponses = responseBodies.length > 1;
  const hasMultipleRequests = requestBodies.length > 1;

  if (!hasMultipleResponses && !hasMultipleRequests) {
    const respBody = responseBodies[0];
    const reqBody = requestBodies[0];
    const returnType = respBody?.content
      ? toJavaType(respBody.content, typeNameMap)
      : "void";

    return [
      {
        baseName,
        methodName: baseName,
        method,
        returnType,
        responseMimetype: respBody?.mimetype,
        requestBodyParam: reqBody,
      },
    ];
  }

  const variants: HttpMethodVariant[] = [];

  const effectiveResponses = responseBodies.length > 0 ? responseBodies : [{ mimetype: "application/json", content: undefined }];
  const effectiveRequests = requestBodies.length > 0 ? requestBodies : [undefined];

  for (const resp of effectiveResponses) {
    for (const req of effectiveRequests) {
      let suffix = "";
      if (hasMultipleResponses && resp.mimetype) {
        suffix += mimetypeToSuffix(resp.mimetype);
      }
      if (hasMultipleRequests && req?.mimetype) {
        suffix += mimetypeToSuffix(req.mimetype);
      }

      const methodName = suffix ? `${baseName}${suffix}` : baseName;
      const returnType = resp.content ? toJavaType(resp.content, typeNameMap) : "void";

      variants.push({
        baseName,
        methodName,
        method,
        returnType,
        responseMimetype: resp.mimetype,
        requestBodyParam: req,
      });
    }
  }

  return variants;
}

/**
 * Emits Jakarta REST Client class.
 */
function generateJakartaClientSource(
  service: ServiceIR,
  options: JavaGeneratorOptions,
  typeNameMap: Map<string, string>
): string {
  const clientName =
    options.clientName ??
    (service.name ? `${toPascalCase(service.name)}Client` : "ApiClient");
  const lines: string[] = [];

  if (options.package) {
    lines.push(`package ${options.package};`, "");
  }

  lines.push("import jakarta.ws.rs.client.Client;");
  lines.push("import jakarta.ws.rs.client.ClientBuilder;");
  lines.push("import jakarta.ws.rs.client.Entity;");
  lines.push("import jakarta.ws.rs.client.WebTarget;");
  lines.push("import jakarta.ws.rs.core.GenericType;");
  lines.push("import jakarta.ws.rs.core.MediaType;");
  lines.push("import jakarta.ws.rs.core.Response;");
  lines.push("");

  lines.push(`public class ${clientName} implements java.lang.AutoCloseable {`);
  lines.push("  private final WebTarget target;");
  lines.push("  private final Client client;");
  lines.push("");
  lines.push(`  public ${clientName}(String baseUrl) {`);
  lines.push("    this.client = ClientBuilder.newClient();");
  lines.push("    this.target = this.client.target(baseUrl);");
  lines.push("  }");
  lines.push("");
  lines.push(`  public ${clientName}(WebTarget target) {`);
  lines.push("    this.client = null;");
  lines.push("    this.target = target;");
  lines.push("  }");
  lines.push("");

  for (const method of service.methods) {
    if (!isHttpMethod(method)) continue;
    const variants = collectMethodVariants(method, typeNameMap);

    for (const v of variants) {
      const http = v.method;
      const methodName = v.methodName;
      const httpVerb = http.address.method.toUpperCase();
      const returnType = v.returnType;

      const pathParams = (http.request.parameters ?? []).filter(
        (p) => p.in === "path"
      );
      const queryParams = (http.request.parameters ?? []).filter(
        (p) => p.in === "query"
      );
      const headerParams = (http.request.parameters ?? []).filter(
        (p) => p.in === "header"
      );
      const bodyParam = v.requestBodyParam;

      const methodArgs: string[] = [];
      for (const p of pathParams) {
        methodArgs.push(`${toJavaType(p.type, typeNameMap)} ${toCamelCase(p.name)}`);
      }
      for (const p of queryParams) {
        methodArgs.push(`${toJavaType(p.type, typeNameMap)} ${toCamelCase(p.name)}`);
      }
      for (const p of headerParams) {
        methodArgs.push(`${toJavaType(p.type, typeNameMap)} ${toCamelCase(p.name)}`);
      }
      if (bodyParam) {
        methodArgs.push(`${toJavaType(bodyParam.content, typeNameMap)} body`);
      }

      if (http.description || http.summary) {
        lines.push("  /**");
        if (http.summary) lines.push(`   * ${http.summary}`);
        if (http.description) lines.push(`   * ${http.description}`);
        if (v.responseMimetype) lines.push(`   * Accepts: ${v.responseMimetype}`);
        lines.push("   */");
      }

      lines.push(`  public ${returnType} ${methodName}(${methodArgs.join(", ")}) {`);
      lines.push(`    WebTarget resource = this.target.path(${JSON.stringify(http.address.path)});`);

      for (const p of pathParams) {
        const varName = toCamelCase(p.name);
        lines.push(`    resource = resource.resolveTemplate("${p.name}", ${varName});`);
      }

      for (const p of queryParams) {
        const varName = toCamelCase(p.name);
        lines.push(`    if (${varName} != null) {`);
        lines.push(`      resource = resource.queryParam("${p.name}", ${varName});`);
        lines.push("    }");
      }

      const acceptMime = v.responseMimetype ?? "application/json";
      lines.push(`    var builder = resource.request("${acceptMime}");`);

      for (const p of headerParams) {
        const varName = toCamelCase(p.name);
        lines.push(`    if (${varName} != null) {`);
        lines.push(`      builder = builder.header("${p.name}", ${varName});`);
        lines.push("    }");
      }

      const isVoid = returnType === "void" || returnType === "Void";
      const isGeneric = returnType.includes("<");
      const genericTypeToken = isVoid
        ? "Response.class"
        : isGeneric
          ? `new GenericType<${returnType}>() {}`
          : `${returnType}.class`;

      let invocation: string;
      if (bodyParam) {
        const contentType = bodyParam.mimetype ?? "application/json";
        invocation = `builder.method("${httpVerb}", Entity.entity(body, "${contentType}"), ${genericTypeToken})`;
      } else if (httpVerb === "GET") {
        invocation = `builder.get(${genericTypeToken})`;
      } else if (httpVerb === "POST") {
        invocation = `builder.post(Entity.json(null), ${genericTypeToken})`;
      } else if (httpVerb === "DELETE") {
        invocation = `builder.delete(${genericTypeToken})`;
      } else if (httpVerb === "PUT") {
        invocation = `builder.put(Entity.json(null), ${genericTypeToken})`;
      } else {
        invocation = `builder.method("${httpVerb}", ${genericTypeToken})`;
      }

      if (isVoid) {
        lines.push(`    try (Response response = ${invocation}) {`);
        lines.push("      // no-op for void response");
        lines.push("    }");
      } else {
        lines.push(`    return ${invocation};`);
      }

      lines.push("  }", "");
    }
  }

  lines.push("  @Override");
  lines.push("  public void close() {");
  lines.push("    if (this.client != null) {");
  lines.push("      this.client.close();");
  lines.push("    }");
  lines.push("  }");
  lines.push("}");

  return lines.join("\n");
}

/**
 * Emits MicroProfile REST Client interface annotated with @RegisterRestClient.
 */
function generateMicroProfileClientSource(
  service: ServiceIR,
  options: JavaGeneratorOptions,
  typeNameMap: Map<string, string>
): string {
  const clientName =
    options.clientName ??
    (service.name ? `${toPascalCase(service.name)}Client` : "ApiClient");
  const lines: string[] = [];

  if (options.package) {
    lines.push(`package ${options.package};`, "");
  }

  lines.push("import org.eclipse.microprofile.rest.client.inject.RegisterRestClient;");
  lines.push("import jakarta.ws.rs.*;");
  lines.push("import jakarta.ws.rs.core.MediaType;");
  lines.push("");

  lines.push("@RegisterRestClient");
  lines.push(`public interface ${clientName} {`);

  for (const method of service.methods) {
    if (!isHttpMethod(method)) continue;
    const variants = collectMethodVariants(method, typeNameMap);

    for (const v of variants) {
      const http = v.method;
      const methodName = v.methodName;
      const httpVerb = http.address.method.toUpperCase();
      const returnType = v.returnType;

      const pathParams = (http.request.parameters ?? []).filter(
        (p) => p.in === "path"
      );
      const queryParams = (http.request.parameters ?? []).filter(
        (p) => p.in === "query"
      );
      const headerParams = (http.request.parameters ?? []).filter(
        (p) => p.in === "header"
      );
      const bodyParam = v.requestBodyParam;

      const methodParams: string[] = [];
      for (const p of pathParams) {
        methodParams.push(`@PathParam("${p.name}") ${toJavaType(p.type, typeNameMap)} ${toCamelCase(p.name)}`);
      }
      for (const p of queryParams) {
        methodParams.push(`@QueryParam("${p.name}") ${toJavaType(p.type, typeNameMap)} ${toCamelCase(p.name)}`);
      }
      for (const p of headerParams) {
        methodParams.push(`@HeaderParam("${p.name}") ${toJavaType(p.type, typeNameMap)} ${toCamelCase(p.name)}`);
      }
      if (bodyParam) {
        methodParams.push(`${toJavaType(bodyParam.content, typeNameMap)} body`);
      }

      if (http.description || http.summary) {
        lines.push("  /**");
        if (http.summary) lines.push(`   * ${http.summary}`);
        if (http.description) lines.push(`   * ${http.description}`);
        if (v.responseMimetype) lines.push(`   * Produces: ${v.responseMimetype}`);
        lines.push("   */");
      }

      const producesMime = v.responseMimetype ?? "application/json";
      lines.push(`  @${httpVerb}`);
      lines.push(`  @Path(${JSON.stringify(http.address.path)})`);
      lines.push(`  @Produces(${JSON.stringify(producesMime)})`);
      if (bodyParam) {
        const contentType = bodyParam.mimetype ?? "application/json";
        lines.push(`  @Consumes(${JSON.stringify(contentType)})`);
      }
      lines.push(`  ${returnType} ${methodName}(${methodParams.join(", ")});`);
      lines.push("");
    }
  }

  lines.push("}");
  return lines.join("\n");
}

/**
 * Generate Java model and client files from intermediate representations.
 */
export function generateJavaFiles(
  types: Iterable<readonly [string, TypeIR]>,
  service?: ServiceIR,
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

  const clientOption = options.client ?? "jakarta";
  if (clientOption !== "off" && clientOption !== false && service && service.methods.length > 0) {
    const clientName =
      options.clientName ??
      (service.name ? `${toPascalCase(service.name)}Client` : "ApiClient");

    if (clientOption === "mp") {
      files[`${clientName}.java`] = generateMicroProfileClientSource(
        service,
        options,
        typeNameMap
      );
    } else {
      files[`${clientName}.java`] = generateJakartaClientSource(
        service,
        options,
        typeNameMap
      );
    }
  }

  return files;
}

export function generateJavaModels(
  types: Iterable<readonly [string, TypeIR]>,
  options: JavaGeneratorOptions = {}
): GeneratedFiles {
  return generateJavaFiles(types, undefined, options);
}

export const javaGenerator: Generator<JavaGeneratorOptions> = {
  name: "java",

  api(ir: ApiIR, context: GeneratorContext<JavaGeneratorOptions>): GeneratedFiles {
    return generateJavaFiles(ir.types, ir.service, context.options);
  },

  service(ir: ServiceIR, context: GeneratorContext<JavaGeneratorOptions>): GeneratedFiles {
    return generateJavaFiles([], ir, context.options);
  },

  type(ir: TypeIR, context: GeneratorContext<JavaGeneratorOptions>): GeneratedFiles {
    const name = ir.name ?? "Model";
    return generateJavaFiles([[name, ir]], undefined, context.options);
  },
};
