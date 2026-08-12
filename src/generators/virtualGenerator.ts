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
}

export function generateVirtualModuleCode(
  ir: TypeIR,
  options?: VirtualModuleOptions
): string {
  const keysCode = generateKeysCode(ir);
  const schemaCode = generateSchemaCode(ir);
  const validatorCode = generateValidatorCode(ir);
  const protoCode = generateProtobufCode(ir);
  const avroCode = generateAvroCode(ir);

  const parts = [
    `// Auto-generated virtual module by wizPlugin`,
    keysCode,
    schemaCode,
    validatorCode,
    protoCode,
    avroCode,
  ];

  // An empty `openApiTypes` array is still a request for an OpenAPI document:
  // `openapiSchema<[]>(base, [...ops])` carries all its content in methods.
  if (options?.openApiTypes || options?.service) {
    const openapiCode = generateOpenApiSchemaCode(
      options.openApiTypes ?? [],
      options.openApiVersion ?? "3.1",
      options.service
    );
    parts.push(openapiCode);
  }

  if (options?.protobufSchemaTypes && options.protobufSchemaTypes.length > 0) {
    const protoSchemaCode = generateProtobufSchemaCode(
      options.protobufSchemaTypes
    );
    parts.push(protoSchemaCode);
  }

  if (options?.avroSchemaTypes && options.avroSchemaTypes.length > 0) {
    parts.push(generateAvroSchemaCode(options.avroSchemaTypes));
  }

  return parts.join("\n\n");
}
