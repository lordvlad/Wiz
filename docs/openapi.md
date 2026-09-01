# OpenAPI Document Generation

`wiz` generates OpenAPI 3.0 and 3.1 documents from your TypeScript types, routes, and operation signatures.

```ts
import { openapiSchema, op } from "wiz";

type User = { id: string; name: string };

export const userRoute = op<{
  path: { id: string };
  body: { name: string };
  response: User;
}>(async (req) => { ... });

export const doc = openapiSchema<[User]>({
  info: { title: "User API", version: "1.0.0" }
});
```

## Creating OpenAPI Schemas with `openapiSchema`

`openapiSchema<TTypes>(base?, options?)` produces an OpenAPI document containing `components.schemas` for the specified types:

```ts
const doc = openapiSchema<[User, Order]>({
  info: { title: "E-Commerce API", version: "1.0.0" },
  servers: [{ url: "https://api.example.com/v1" }]
});
```

`base` is an optional base document object. `wiz` merges the generated `components.schemas` into this base document.

### OpenAPI Dialects (3.0 vs 3.1)

Dialect versioning affects keyword choice in generated schemas (e.g., `nullable` in 3.0 vs type arrays `["string", "null"]` in 3.1, `format: byte` vs `contentEncoding: base64`).

Select the dialect version in options:

```ts
const doc30 = openapiSchema<[User]>(baseDoc, { version: "3.0" });
const doc31 = openapiSchema<[User]>(baseDoc, { version: "3.1" });

## Printing the OpenAPI Schema

To print or export the generated OpenAPI document as YAML when executing the file directly:

```ts
import { openapiSchema } from "wiz";
import type { User } from "./models.ts";

export const openapi = openapiSchema<[User]>({
  info: { title: "User API", version: "1.0.0" },
}, { version: "3.0" });

if (import.meta.main) {
  console.log(Bun.YAML.stringify(openapi, null, 2));
}
```

## Operation Specifications with `op`

The `op<TSpec>(handler, options?)` helper defines a typed operation endpoint:

```ts
export const getUser = op<{
  path: { id: string };
  query?: { verbose?: boolean };
  headers?: { "x-request-id"?: string };
  body?: CreateUserDto;
  response: User;
}>(async (req) => {
  return { id: req.path.id, name: "Alice" };
});
```

`op` slot options:
- `path`: Path parameters (mapped to OpenAPI `in: "path"` parameters, always required).
- `query`: Query string parameters (mapped to `in: "query"`).
- `headers`: Header parameters (mapped to `in: "header"`).
- `cookie`: Cookie parameters (mapped to `in: "cookie"`).
- `body`: Request body payload schema.
- `response`: Success response payload schema (status 200).

## Route Harvesting (Bun and Hono)

`wiz` automatically harvests routes from framework route maps during transpilation.

### Bun.serve Route Harvesting

```ts
import { openapiDocument } from "wiz";

const server = Bun.serve({
  routes: {
    "/api/users/:id": {
      GET: getUser,
      POST: createUser,
    },
  },
});

export const apiDoc = openapiDocument();
```

`wiz` inspects `Bun.serve` route definitions, extracts method handlers, converts route parameter syntax (`:id` -> `{id}`), and registers operations.

### Hono Route Harvesting

```ts
import { Hono } from "hono";
import { openapiSchema } from "wiz";

const app = new Hono();

app.get("/users/:id", getUser);
app.post("/users", createUser);

export const doc = openapiSchema.honoRoutes(app, {
  info: { title: "Hono API", version: "1.0.0" }
});
```

The plugin harvests Hono route registrations (`app.get`, `app.post`, `app.put`, `app.delete`, etc.), maps route parameters, and builds paths and components.

## Program-Wide Document with `openapiDocument()`

`openapiDocument()` merges all harvested routes and operations across your entire project into a single program-wide OpenAPI document.

```ts
// Merges all routes harvested in any file across the program
export const fullDocument = openapiDocument();
```

### Merging Rules

When merging multiple routes into a single document (`src/document.ts`):
1. **Paths**: Merged by route path. Methods (`GET`, `POST`, etc.) under the same path are combined.
2. **Components**: `components.schemas`, `components.parameters`, `components.responses`, and `components.headers` are merged by name. Identical component definitions are deduplicated.
3. **Tags**: Tag lists across all operations are concatenated and deduplicated.

## Multiple Status Codes and Media Types

To define multiple response status codes or media types, use detailed response specifications:

```ts
export const getFile = op<{
  path: { id: string };
  responses: {
    200: { content: { "application/json": User; "application/pdf": Uint8Array } };
    404: { content: { "application/json": { error: string } } };
  };
}>(async (req) => { ... });
```

## Validation

All generated OpenAPI documents are validated against the official OpenAPI v3.0 and v3.1 JSON Schemas during testing using `@seriousme/openapi-schema-validator`. See [verification](./verification.md).
