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
import {
  decodeProto,
  encodeJson,
  encodeProto,
  is,
  openRPCHandler,
} from "wiz";
import { startConsumer, startProducer } from "./events.ts";
import {
  CSV_MIME,
  JSON_MIME,
  negotiate,
  PROTO_MIME,
  XML_MIME,
  YAML_MIME,
} from "./media.ts";
import type { NewPet, Pet, PetStatus, Sale } from "./model.ts";
import { asyncapi } from "./schemas/asyncapi.ts";
import { jsonschema } from "./schemas/jsonschema.ts";
import { openapi } from "./schemas/openapi.ts";
import { openrpc } from "./schemas/openrpc.ts";
import { proto } from "./schemas/proto.ts";
import { InvalidError, NotFoundError, problemOf, store } from "./service.ts";
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

// OpenRPC over WebSocket. The store is registered as one service, so every
// method it declares is dispatchable as `Pets.<method>` - the same names
// `openRPCSchema<[PetApi]>` puts in the document, since both read `PetApi`.
const rpc = openRPCHandler({ services: { Pets: store } });
function handleResponse(
  fn: () => Response | Promise<Response>
): Promise<Response> {
  return Promise.resolve()
    .then(fn)
    .catch((err) => {
      if (err instanceof NotFoundError || err instanceof InvalidError) {
        return Response.json(problemOf(err), { status: err.status });
      }
      console.error(err);
      return Response.json(
        { status: 500, detail: "Internal Server Error" },
        { status: 500 }
      );
    });
}

// The REST route map, handed straight to `Bun.serve`. The OpenAPI document is
// derived from `PetApi` in `src/schemas/openapi.ts`, not from this literal:
// paths are what the router needs, and types are what a document needs.
const routes = {
  "/pets": {
    GET: (req: Request) =>
      handleResponse(() => {
        const url = new URL(req.url);
        const statusStr = url.searchParams.get("status");
        const q = url.searchParams.get("q") ?? undefined;
        const limitStr = url.searchParams.get("limit");

        // A status is one of three words now, so it is checked structurally
        // rather than parsed: `is<PetStatus>` is generated from the union.
        const status =
          statusStr !== null && is<PetStatus>(statusStr) ? statusStr : undefined;
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
        return new Response(encodeJson<Pet>(pet, 2), {
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

        return new Response(encodeJson<Pet>(pet, 2), {
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
        return new Response(encodeJson<Pet>(pet, 2), {
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
};

export const server = Bun.serve({
  port: Number(process.env.PORT ?? 0),
  routes,
  websocket: rpc.websocket,
});

console.log(`[petstore] server listening on http://localhost:${server.port}`);
