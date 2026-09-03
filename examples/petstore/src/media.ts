/**
 * Media-type serializers.
 *
 * These are hand-written on purpose: wiz derives the *contract* (which media
 * types an operation offers, and the schema of each payload), not the bytes for
 * every possible representation. JSON is structural, so `encodeJson<T>` is
 * generated; YAML comes from Bun; XML and CSV are rolled here.
 */
import { encodeJson } from "wiz";
import { PetStatus, Species, type Pet } from "./model.ts";

export const JSON_MIME = "application/json";
export const YAML_MIME = "application/yaml";
export const XML_MIME = "application/xml";
export const CSV_MIME = "text/csv";
export const PROTO_MIME = "application/x-protobuf";

/** `bigint` and `Date` have no JSON form, so the generated codec decides one. */
export function petsToJson(pets: Pet[]): string {
  return encodeJson<Pet[]>(pets, 2);
}

export function petToJson(pet: Pet): string {
  return encodeJson<Pet>(pet, 2);
}

/** A plain object with every value YAML can carry directly. */
function plain(pet: Pet): Record<string, unknown> {
  return {
    id: pet.id,
    name: pet.name,
    species: Species[pet.species],
    status: PetStatus[pet.status],
    priceCents: pet.priceCents.toString(),
    tags: pet.tags,
    owner: pet.owner ?? null,
    addedAt: pet.addedAt.toISOString(),
  };
}

export function petsToYaml(pets: Pet[]): string {
  return Bun.YAML.stringify(pets.map(plain));
}

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

function xmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch]!);
}

function petToXmlBody(pet: Pet, indent: string): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(plain(pet))) {
    if (value === null) continue;
    if (Array.isArray(value)) {
      lines.push(`${indent}<${key}>`);
      for (const item of value) {
        lines.push(`${indent}  <tag>${xmlEscape(String(item))}</tag>`);
      }
      lines.push(`${indent}</${key}>`);
      continue;
    }
    if (typeof value === "object") {
      lines.push(`${indent}<${key}>`);
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        lines.push(`${indent}  <${k}>${xmlEscape(String(v))}</${k}>`);
      }
      lines.push(`${indent}</${key}>`);
      continue;
    }
    lines.push(`${indent}<${key}>${xmlEscape(String(value))}</${key}>`);
  }
  return lines;
}

export function petsToXml(pets: Pet[]): string {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', "<pets>"];
  for (const pet of pets) {
    lines.push("  <pet>");
    lines.push(...petToXmlBody(pet, "    "));
    lines.push("  </pet>");
  }
  lines.push("</pets>");
  return lines.join("\n");
}

/** RFC 4180: double the quotes, and quote anything containing a delimiter. */
function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const CSV_COLUMNS = [
  "id",
  "name",
  "species",
  "status",
  "priceCents",
  "tags",
  "owner",
  "addedAt",
] as const;

export function petsToCsv(pets: Pet[]): string {
  const rows = [CSV_COLUMNS.join(",")];
  for (const pet of pets) {
    const flat = plain(pet);
    rows.push(
      CSV_COLUMNS.map((column) => {
        const value = flat[column];
        if (column === "tags") return csvCell((value as string[]).join(" "));
        if (column === "owner") {
          return csvCell(value === null ? "" : (value as { email: string }).email);
        }
        return csvCell(value);
      }).join(",")
    );
  }
  // A trailing newline: `wc -l` and every CSV reader expect one.
  return `${rows.join("\n")}\n`;
}

/** Media types `GET /pets` can answer in, best first for `Accept: * / *`. */
export const LIST_REPRESENTATIONS: Array<{
  mimetype: string;
  render(pets: Pet[]): string;
}> = [
  { mimetype: JSON_MIME, render: petsToJson },
  { mimetype: YAML_MIME, render: petsToYaml },
  { mimetype: XML_MIME, render: petsToXml },
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
