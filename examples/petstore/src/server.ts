/**
 * The Petstore server.
 *
 * One Bun server that exposes every protocol and transport:
 * 1. REST API over HTTP with content negotiation (JSON, YAML, XML, CSV).
 * 2. Protobuf binary codec endpoint (`Accept: application/x-protobuf`).
 * 3. OpenRPC over WebSocket at `/rpc`.
 * 4. Static endpoints for all generated specs (OpenAPI, AsyncAPI, OpenRPC, .proto, JSON Schema).
 * 5. Kafka event producer and consumer round-tripping change events.
 */
import { Hono } from "hono";
import {
  decodeProto,
  encodeProto,
  openapiDocument,
  openapiSchema,
  openRPCHandler,
} from "wiz";
import { startConsumer, startProducer } from "./events.ts";
import {
  CSV_MIME,
  JSON_MIME,
  negotiate,
  petToJson,
  petsToCsv,
  petsToJson,
  petsToXml,
  petsToYaml,
  PROTO_MIME,
  XML_MIME,
  YAML_MIME,
} from "./media.ts";
import type { NewPet, Pet, Sale } from "./model.ts";
import { asyncapi } from "./schemas/asyncapi.ts";
import { jsonschema } from "./schemas/jsonschema.ts";
import { openapi } from "./schemas/openapi.ts";
import { openrpc } from "./schemas/openrpc.ts";
import { proto } from "./schemas/proto.ts";
import { InvalidError, NotFoundError, store } from "./service.ts";
startProducer(store);
startConsumer(store);
await store.seed();

function getIdFromUrl(req: Request): number {
  const url = new URL(req.url);
  const parts = url.pathname.split("/");
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "pets" && parts[i + 1]) {
      const parsed = parseInt(parts[i + 1]!, 10);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return NaN;
}

// OpenRPC handler over WebSocket
const rpc = openRPCHandler({
  services: { Pets: store },
  methods: {
    "Pets.getPet": (id: number) => store.get(id),
    "Pets.listPets": (query: any) => store.list(query),
    "Pets.addPet": (body: any) => store.add(body),
    "Pets.sellPet": (id: number, sale: any) => store.sell(id, sale),
  },
});
function handleResponse(
  fn: () => Response | Promise<Response>
): Promise<Response> {
  return Promise.resolve()
    .then(fn)
    .catch((err) => {
      if (err instanceof NotFoundError) {
        return Response.json(
          { status: 404, detail: err.message },
          { status: 404 }
        );
      }
      if (err instanceof InvalidError) {
        return Response.json(
          { status: 422, detail: err.message, errors: err.errors },
          { status: 422 }
        );
      }
      console.error(err);
      return Response.json(
        { status: 500, detail: "Internal Server Error" },
        { status: 500 }
      );
    });
}

// REST route map wrapped with openapiSchema.bunRoutes
const routes = openapiSchema.bunRoutes(
  { openapi: "3.1.0", info: { title: "Petstore", version: "1.0.0" } },
  {
    "/pets": {
      GET: (req: Request) =>
        handleResponse(() => {
          const url = new URL(req.url);
          const statusStr = url.searchParams.get("status");
          const q = url.searchParams.get("q") ?? undefined;
          const limitStr = url.searchParams.get("limit");

          const status = statusStr !== null ? Number(statusStr) : undefined;
          const limit = limitStr !== null ? Number(limitStr) : undefined;

          const pets = store.list({ status, q, limit });
          const rep = negotiate(req.headers.get("accept"));

          return new Response(rep.render(pets), {
            headers: { "content-type": rep.mimetype },
          });
        }),

      POST: (req: Request) =>
        handleResponse(async () => {
          const body = (await req.json()) as NewPet;
          const pet = await store.add(body);
          return new Response(petToJson(pet), {
            status: 201,
            headers: { "content-type": JSON_MIME },
          });
        }),
    },

    "/pets/:id": {
      GET: (req: Request, server: any) =>
        handleResponse(() => {
          const id = getIdFromUrl(req);
          const pet = store.get(id);

          const accept = req.headers.get("accept") ?? "";
          if (accept.includes(PROTO_MIME)) {
            const buf = new Uint8Array(512);
            const len = encodeProto<Pet>(pet, buf);
            return new Response(buf.subarray(0, len), {
              headers: { "content-type": PROTO_MIME },
            });
          }

          return new Response(petToJson(pet), {
            headers: { "content-type": JSON_MIME },
          });
        }),

      DELETE: (req: Request, server: any) =>
        handleResponse(async () => {
          const id = getIdFromUrl(req);
          await store.remove(id);
          return new Response(null, { status: 204 });
        }),
    },

    "/pets/:id/sale": {
      POST: (req: Request, server: any) =>
        handleResponse(async () => {
          const id = getIdFromUrl(req);
          const body = (await req.json()) as Sale;
          const pet = await store.sell(id, body);
          return new Response(petToJson(pet), {
            headers: { "content-type": JSON_MIME },
          });
        }),
    },

    "/pets/:id/codec/proto": {
      POST: (req: Request) =>
        handleResponse(async () => {
          const raw = new Uint8Array(await req.arrayBuffer());
          const decoded = decodeProto<Pet>(raw);
          const out = new Uint8Array(512);
          const len = encodeProto<Pet>(decoded, out);
          return new Response(out.subarray(0, len), {
            headers: { "content-type": PROTO_MIME },
          });
        }),
    },

    // Serve all 5 generated specs
    "/schemas/openapi.json": () =>
      Response.json(openapi, { headers: { "content-type": JSON_MIME } }),
    "/schemas/asyncapi.json": () =>
      Response.json(asyncapi, { headers: { "content-type": JSON_MIME } }),
    "/schemas/openrpc.json": () =>
      Response.json(openrpc, { headers: { "content-type": JSON_MIME } }),
    "/schemas/petstore.proto": () =>
      new Response(proto, { headers: { "content-type": "text/plain" } }),
    "/schemas/petstore.schema.json": () =>
      Response.json(jsonschema, { headers: { "content-type": JSON_MIME } }),
    "/rpc": (req: Request, srv: any) => {
      if (srv.upgrade(req)) return;
      return new Response("Upgrade failed", { status: 400 });
    },
  }
);

export const server = Bun.serve({
  port: Number(process.env.PORT ?? 0),
  routes,
  websocket: rpc.websocket,
});

console.log(`[petstore] server listening on http://localhost:${server.port}`);
