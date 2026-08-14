import type { TypeIR } from "../types.ts";
import { generateKeysCode } from "./keys.ts";
import { generateSchemaCode } from "./schema.ts";
import { generateValidatorCode } from "./validator.ts";
import { generateOpenApiSchemaCode } from "./openapi.ts";
import type { ServiceIR } from "../ir/service.ts";
import {
  generateProtobufCode,
  generateProtobufSchemaCode,
} from "./protobuf.ts";
import { generateAvroCode, generateAvroSchemaCode } from "./avro.ts";

export interface VirtualModuleOptions {
  openApiTypes?: Array<{ name: string; ir: TypeIR }>;
  openApiVersion?: "3.0" | "3.1";
  /** Methods harvested from route maps or the path builder. */
  service?: ServiceIR;
  protobufSchemaTypes?: Array<{ name: string; ir: TypeIR }>;
  avroSchemaTypes?: Array<{ name: string; ir: TypeIR }>;
  /**
   * Export names to emit, when only some are wanted.
   *
   * A module serving a bundler carries every generator, because callsites in
   * other files share it by type key and a bundler drops what it does not use.
   * `wiz eject` inlines this code for a person to read, where several hundred
   * lines of unreachable codec is just noise.
   */
  only?: readonly string[];
}

/** Which exports each generated section provides. */
const SECTION_EXPORTS = {
  keys: ["keys", "requiredKeys", "optionalKeys"],
  schema: ["schema_draft2020", "schema_draft07"],
  validator: ["validate", "is"],
  openapi: ["openapiSchema"],
  protobuf: ["encodeProto", "decodeProto"],
  protobufSchema: ["protobufSchema"],
  avro: ["encodeAvro", "decodeAvro"],
  avroSchema: ["avroSchema"],
} as const;

export function generateVirtualModuleCode(
  ir: TypeIR,
  options?: VirtualModuleOptions
): string {
  const wanted = options?.only;
  const include = (section: keyof typeof SECTION_EXPORTS): boolean =>
    wanted === undefined ||
    SECTION_EXPORTS[section].some((name) => wanted.includes(name));

  const parts = [`// Auto-generated virtual module by wizPlugin`];

  if (include("keys")) parts.push(generateKeysCode(ir));
  if (include("schema")) parts.push(generateSchemaCode(ir));
  if (include("validator")) parts.push(generateValidatorCode(ir));
  if (include("protobuf")) parts.push(generateProtobufCode(ir));
  if (include("avro")) parts.push(generateAvroCode(ir));

  // An empty `openApiTypes` array is still a request for an OpenAPI document:
  // `openapiSchema<[]>(base, [...ops])` carries all its content in methods.
  if ((options?.openApiTypes || options?.service) && include("openapi")) {
    parts.push(
      generateOpenApiSchemaCode(
        options.openApiTypes ?? [],
        options.openApiVersion ?? "3.1",
        options.service
      )
    );
  }

  if (options?.protobufSchemaTypes?.length && include("protobufSchema")) {
    parts.push(generateProtobufSchemaCode(options.protobufSchemaTypes));
  }

  if (options?.avroSchemaTypes?.length && include("avroSchema")) {
    parts.push(generateAvroSchemaCode(options.avroSchemaTypes));
  }

  return parts.join("\n\n");
}
