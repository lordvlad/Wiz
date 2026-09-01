import {
  emptyApiComponents,
  type ApiDiagnostic,
  type ApiIR,
} from "../ir/api.ts";
import type { TypeIR } from "../ir/types.ts";
import type {
  OpenRpcServiceMethodIR,
  ParameterIR,
  ServiceIR,
} from "../ir/service.ts";
import { parseApiDocument, type ExtractApiOptions } from "./openapi.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function token(part: string): string {
  return part.replace(/~/g, "~0").replace(/\//g, "~1");
}

interface Ctx {
  document: Record<string, unknown>;
  diagnostics: ApiDiagnostic[];
  strict: boolean;
  ids: number;
}

function nextId(ctx: Ctx): string {
  return `o_${++ctx.ids}`;
}

const SCHEMAS_REF = "#/components/schemas/";

function schemaToIR(raw: unknown, ctx: Ctx, pointer: string): TypeIR {
  if (raw === undefined || raw === true) {
    return { id: nextId(ctx), kind: "primitive", type: "unknown" };
  }
  if (raw === false) {
    return { id: nextId(ctx), kind: "primitive", type: "never" };
  }
  if (!isObject(raw)) {
    return { id: nextId(ctx), kind: "primitive", type: "unknown" };
  }

  if (typeof raw.$ref === "string") {
    const ref = raw.$ref;
    if (!ref.startsWith(SCHEMAS_REF) || ref.length === SCHEMAS_REF.length) {
      return { id: nextId(ctx), kind: "primitive", type: "unknown" };
    }
    const name = ref.slice(SCHEMAS_REF.length);
    return { id: nextId(ctx), kind: "ref", targetId: name, name };
  }

  const declared = raw.type;
  const typeName = typeof declared === "string" ? declared : undefined;

  if (typeName === "string") {
    if (Array.isArray(raw.enum)) {
      return {
        id: nextId(ctx),
        kind: "enum",
        members: raw.enum.map((v) => ({ name: String(v), value: String(v) })),
      };
    }
    return { id: nextId(ctx), kind: "primitive", type: "string" };
  }
  if (typeName === "integer" || typeName === "number") {
    return { id: nextId(ctx), kind: "primitive", type: "number" };
  }
  if (typeName === "boolean") {
    return { id: nextId(ctx), kind: "primitive", type: "boolean" };
  }
  if (typeName === "null") {
    return { id: nextId(ctx), kind: "primitive", type: "null" };
  }

  if (typeName === "array" || Array.isArray(raw.items)) {
    const itemSchema = isObject(raw.items) ? raw.items : {};
    return {
      id: nextId(ctx),
      kind: "array",
      element: schemaToIR(itemSchema, ctx, `${pointer}/items`),
    };
  }

  if (typeName === "object" || isObject(raw.properties)) {
    const propsObj = isObject(raw.properties) ? raw.properties : {};
    const requiredList = Array.isArray(raw.required)
      ? raw.required.filter((r): r is string => typeof r === "string")
      : [];

    const properties = Object.entries(propsObj).map(([propName, propRaw]) => {
      const isReq = requiredList.includes(propName);
      const propType = schemaToIR(propRaw, ctx, `${pointer}/properties/${token(propName)}`);
      return {
        name: propName,
        type: propType,
        optional: !isReq,
        description: isObject(propRaw) && typeof propRaw.description === "string" ? propRaw.description : undefined,
      };
    });

    return {
      id: nextId(ctx),
      kind: "object",
      properties,
    };
  }

  if (Array.isArray(raw.oneOf) || Array.isArray(raw.anyOf)) {
    const membersRaw = (raw.oneOf || raw.anyOf) as unknown[];
    const types = membersRaw.map((m, idx) =>
      schemaToIR(m, ctx, `${pointer}/oneOf/${idx}`)
    );
    return { id: nextId(ctx), kind: "union", types };
  }

  return { id: nextId(ctx), kind: "primitive", type: "unknown" };
}

export function extractOpenRpcIR(
  text: string,
  options: ExtractApiOptions = {}
): ApiIR {
  const parsed = parseApiDocument(text, options.format);
  if (!isObject(parsed)) {
    throw new Error("[wiz] OpenRPC document must be an object");
  }

  const openrpcVer = typeof parsed.openrpc === "string" ? parsed.openrpc : "1.3.0";
  if (!openrpcVer.startsWith("1.")) {
    if (options.strict) {
      throw new Error(`[wiz] unsupported OpenRPC version '${openrpcVer}'`);
    }
  }

  const ctx: Ctx = {
    document: parsed,
    diagnostics: [],
    strict: options.strict === true,
    ids: 0,
  };

  const infoObj = isObject(parsed.info) ? parsed.info : {};
  const serviceName = typeof infoObj.title === "string" ? infoObj.title : undefined;
  const serviceVer = typeof infoObj.version === "string" ? infoObj.version : undefined;
  const serviceDesc = typeof infoObj.description === "string" ? infoObj.description : undefined;

  const typesMap = new Map<string, TypeIR>();
  const componentsObj = isObject(parsed.components) ? parsed.components : {};
  const schemasObj = isObject(componentsObj.schemas) ? componentsObj.schemas : {};

  for (const [schemaName, schemaRaw] of Object.entries(schemasObj)) {
    const ir = schemaToIR(schemaRaw, ctx, `#/components/schemas/${token(schemaName)}`);
    if (ir.kind === "object" || ir.kind === "enum") {
      ir.name = schemaName;
    }
    typesMap.set(schemaName, ir);
  }

  const methodsList = Array.isArray(parsed.methods) ? parsed.methods : [];
  const openRpcMethods: OpenRpcServiceMethodIR[] = [];

  for (let i = 0; i < methodsList.length; i++) {
    const m = methodsList[i];
    if (!isObject(m)) continue;

    const fullMethodName = typeof m.name === "string" ? m.name : `method_${i}`;
    let svc: string | undefined;
    let methodName = fullMethodName;

    if (typeof m.service === "string") {
      svc = m.service;
    } else if (fullMethodName.includes(".")) {
      const parts = fullMethodName.split(".");
      svc = parts.slice(0, -1).join(".");
      methodName = parts[parts.length - 1]!;
    }

    const summary = typeof m.summary === "string" ? m.summary : undefined;
    const description = typeof m.description === "string" ? m.description : undefined;
    const deprecated = m.deprecated === true;

    const tags: string[] = [];
    if (Array.isArray(m.tags)) {
      for (const t of m.tags) {
        if (typeof t === "string") tags.push(t);
        else if (isObject(t) && typeof t.name === "string") tags.push(t.name);
      }
    }

    const paramsList = Array.isArray(m.params) ? m.params : [];
    const parameters: ParameterIR[] = [];
    for (let pIdx = 0; pIdx < paramsList.length; pIdx++) {
      const p = paramsList[pIdx];
      if (!isObject(p)) continue;
      const paramName = typeof p.name === "string" ? p.name : `param_${pIdx}`;
      const paramDesc = typeof p.description === "string" ? p.description : undefined;
      const required = p.required === true;
      const paramSchema = p.schema;

      const paramType = schemaToIR(
        paramSchema,
        ctx,
        `#/methods/${i}/params/${pIdx}/schema`
      );

      parameters.push({
        name: paramName,
        in: "rpc",
        required,
        type: paramType,
        description: paramDesc,
      });
    }

    const paramsByName = m.paramStructure === "by-name";

    const resultObj = isObject(m.result) ? m.result : {};
    const resultType = schemaToIR(
      resultObj.schema,
      ctx,
      `#/methods/${i}/result/schema`
    );

    const methodIR: OpenRpcServiceMethodIR = {
      kind: "serviceMethod",
      protocol: "openrpc",
      address: {
        protocol: "openrpc",
        service: svc,
        method: methodName,
      },
      request: {
        protocol: "openrpc",
        params: parameters,
        paramsByName,
      },
      responses: [
        {
          protocol: "openrpc",
          result: resultType,
        },
      ],
      summary,
      description,
      tags: tags.length > 0 ? tags : undefined,
      deprecated: deprecated || undefined,
    };

    openRpcMethods.push(methodIR);
  }

  const service: ServiceIR = {
    kind: "service",
    name: serviceName,
    version: serviceVer,
    description: serviceDesc,
    methods: openRpcMethods,
  };

  return {
    kind: "api",
    version: "openrpc-1.3",
    types: typesMap,
    components: emptyApiComponents(),
    service,
    diagnostics: ctx.diagnostics,
  };
}
