import { op, openapiSchema } from "../../src/index.ts";

export interface User {
  id: number;
  /**
   * @minLength 2
   */
  name: string;
}

export interface UserQuery {
  /**
   * Free text search
   */
  q?: string;
  limit?: number;
}

export interface NewUser {
  name: string;
}

const statusResponse = new Response("OK");

export const routes = openapiSchema.bunRoutes(
  { openapi: "3.0.3", info: { title: "Users API", version: "1.0.0" } },
  {
    "/api/status": statusResponse,

    "/users": {
      GET: op<{ query: UserQuery; response: User[] }>(() =>
        Response.json([])
      ),
      POST: op<{ body: NewUser; response: User; status: 201 }>(
        () => Response.json({ id: 1, name: "Alice" }),
        { tags: ["User"] }
      ),
    },

    "/users/:id": {
      GET: op<{ path: { id: number }; response: User }>(() =>
        Response.json({ id: 1, name: "Alice" })
      ),
      DELETE: op<{ path: { id: number } }>(() => new Response(null)),
    },
  }
);
