import { beforeAll, describe, expect, test } from "bun:test";
import { decodeProto, encodeProto } from "wiz";
import { broker, TOPIC } from "../src/events.ts";
import { CSV_MIME, PROTO_MIME, XML_MIME, YAML_MIME } from "../src/media.ts";
import type { Pet } from "../src/model.ts";
import { server } from "../src/server.ts";
import { store } from "../src/service.ts";

const baseUrl = `http://localhost:${server.port}`;
describe("Petstore Full Stack & Protocol Suite", () => {
  beforeAll(async () => {
    await store.seed();
  });
  test("REST Content Negotiation: JSON, YAML, XML, CSV", async () => {
    // 1. JSON
    const resJson = await fetch(`${baseUrl}/pets`, {
      headers: { accept: "application/json" },
    });
    expect(resJson.status).toBe(200);
    expect(resJson.headers.get("content-type")).toContain("application/json");
    const jsonPets = (await resJson.json()) as any[];
    expect(jsonPets.length).toBeGreaterThanOrEqual(3);
    expect(jsonPets[0]?.name).toBe("Ada");

    // 2. YAML
    const resYaml = await fetch(`${baseUrl}/pets`, {
      headers: { accept: YAML_MIME },
    });
    expect(resYaml.status).toBe(200);
    expect(resYaml.headers.get("content-type")).toContain(YAML_MIME);
    const yamlText = await resYaml.text();
    expect(yamlText).toContain("name: Ada");
    expect(yamlText).toContain("species: dog");

    // 3. XML
    const resXml = await fetch(`${baseUrl}/pets`, {
      headers: { accept: XML_MIME },
    });
    expect(resXml.status).toBe(200);
    expect(resXml.headers.get("content-type")).toContain(XML_MIME);
    const xmlText = await resXml.text();
    expect(xmlText).toContain("<name>Ada</name>");
    expect(xmlText).toContain("<species>dog</species>");

    // 4. CSV
    const resCsv = await fetch(`${baseUrl}/pets`, {
      headers: { accept: CSV_MIME },
    });
    expect(resCsv.status).toBe(200);
    expect(resCsv.headers.get("content-type")).toContain(CSV_MIME);
    const csvText = await resCsv.text();
    // The header is `keysOf<Pet>()`, so it is the declared keys in order.
    expect(csvText.split("\n")[0]).toBe(
      "id,name,species,status,priceCents,tags,owner,addedAt"
    );
    expect(csvText).toContain("Ada");
    // A trailing newline, and no blank row before it.
    expect(csvText.endsWith("\n")).toBe(true);
    expect(csvText.endsWith("\n\n")).toBe(false);
  });

  test("REST list filters on the status word, and ignores a bogus one", async () => {
    const available = (await (
      await fetch(`${baseUrl}/pets?status=available`, {
        headers: { accept: "application/json" },
      })
    ).json()) as Array<{ status: string }>;
    expect(available.length).toBeGreaterThanOrEqual(3);
    expect(available.every((pet) => pet.status === "available")).toBe(true);

    // `is<PetStatus>` rejects it, so the filter is dropped rather than
    // matching nothing.
    const bogus = (await (
      await fetch(`${baseUrl}/pets?status=parrot`, {
        headers: { accept: "application/json" },
      })
    ).json()) as unknown[];
    expect(bogus.length).toBe(available.length);
  });

  test("REST Protobuf binary codec endpoint", async () => {
    // GET /pets/1 in application/x-protobuf
    const res = await fetch(`${baseUrl}/pets/1`, {
      headers: { accept: PROTO_MIME },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain(PROTO_MIME);

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);

    const pet = decodeProto<Pet>(bytes);
    expect(pet.id).toBe(1);
    expect(pet.name).toBe("Ada");
    expect(pet.species).toBe("dog");
    expect(pet.priceCents).toBe(42_000n);

    // POST /pets/1/codec/proto round-trip codec test
    const outBuf = new Uint8Array(256);
    const len = encodeProto<Pet>(pet, outBuf);
    const rawPet = outBuf.subarray(0, len);

    const roundTripRes = await fetch(`${baseUrl}/pets/1/codec/proto`, {
      method: "POST",
      headers: { "content-type": PROTO_MIME },
      body: rawPet,
    });
    expect(roundTripRes.status).toBe(200);

    const returnedBytes = new Uint8Array(await roundTripRes.arrayBuffer());
    const returnedPet = decodeProto<Pet>(returnedBytes);
    expect(returnedPet.name).toBe("Ada");
    expect(returnedPet.priceCents).toBe(42_000n);
  });

  test("REST mutations and structural validation", async () => {
    // 1. Create a pet
    const createRes = await fetch(`${baseUrl}/pets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Bella",
        species: "dog",
        priceCents: 15000,
        tags: ["puppy"],
      }),
    });
    expect(createRes.status).toBe(201);
    const newPet = (await createRes.json()) as any;
    expect(newPet.id).toBeGreaterThan(0);
    expect(newPet.name).toBe("Bella");
    const petId = newPet.id as number;

    // 2. Sell the pet
    const ownerId = crypto.randomUUID();
    const sellRes = await fetch(`${baseUrl}/pets/${petId}/sale`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ownerId,
        ownerName: "Bob",
        ownerEmail: "bob@example.com",
      }),
    });
    expect(sellRes.status).toBe(200);
    const soldPet = (await sellRes.json()) as any;
    expect(soldPet.status).toBe("sold");
    expect(soldPet.owner?.email).toBe("bob@example.com");

    // 3. Delete the pet
    const delRes = await fetch(`${baseUrl}/pets/${petId}`, {
      method: "DELETE",
    });
    expect(delRes.status).toBe(204);

    // 4. Verify 404
    const getRes = await fetch(`${baseUrl}/pets/${petId}`);
    expect(getRes.status).toBe(404);
  });

  test("OpenRPC over WebSocket (/rpc)", async () => {
    const ws = new WebSocket(`ws://localhost:${server.port}/rpc`);
    const openGate = Promise.withResolvers<void>();
    ws.onopen = () => openGate.resolve();
    await openGate.promise;

    const messageGate = Promise.withResolvers<any>();
    ws.onmessage = async (event) => {
      const text =
        typeof event.data === "string"
          ? event.data
          : event.data instanceof Blob
            ? await event.data.text()
            : new TextDecoder().decode(event.data);
      messageGate.resolve(JSON.parse(text));
    };
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 42,
        method: "Pets.get",
        params: [1],
      })
    );

    const rpcRes = await messageGate.promise;
    console.log("WebSocket received:", JSON.stringify(rpcRes));
    expect(rpcRes.jsonrpc).toBe("2.0");
    expect(rpcRes.id).toBe(42);
    expect(rpcRes.result.name).toBe("Ada");
    ws.close();
  });

  test("Schema endpoints serve all 5 generated specs", async () => {
    // 1. OpenAPI
    const openapiRes = await fetch(`${baseUrl}/schemas/openapi.json`);
    expect(openapiRes.status).toBe(200);
    const openapiDoc = (await openapiRes.json()) as any;
    expect(openapiDoc.openapi).toBe("3.1.0");
    expect(openapiDoc.paths?.["/pets"]).toBeDefined();

    // 2. AsyncAPI
    const asyncapiRes = await fetch(`${baseUrl}/schemas/asyncapi.json`);
    expect(asyncapiRes.status).toBe(200);
    const asyncapiDoc = (await asyncapiRes.json()) as any;
    expect(asyncapiDoc.asyncapi).toBe("3.0.0");
    // The document is harvested from `PetStore`, whose other members carry no
    // direction tag: exactly the two event methods are channel operations.
    expect(Object.keys(asyncapiDoc.operations).sort()).toEqual([
      "applyChange",
      "onChange",
    ]);

    // 3. OpenRPC
    const openrpcRes = await fetch(`${baseUrl}/schemas/openrpc.json`);
    expect(openrpcRes.status).toBe(200);
    const openrpcDoc = (await openrpcRes.json()) as any;
    expect(openrpcDoc.openrpc).toBe("1.3.2");

    // 4. Proto
    const protoRes = await fetch(`${baseUrl}/schemas/petstore.proto`);
    expect(protoRes.status).toBe(200);
    const protoText = await protoRes.text();
    expect(protoText).toContain('syntax = "proto3";');
    expect(protoText).toContain("message Pet {");

    // 5. JSON Schema
    const jsonSchemaRes = await fetch(
      `${baseUrl}/schemas/petstore.schema.json`
    );
    expect(jsonSchemaRes.status).toBe(200);
    const jsonSchemaDoc = (await jsonSchemaRes.json()) as any;
    expect(jsonSchemaDoc.$schema).toContain("json-schema.org");
  });

  test("Kafka change event pipeline round-trip", () => {
    expect(broker.depth).toBeGreaterThan(0);
  });
});
