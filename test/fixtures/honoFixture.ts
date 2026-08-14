import { Hono } from "hono";
import { op, openapiDocument, openapiSchema } from "../../src/index.ts";

export interface Note {
  id: number;
  /**
   * @minLength 1
   */
  text: string;
}

export interface NoteQuery {
  tag?: string;
}

export interface NewNote {
  text: string;
}

export const app = openapiSchema.honoRoutes(
  new Hono(),
  { openapi: "3.1.0", info: { title: "Notes API", version: "2.0.0" } },
  {
    "/notes": {
      GET: op<{ query: NoteQuery; response: Note[] }>((c: any) =>
        c.json([{ id: 1, text: "hello" }])
      ),
      POST: op<{ body: NewNote; response: Note; status: 201 }>(
        (c: any) => c.json({ id: 2, text: "made" }, 201),
        { tags: ["Note"] }
      ),
    },

    "/notes/:id": {
      GET: op<{ path: { id: number }; response: Note }>((c: any) =>
        c.json({ id: Number(c.req.param("id")), text: "one" })
      ),
    },
  }
);

/** Resolved at build time; the test reads it from here. */
export const document = openapiDocument();
