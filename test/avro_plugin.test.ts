// @wiz-ignore
import { beforeAll, describe, expect, test } from "bun:test";
import { plugin } from "bun";
import { wizPlugin } from "../src/plugin.ts";
import { silentLogger } from "../src/logger.ts";
import {
  avroSchema,
  decodeAvro,
  encodeAvro,
  PluginInactiveError,
} from "../src/index.ts";

plugin(wizPlugin({ logger: silentLogger }));

interface Sample {
  id: number;
}

describe("avro stubs without the plugin", () => {
  test("every avro helper reports the inactive plugin", () => {
    expect(() => encodeAvro<Sample>({ id: 1 }, new Uint8Array(8))).toThrow(
      PluginInactiveError
    );
    expect(() => decodeAvro<Sample>(new Uint8Array(8))).toThrow(
      PluginInactiveError
    );
    expect(() => avroSchema<[Sample]>()).toThrow(PluginInactiveError);
  });
});

describe("avro end-to-end through the plugin", () => {
  let fixture: typeof import("./fixtures/avroFixture.ts");

  beforeAll(async () => {
    fixture = await import("./fixtures/avroFixture.ts");
  });

  test("avroSchema resolves to a parseable .avsc document", () => {
    const schema = JSON.parse(fixture.eventAvroSchema);

    expect(schema.type).toBe("record");
    expect(schema.name).toBe("Event");
    expect(schema.fields.map((f: any) => [f.name, f.type])).toEqual([
      // @format int64 narrows a JS number to an avro long.
      ["sequence", "long"],
      ["name", "string"],
      ["timestamp", "long"],
      ["tags", { type: "array", items: "string" }],
      // Optional properties become a null union.
      ["source", ["null", "string"]],
    ]);
    expect(
      schema.fields.find((f: any) => f.name === "timestamp").doc
    ).toContain("Wall-clock nanoseconds");
  });

  test("encode and decode round-trip through the transformed callsites", () => {
    const event = {
      sequence: 12345,
      name: "checkout",
      timestamp: 1739577600123456789n,
      tags: ["cart", "payment"],
      source: "web",
    };

    const buf = new Uint8Array(512);
    const written = fixture.encodeEvent(event, buf);
    expect(written).toBeGreaterThan(0);

    const decoded = fixture.decodeEvent(buf.subarray(0, written));
    expect(decoded).toEqual(event);
    // The nanosecond timestamp is well past 2^53 and must stay exact.
    expect(decoded.timestamp).toBe(1739577600123456789n);
  });

  test("an omitted optional decodes as null", () => {
    const event = {
      sequence: 1,
      name: "ping",
      timestamp: 1n,
      tags: [],
    } as any;

    const buf = new Uint8Array(256);
    const written = fixture.encodeEvent(event, buf);
    expect(fixture.decodeEvent(buf.subarray(0, written))).toEqual({
      ...event,
      source: null,
    });
  });
});
