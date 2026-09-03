import { openapiDocument, openapiSchema } from "../../src/index.ts";

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

export interface ProductService {
  /**
   * @get /products
   * @response 200 Product[]
   */
  getProducts(query?: ProductQuery): Promise<Product[]>;
  /**
   * @post /products
   * @response 201 Created Product
   * @response 422 Rejected Problem
   */
  createProduct(body: Product): Promise<Product>;
  /**
   * @get /products/{id}
   * @response 200 Product
   * @response 404 No such product Problem
   */
  getProduct(id: string): Promise<Product>;
  /**
   * @delete /products/{id}
   * @response 204
   */
  deleteProduct(id: string): Promise<void>;
}

export const schema = openapiSchema<[ProductService]>({
  openapi: "3.1.0",
  info: { title: "Catalogue", version: "2.0.0" },
});

export const routes = openapiSchema.bunRoutes(
  { openapi: "3.1.0", info: { title: "Catalogue", version: "2.0.0" } },
  {
    "/products": {
      GET: () => Response.json([]),
      POST: () => Response.json({}, { status: 201 }),
    },
    "/products/:id": {
      GET: () => Response.json({}),
      DELETE: () => new Response(null, { status: 204 }),
    },
  }
);

/** Resolved at build time; the test reads it from here. */
export const document = openapiDocument();
