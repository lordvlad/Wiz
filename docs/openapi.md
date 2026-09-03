# OpenAPI Document Generation

`wiz` generates OpenAPI 3.0 and 3.1 documents from your TypeScript types, service interfaces, and function signatures.

```ts
import { openapiSchema } from "wiz";

type User = { id: string; name: string };

export interface UserService {
  /**
   * @get /users/{id}
   * @response 200 User
   */
  getUser(params: { path: { id: string } }): Promise<User>;
}

export const doc = openapiSchema<[UserService]>({
  info: { title: "User API", version: "1.0.0" },
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

## Operation Specifications from Signatures

An operation is a method on an interface (or a standalone function signature).
Its JSDoc says where it lives; its parameter and return types say what it
carries.

```ts
export interface UserService {
  /**
   * Fetch a user.
   * @get /users/{id}
   * @response 200 User
   * @response 404 Not found Problem
   */
  getUser(params: {
    path: { id: string };
    query: { verbose?: boolean };
    header: { "x-request-id"?: string };
  }): Promise<User>;

  /**
   * @post /users
   * @response 201 User
   */
  createUser(body: CreateUserDto): Promise<User>;
}
```

### JSDoc tags

- `@get`, `@post`, `@put`, `@patch`, `@delete`, `@head`, `@options`, `@trace`:
  the HTTP verb and, after it, the path template (`@get /users/{id}`).
- `@http GET /users/{id}`: the same thing spelled as one tag.
- `@response STATUS [MEDIATYPE] [TYPE] [DESCRIPTION]`: one response.
  `@response 200 User`, `@response 200 application/pdf Blob`,
  `@response 404 Problem Not found`, `@response default Anything else`.
  Media type defaults to `application/json`.
- `@name`: overrides the operation id, which otherwise is the method name.
- `@package` / `@service`: emitted as `x-package` / `x-service`, and `service`
  also becomes the operation's OpenAPI tag. `@service` on the interface applies
  to every method; on a method it wins for that method.
- `@summary`, and the doc comment's prose as `description`; `@deprecated` marks
  the operation deprecated.

### Parameter slots

A single parameter whose type has any of the members below is taken apart into
parameters and a request body:

- `path`: path parameters (`in: "path"`, always required).
- `query`: query string parameters (`in: "query"`).
- `header`: header parameters (`in: "header"`).
- `cookie`: cookie parameters (`in: "cookie"`).
- `body`: the request body payload schema.

Otherwise each parameter is read on its own: one named `body` is the request
body, one whose name appears in the path template is a path parameter, and an
object-typed parameter is flattened into query parameters.

When no `@response` tag is present, the return type is the 200 response, and a
`void`/`never` return is a bodiless 204.

## Mounting Routes (Bun and Hono)

`openapiSchema.bunRoutes` and `openapiSchema.honoRoutes` mount a route map and
hand the value back verbatim, so runtime behaviour is identical to passing the
literal straight to `Bun.serve` or the Hono app. The document itself comes from
the service declarations, not from the route map: the two are kept apart so a
handler can be a plain function.

### Bun.serve

```ts
import { openapiSchema, openapiDocument } from "wiz";

export const routes = openapiSchema.bunRoutes(
  { openapi: "3.1.0", info: { title: "Users", version: "1.0.0" } },
  {
    "/users/:id": {
      GET: () => Response.json({ id: "1", name: "Alice" }),
    },
  }
);

Bun.serve({ routes });

export const apiDoc = openapiDocument();
```

Route keys are rewritten from Bun's `:id` form to OpenAPI's `{id}` template
form, and a path that no service documents is recorded as a bare operation.

### Hono

```ts
import { Hono } from "hono";
import { openapiSchema } from "wiz";

export const app = openapiSchema.honoRoutes(
  new Hono(),
  { openapi: "3.1.0", info: { title: "Hono API", version: "1.0.0" } },
  { "/users/:id": { GET: (c: any) => c.json({ id: "1" }) } }
);
```

## Program-Wide Document with `openapiDocument()`

`openapiDocument()` merges every operation declared anywhere in the import
graph into a single program-wide document. It is answered at compile time, so
the callsite becomes the finished document literal and nothing of `wiz`
reaches the bundle.

```ts
// Merges every service declared in any file reachable from this one
export const fullDocument = openapiDocument();
```

It also accepts type arguments and a base document of its own, which is the
form to reach for when a module declares operations but needs no schema value
at runtime:

```ts
export const document = openapiDocument<[UserService]>({
  openapi: "3.1.0",
  info: { title: "Users", version: "1.0.0" },
});
```

### Merging Rules

When merging multiple routes into a single document (`src/document.ts`):
1. **Paths**: Merged by route path. Methods (`GET`, `POST`, etc.) under the same path are combined.
2. **Components**: `components.schemas`, `components.parameters`, `components.responses`, and `components.headers` are merged by name. Identical component definitions are deduplicated.
3. **Tags**: Tag lists across all operations are concatenated and deduplicated.

## Multiple Status Codes and Media Types

Repeat `@response`; each tag is one response, and the optional media type sits
between the status and the payload type.

```ts
export interface FileService {
  /**
   * @get /files/{id}
   * @response 200 User
   * @response 200 application/pdf Blob
   * @response 404 Problem Not found
   */
  getFile(params: { path: { id: string } }): Promise<User>;
}
```

## Validation

All generated OpenAPI documents are validated against the official OpenAPI v3.0 and v3.1 JSON Schemas during testing using `@seriousme/openapi-schema-validator`. See [verification](./verification.md).
