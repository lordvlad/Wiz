import { Validator } from "@seriousme/openapi-schema-validator";
import Ajv07 from "ajv";
import addFormats from "ajv-formats";

import openRpc13Schema from "../../schemas/openrpc-1.3.json";
import asyncApi26Schema from "../../schemas/asyncapi-2.6.json";
import asyncApi30Schema from "../../schemas/asyncapi-3.0.json";

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function stripDraftRefs(obj: unknown): unknown {
  if (typeof obj !== "object" || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(stripDraftRefs);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "$schema" || k === "http://json-schema.org/draft-07/schema") continue;
    out[k] = stripDraftRefs(v);
  }
  return out;
}

const openapiValidator = new Validator();

const ajvOpenRpc = new Ajv07({ strict: false, validateSchema: false, logger: false, allowUnionTypes: true });
addFormats(ajvOpenRpc as never);

const stubTools = {
  $id: "https://meta.json-schema.tools/",
  type: "object",
  definitions: { JSONSchemaObject: { type: "object", properties: { $ref: { type: "string" } } } }
};
ajvOpenRpc.addSchema(stubTools);
ajvOpenRpc.addSchema({ ...stubTools, $id: "https://meta.json-schema.tools" });

const validateOpenRpc13Compiler = ajvOpenRpc.compile(stripDraftRefs(openRpc13Schema) as any);

const ajv26 = new Ajv07({ strict: false, validateSchema: false, logger: false, allowUnionTypes: true });
addFormats(ajv26 as never);
const validateAsyncApi26Compiler = ajv26.compile(stripDraftRefs(asyncApi26Schema) as any);

const ajv30 = new Ajv07({ strict: false, validateSchema: false, logger: false, allowUnionTypes: true });
addFormats(ajv30 as never);
const validateAsyncApi30Compiler = ajv30.compile(stripDraftRefs(asyncApi30Schema) as any);

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

/**
 * Synchronously validates a spec document object against schema definitions.
 */
export function validateSpecDocumentSync(doc: unknown): ValidationResult {
  if (!isObject(doc)) {
    return { valid: false, errors: ["Document must be an object"] };
  }

  if (typeof doc.openapi === "string") {
    const version = String(doc.openapi);
    if (!version.startsWith("3.")) {
      return { valid: false, errors: [`Unsupported OpenAPI version '${version}'`] };
    }
    if (!isObject(doc.info) || typeof doc.info.title !== "string" || typeof doc.info.version !== "string") {
      return { valid: false, errors: ["OpenAPI document missing required info.title or info.version"] };
    }
    if (version.startsWith("3.0") && doc.paths === undefined) {
      return { valid: false, errors: ["OpenAPI 3.0 document requires paths object"] };
    }
    return { valid: true };
  }

  if (typeof doc.openrpc === "string") {
    const valid = Boolean(validateOpenRpc13Compiler(doc));
    if (valid) return { valid: true };
    const errs = validateOpenRpc13Compiler.errors?.map((e) => `${e.instancePath || "/"}: ${e.message}`) ?? ["Invalid OpenRPC document"];
    return { valid: false, errors: errs };
  }

  if (typeof doc.asyncapi === "string") {
    const version = String(doc.asyncapi);
    const compiler = version.startsWith("2.") ? validateAsyncApi26Compiler : validateAsyncApi30Compiler;
    const valid = Boolean(compiler(doc));
    if (valid) return { valid: true };
    const errs = compiler.errors?.map((e) => `${e.instancePath || "/"}: ${e.message}`) ?? ["Invalid AsyncAPI document"];
    return { valid: false, errors: errs };
  }

  return { valid: true };
}

/**
 * Asynchronously validates a spec document against official JSON schema meta-schemas.
 */
export async function validateSpecDocument(
  doc: unknown
): Promise<ValidationResult> {
  if (!isObject(doc)) {
    return { valid: false, errors: ["Document must be an object"] };
  }

  if (typeof doc.openapi === "string") {
    const res = await openapiValidator.validate(doc);
    if (res.valid) return { valid: true };
    const errs = res.errors?.map((e: any) => `${e.instancePath || "/"}: ${e.message}`) ?? ["Invalid OpenAPI document"];
    return { valid: false, errors: errs };
  }

  return validateSpecDocumentSync(doc);
}

/**
 * Synchronously asserts that a spec document is valid.
 */
export function assertValidSpecDocumentSync(
  doc: unknown,
  contextName = "Spec"
): void {
  const result = validateSpecDocumentSync(doc);
  if (!result.valid) {
    throw new Error(`[wiz] Generated ${contextName} document is invalid: ${(result.errors ?? []).join("; ")}`);
  }
}

/**
 * Asynchronously asserts that a spec document is valid.
 */
export async function assertValidSpecDocument(
  doc: unknown,
  contextName = "Spec"
): Promise<void> {
  const result = await validateSpecDocument(doc);
  if (!result.valid) {
    throw new Error(`[wiz] Generated ${contextName} document is invalid: ${(result.errors ?? []).join("; ")}`);
  }
}
