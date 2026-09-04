/**
 * Media-type serializers.
 *
 * These are hand-written on purpose: wiz derives the *contract* (which media
 * types an operation offers, and the schema of each payload), not the bytes for
 * every possible representation. JSON is structural, so `encodeJson<T>` is
 * generated; YAML and XML come from Bun; CSV is rolled here, over the keys
 * `keysOf<Pet>()` reports rather than a column list repeated by hand.
 */
import { encodeJson, keysOf } from "wiz";
import type { Pet } from "./model.ts";

export const JSON_MIME = "application/json";
export const YAML_MIME = "application/yaml";
export const XML_MIME = "application/xml";
export const CSV_MIME = "text/csv";
export const PROTO_MIME = "application/x-protobuf";

/** `Bun.XML.stringify` writes the element and nothing else, prolog included. */
const XML_PROLOG = '<?xml version="1.0" encoding="UTF-8"?>\n';

/** The CSV columns are the declared keys of `Pet`, in declaration order. */
const CSV_COLUMNS = keysOf<Pet>();

/**
 * Pets with every value a text format can carry directly.
 *
 * `bigint` and `Date` have no JSON form, so the generated codec decides one — a
 * decimal string for money, ISO 8601 for the timestamp — and YAML and CSV reuse
 * that decision instead of inventing a second one. It has to go through the
 * codec rather than a serializer hook because `Bun.YAML.stringify` refuses a
 * `bigint` outright and takes no replacer to convert it ("YAML.stringify does
 * not support the replacer argument", Bun 1.4). `Bun.XML.stringify` needs none
 * of this: it writes a `bigint` as digits and a `Date` as its ISO string.
 */
function wireRows(pets: Pet[]): Array<Record<string, unknown>> {
  return JSON.parse(encodeJson<Pet[]>(pets)) as Array<Record<string, unknown>>;
}

/** RFC 4180: double the quotes, and quote anything containing a delimiter. */
function csvCell(value: unknown): string {
  const text =
    value === undefined || value === null
      ? ""
      : Array.isArray(value)
        ? value.join(" ")
        : typeof value === "object"
          ? String((value as { email?: string }).email ?? "")
          : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function petsToCsv(pets: Pet[]): string {
  const rows = [CSV_COLUMNS.join(",")];
  for (const row of wireRows(pets)) {
    rows.push(CSV_COLUMNS.map((column) => csvCell(row[column])).join(","));
  }
  // A trailing newline: `wc -l` and every CSV reader expect one. Pushing an
  // empty row is one join rather than a join and a concatenation.
  rows.push("");
  return rows.join("\n");
}

/** Media types `GET /pets` can answer in, best first for `Accept: * / *`. */
export const LIST_REPRESENTATIONS: Array<{
  mimetype: string;
  render(pets: Pet[]): string;
}> = [
  { mimetype: JSON_MIME, render: (pets) => encodeJson<Pet[]>(pets, 2) },
  {
    mimetype: YAML_MIME,
    render: (pets) => Bun.YAML.stringify(wireRows(pets), null, 2),
  },
  {
    mimetype: XML_MIME,
    render: (pets) => XML_PROLOG + Bun.XML.stringify({ pets: { pet: pets } }, null, 2),
  },
  { mimetype: CSV_MIME, render: petsToCsv },
];

/**
 * Picks a representation for an `Accept` header.
 *
 * Quality values are honoured enough to be honest about content negotiation
 * without pretending to be a full RFC 9110 implementation.
 */
export function negotiate(accept: string | null): {
  mimetype: string;
  render(pets: Pet[]): string;
} {
  if (!accept || accept.trim() === "" || accept.includes("*/*")) {
    return LIST_REPRESENTATIONS[0]!;
  }

  const ranked = accept
    .split(",")
    .map((part) => {
      const [type, ...params] = part.trim().split(";");
      const q = params
        .map((p) => p.trim())
        .find((p) => p.startsWith("q="));
      return { type: (type ?? "").trim(), q: q ? Number(q.slice(2)) : 1 };
    })
    .filter((entry) => Number.isFinite(entry.q) && entry.q > 0)
    .sort((a, b) => b.q - a.q);

  for (const { type } of ranked) {
    const match = LIST_REPRESENTATIONS.find((r) => r.mimetype === type);
    if (match) return match;
  }
  return LIST_REPRESENTATIONS[0]!;
}
