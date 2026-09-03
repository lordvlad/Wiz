import { collectNamedTypes, type TypeIR } from "../ir/types.ts";
import {
  emptyService,
  isOpenRpcMethod,
  type ServiceIR,
} from "../ir/service.ts";
import { irToOpenApiSchema } from "./openapi.ts";
import { assertValidSpecDocumentSync } from "../validators/jsonSchema.ts";

export interface OpenRpcGeneratorOptions {
  info?: {
    title?: string;
    version?: string;
    description?: string;
  };
}

export function generateOpenRpcSchemaCode(
  types: Array<{ name: string; ir: TypeIR }>,
  service: ServiceIR = emptyService(),
  options: OpenRpcGeneratorOptions = {}
): string {
  const schemasObj: Record<string, unknown> = {};
  const allNamedTypes = new Map<string, TypeIR>();

  const collect = (ir: TypeIR) => {
    for (const [name, namedIR] of collectNamedTypes(ir).entries()) {
      if (namedIR.kind === "ref") continue;
      if (!allNamedTypes.has(name)) allNamedTypes.set(name, namedIR);
    }
  };

  for (const { name, ir } of types) {
    if (!allNamedTypes.has(name)) allNamedTypes.set(name, ir);
  }
  for (const { ir } of types) collect(ir);

  for (const method of service.methods) {
    if (isOpenRpcMethod(method)) {
      for (const p of method.request.params) collect(p.type);
      for (const r of method.responses) {
        if (r.result) collect(r.result);
        if (r.error) collect(r.error);
      }
    }
  }

  for (const [name, ir] of allNamedTypes.entries()) {
    schemasObj[name] = irToOpenApiSchema(ir, "3.1", true);
  }

  const methodsList: Array<Record<string, unknown>> = [];
  let hasRpcDiscover = false;

  for (const method of service.methods) {
    if (isOpenRpcMethod(method)) {
      const pkg = method.address.package ?? service.package;
      const svc = method.address.service ?? service.name;
      const m = method.address.method;
      const methodName = pkg && svc
        ? `${pkg}.${svc}.${m}`
        : svc
          ? `${svc}.${m}`
          : m;

      if (methodName === "rpc.discover") {
        hasRpcDiscover = true;
      }

      const paramsObj = method.request.params.map((p) => {
        const paramSchema = irToOpenApiSchema(p.type, "3.1", false);
        return {
          name: p.name,
          ...(p.description ? { description: p.description } : {}),
          required: p.required,
          schema: paramSchema,
        };
      });

      const response0 = method.responses[0];
      const resultSchema = response0?.result
        ? irToOpenApiSchema(response0.result, "3.1", false)
        : { type: "object" };

      methodsList.push({
        name: methodName,
        ...(method.summary ? { summary: method.summary } : {}),
        ...(method.description ? { description: method.description } : {}),
        ...(method.tags ? { tags: method.tags } : {}),
        ...(method.deprecated ? { deprecated: method.deprecated } : {}),
        params: paramsObj,
        paramStructure: method.request.paramsByName ? "by-name" : "by-position",
        result: {
          name: "result",
          schema: resultSchema,
        },
      });
    }
  }

  if (!hasRpcDiscover) {
    methodsList.push({
      name: "rpc.discover",
      summary: "Returns OpenRPC schema description",
      params: [],
      result: {
        name: "OpenRPC",
        schema: { type: "object" },
      },
    });
  }

  const defaultInfo = {
    title: options.info?.title ?? service.name ?? "OpenRPC API",
    version: options.info?.version ?? service.version ?? "1.0.0",
    ...(options.info?.description || service.description
      ? { description: options.info?.description ?? service.description }
      : {}),
  };

  const sampleDoc = {
    openrpc: "1.3.0",
    info: defaultInfo,
    methods: methodsList,
    components: { schemas: schemasObj }
  };
  assertValidSpecDocumentSync(sampleDoc, "OpenRPC");
  const buildDocument = [
    `function buildOpenRpcDocument(baseSchema = {}) {`,
    `  const components = baseSchema.components || {};`,
    `  const schemas = components.schemas || {};`,
    `  const baseMethods = baseSchema.methods || [];`,
    `  const generatedMethods = ${JSON.stringify(methodsList, null, 2)};`,
    `  const methodsMap = new Map();`,
    `  for (const m of generatedMethods) methodsMap.set(m.name, m);`,
    `  for (const m of baseMethods) methodsMap.set(m.name, { ...(methodsMap.get(m.name) || {}), ...m });`,
    `  return {`,
    `    openrpc: "1.3.0",`,
    `    info: ${JSON.stringify(defaultInfo, null, 2)},`,
    `    ...baseSchema,`,
    `    methods: Array.from(methodsMap.values()),`,
    `    components: {`,
    `      ...components,`,
    `      schemas: {`,
    `        ...${JSON.stringify(schemasObj, null, 2)},`,
    `        ...schemas,`,
    `      }`,
    `    }`,
    `  };`,
    `}`,
  ].join("\n");

  return [
    buildDocument,
    ``,
    `export function openRPCSchema(baseSchema = {}) {`,
    `  return buildOpenRpcDocument(baseSchema);`,
    `}`,
  ].join("\n");
}
