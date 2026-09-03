import { toSnakeCase, type TypeIR } from "../types.ts";
import { irToJsonSchema } from "./schema.ts";
import { emptyService, isMcpMethod, type ServiceIR } from "../ir/service.ts";
import { assertValidSpecDocumentSync } from "../validators/jsonSchema.ts";
export interface McpGeneratorOptions {
  info?: {
    title?: string;
    version?: string;
    description?: string;
  };
}

export function irToMcpInputSchema(ir: TypeIR): Record<string, unknown> {
  const schema = irToJsonSchema(ir, "draft-2020-12");
  if (schema.type !== "object") {
    return {
      type: "object",
      properties: {
        value: schema,
      },
      required: ["value"],
    };
  }
  return schema;
}

export interface McpToolSpec {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: {
    audience?: Array<"user" | "assistant">;
    priority?: number;
  };
}

export function generateMcpSchemaCode(
  types: Array<{ name: string; ir: TypeIR }>,
  service: ServiceIR = emptyService(),
  options: McpGeneratorOptions = {}
): string {
  const toolsList: McpToolSpec[] = [];
  const toolNames = new Set<string>();

  // 1. Process harvested service methods (from tool<TSpec>() calls or type args)
  for (const method of service.methods) {
    if (isMcpMethod(method)) {
      const pkg = method.address.package ?? service.package;
      const svc = method.address.service ?? service.name;
      const mName = method.address.method ?? method.address.name;
      const hasOverride = (method.address as any).hasOverride;
      const rawName = method.address.name;
      const name = hasOverride
        ? rawName
        : rawName.includes(".")
          ? rawName
          : pkg && svc
            ? `${pkg}.${svc}.${toSnakeCase(mName)}`
            : svc
              ? `${svc}.${toSnakeCase(mName)}`
              : toSnakeCase(mName);

      if (!toolNames.has(name)) {
        const inputSchema = irToMcpInputSchema(method.request.input);
        const outputResp = method.responses[0]?.output;
        const outputSchema = outputResp ? irToJsonSchema(outputResp, "draft-2020-12") : undefined;

        const toolSpec: McpToolSpec = {
          name,
          ...(method.title ? { title: method.title } : {}),
          ...(method.description ? { description: method.description } : {}),
          inputSchema,
          ...(outputSchema ? { outputSchema } : {}),
          ...(method.annotations && Object.keys(method.annotations).length > 0
            ? { annotations: method.annotations }
            : {}),
        };

        toolsList.push(toolSpec);
        toolNames.add(name);
      }
    }
  }
  // 2. Process types passed directly (from mcpSchema<[typeof searchUsers]>() with mcpTool metadata in IR)
  for (const { ir } of types) {
    const mcpMeta = (ir as any).meta?.mcpTool as McpToolSpec | undefined;
    if (mcpMeta && mcpMeta.name) {
      if (!toolNames.has(mcpMeta.name)) {
        toolsList.push(mcpMeta);
        toolNames.add(mcpMeta.name);
      }
    }
  }

  // Pre-validate dummy doc for assertValidSpecDocumentSync if needed or validate document structure
  const dummyDoc = {
    tools: toolsList,
  };

  const buildDocument = [
    `function buildMcpDocument(baseSchema = {}) {`,
    `  const baseTools = baseSchema.tools || [];`,
    `  const generatedTools = ${JSON.stringify(toolsList, null, 2)};`,
    `  const toolsMap = new Map();`,
    `  for (const t of generatedTools) toolsMap.set(t.name, t);`,
    `  for (const t of baseTools) toolsMap.set(t.name, { ...(toolsMap.get(t.name) || {}), ...t });`,
    `  return {`,
    `    ...baseSchema,`,
    `    tools: Array.from(toolsMap.values()),`,
    `  };`,
    `}`,
  ].join("\n");

  return [
    buildDocument,
    ``,
    `export function mcpSchema(baseSchema = {}) {`,
    `  return buildMcpDocument(baseSchema);`,
    `}`,
  ].join("\n");
}
