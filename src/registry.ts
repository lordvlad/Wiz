import {
  generateVirtualModuleCode,
  type VirtualModuleOptions,
} from "./generators/virtualGenerator.ts";
import type { TypeIR } from "./types.ts";

export interface RegisteredType {
  ir: TypeIR;
  generatedCode: string;
}

const TypeRegistry = new Map<string, RegisteredType>();

export function registerType(
  hash: string,
  ir: TypeIR,
  options?: VirtualModuleOptions
): RegisteredType {
  const existing = TypeRegistry.get(hash);
  if (existing) {
    // Generator-specific payloads (OpenAPI types/operations, protobuf schema
    // types) are not part of the type key, so they force a regeneration.
    const carriesGeneratorPayload =
      Boolean(options?.openApiTypes) ||
      Boolean(options?.service?.methods.length) ||
      Boolean(options?.protobufSchemaTypes?.length);

    if (carriesGeneratorPayload) {
      const generatedCode = generateVirtualModuleCode(ir, options);
      const registered = { ir, generatedCode };
      TypeRegistry.set(hash, registered);
      return registered;
    }
    return existing;
  }

  const generatedCode = generateVirtualModuleCode(ir, options);
  const registered: RegisteredType = { ir, generatedCode };
  TypeRegistry.set(hash, registered);
  return registered;
}

export function getTypeModule(hash: string): string | undefined {
  return TypeRegistry.get(hash)?.generatedCode;
}

export function clearTypeRegistry(): void {
  TypeRegistry.clear();
}
