export type OpenApiDocument = Record<string, unknown>;

/**
 * Every transformed `bunRoutes`/`honoRoutes` callsite contributes one slice of
 * the API surface. They accumulate here so a program with routes spread across
 * many modules still exposes a single merged document.
 */
const fragments: OpenApiDocument[] = [];

export function mergeDocumentFragment(fragment: OpenApiDocument): void {
  fragments.push(fragment);
}

export function clearDocumentFragments(): void {
  fragments.length = 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merges two documents one level deeper than `Object.assign` for the three keys
 * where fragments genuinely overlap: `paths` (per path, then per method),
 * `components` (per component kind, then per name), and `tags` (appended).
 * Everything else is last-write-wins.
 */
function mergeInto(target: OpenApiDocument, source: OpenApiDocument): void {
  for (const [key, value] of Object.entries(source)) {
    if (key === "paths" && isPlainObject(value)) {
      const paths = isPlainObject(target.paths) ? target.paths : {};
      for (const [path, item] of Object.entries(value)) {
        const existing = paths[path];
        paths[path] =
          isPlainObject(existing) && isPlainObject(item)
            ? { ...existing, ...item }
            : item;
      }
      target.paths = paths;
      continue;
    }

    if (key === "components" && isPlainObject(value)) {
      const components = isPlainObject(target.components)
        ? target.components
        : {};
      for (const [kind, entries] of Object.entries(value)) {
        const existing = components[kind];
        components[kind] =
          isPlainObject(existing) && isPlainObject(entries)
            ? { ...existing, ...entries }
            : entries;
      }
      target.components = components;
      continue;
    }

    if (key === "tags" && Array.isArray(value)) {
      const tags = Array.isArray(target.tags) ? target.tags : [];
      target.tags = [...tags, ...value];
      continue;
    }

    target[key] = value;
  }
}

export function mergedDocument(): OpenApiDocument {
  const document: OpenApiDocument = {};
  for (const fragment of fragments) {
    mergeInto(document, fragment);
  }
  return document;
}
