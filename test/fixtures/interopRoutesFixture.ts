import { op, openapiSchema } from "../../src/index.ts";

export interface Product {
  /** @format uuid */
  id: string;
  /**
   * @minLength 1
   * @maxLength 200
   */
  title: string;
  /** @format int64 */
  cents: bigint;
  releasedAt: Date;
  labels: string[];
}

export interface Problem {
  detail: string;
}

export interface ProductQuery {
  /** @minimum 1 */
  page?: number;
}

export const routes = openapiSchema.bunRoutes(
  { openapi: "3.1.0", info: { title: "Catalogue", version: "2.0.0" } },
  {
    "/products": {
      GET: op<{ query: ProductQuery; response: Product[] }>(() => Response.json([])),
      POST: op<{
        body: Product;
        responses: {
          /** Created */
          201: Product;
          /** Rejected */
          422: Problem;
        };
      }>(() => Response.json({}, { status: 201 })),
    },
    "/products/:id": {
      GET: op<{
        path: { id: string };
        response: Product;
        responses: {
          /** No such product */
          404: Problem;
        };
      }>(() => Response.json({})),
      DELETE: op<{ path: { id: string }; status: 204 }>(() => new Response(null, { status: 204 })),
    },
  }
);
