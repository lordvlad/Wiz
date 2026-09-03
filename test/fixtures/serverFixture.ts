import { openapiDocument, openapiSchema } from "../../src/index.ts";

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

export interface UserService {
  /**
   * @get /users
   * @response 200 User[]
   */
  getUsers(query?: UserQuery): Promise<User[]>;
  /**
   * @post /users
   * @service User
   * @response 201 User
   */
  createUser(body: NewUser): Promise<User>;
  /**
   * @get /users/{id}
   * @response 200 User
   */
  getUser(id: number): Promise<User>;
  /**
   * @delete /users/{id}
   * @response 204
   */
  deleteUser(id: number): Promise<void>;
}

export const schema = openapiSchema<[UserService]>({
  openapi: "3.0.3",
  info: { title: "Users API", version: "1.0.0" },
});

const statusResponse = new Response("OK");

export const routes = openapiSchema.bunRoutes(
  { openapi: "3.0.3", info: { title: "Users API", version: "1.0.0" } },
  {
    "/api/status": statusResponse,
    "/users": {
      GET: () => Response.json([]),
      POST: () => Response.json({ id: 1, name: "Alice" }),
    },
    "/users/:id": {
      GET: () => Response.json({ id: 1, name: "Alice" }),
      DELETE: () => new Response(null),
    },
  }
);

/** Resolved at build time; the test reads it from here. */
export const document = openapiDocument();
