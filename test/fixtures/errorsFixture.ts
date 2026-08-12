import { op, openapiSchema } from "../../src/index.ts";

export interface User {
  id: number;
  name: string;
}

export interface NotFound {
  message: string;
}

export interface RateLimited {
  retryAfter: number;
}

export const routes = openapiSchema.bunRoutes(
  { openapi: "3.1.0", info: { title: "Users", version: "1.0.0" } },
  {
    "/users/:id": {
      GET: op<{
        path: { id: number };
        response: User;
        responses: {
          /** No such user */
          404: NotFound;
          /** Slow down */
          429: RateLimited;
          /** Anything else */
          default: never;
        };
      }>(() => Response.json({ id: 1, name: "Ada" })),
    },
  }
);
