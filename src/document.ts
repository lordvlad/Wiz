/**
 * Merging the OpenAPI fragments a program's routes contribute.
 *
 * This runs at build time only: the plugin harvests every route declaration
 * across the program and folds the result into the `openapiDocument()`
 * callsite as a literal. Nothing here reaches a bundle, which is why there is
 * no module-level accumulator - an import-time side effect would both pull the
 * runtime in and make the document depend on load order.
 */
export type OpenApiDocument = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merges two documents one level deeper than `Object.assign` for the three keys
 * where fragments genuinely overlap: `paths` (per path, then per method),
 * `components` (per component kind, then per name), and `tags` (appended).
 * Everything else is last-write-wins.
 */
function mergeInto(target: OpenApiDocument, source: OpenApiDocument): void {
  for (const [key, value] of Object.entries(source)) {
    if (key === 'paths' && isPlainObject(value)) {
      const paths = isPlainObject(target.paths) ? target.paths : {};
      for (const [path, item] of Object.entries(value)) {
        const existing = paths[path];
        if (isPlainObject(existing) && isPlainObject(item)) {
          const mergedPath: Record<string, unknown> = { ...existing };
          for (const [verb, op] of Object.entries(item)) {
            const exOp = existing[verb] as Record<string, unknown> | undefined;
            const newOp = op as Record<string, unknown> | undefined;
            if (isPlainObject(exOp) && isPlainObject(newOp)) {
              const mergedOp: Record<string, unknown> = { ...exOp, ...newOp };
              if (exOp.parameters && !newOp.parameters) {
                mergedOp.parameters = exOp.parameters;
              }
              if (exOp.requestBody && !newOp.requestBody) {
                mergedOp.requestBody = exOp.requestBody;
              }
              const exResponses = isPlainObject(exOp.responses)
                ? (exOp.responses as Record<string, unknown>)
                : undefined;
              const newResponses = isPlainObject(newOp.responses)
                ? (newOp.responses as Record<string, unknown>)
                : undefined;
              // When an existing operation has rich response definitions (e.g. 200 with body)
              // and a new fragment only has a default void/no-content 204, preserve the
              // richer response definition.
              if (exResponses && newResponses && '204' in newResponses && !('204' in exResponses)) {
                mergedOp.responses = exResponses;
              }
              mergedPath[verb] = mergedOp;
            } else {
              mergedPath[verb] = op;
            }
          }
          paths[path] = mergedPath;
        } else {
          paths[path] = item;
        }
      }
      target.paths = paths;
      continue;
    }

    if (key === 'components' && isPlainObject(value)) {
      const components = isPlainObject(target.components) ? target.components : {};
      for (const [kind, entries] of Object.entries(value)) {
        const existing = components[kind];
        components[kind] =
          isPlainObject(existing) && isPlainObject(entries) ? { ...existing, ...entries } : entries;
      }
      target.components = components;
      continue;
    }

    if (key === 'tags' && Array.isArray(value)) {
      const tags = Array.isArray(target.tags) ? target.tags : [];
      target.tags = [...tags, ...value];
      continue;
    }

    target[key] = value;
  }
}

/** Folds fragments left to right into one document. */
export function mergeDocuments(fragments: OpenApiDocument[]): OpenApiDocument {
  const document: OpenApiDocument = {};
  for (const fragment of fragments) {
    mergeInto(document, fragment);
  }
  return document;
}
