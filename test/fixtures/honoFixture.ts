import { Hono } from "hono";
import { openapiDocument, openapiSchema } from "../../src/index.ts";

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

export interface NoteService {
  /**
   * @get /notes
   * @response 200 Note[]
   */
  getNotes(query?: NoteQuery): Promise<Note[]>;
  /**
   * @post /notes
   * @service Note
   * @response 201 Note
   */
  createNote(body: NewNote): Promise<Note>;
  /**
   * @get /notes/{id}
   * @response 200 Note
   */
  getNote(id: number): Promise<Note>;
}

export const schema = openapiSchema<[NoteService]>({
  openapi: "3.1.0",
  info: { title: "Notes API", version: "2.0.0" },
});

export const app = openapiSchema.honoRoutes(
  new Hono(),
  { openapi: "3.1.0", info: { title: "Notes API", version: "2.0.0" } },
  {
    "/notes": {
      GET: (c: any) => c.json([{ id: 1, text: "hello" }]),
      POST: (c: any) => c.json({ id: 2, text: "made" }, 201),
    },
    "/notes/:id": {
      GET: (c: any) => c.json({ id: Number(c.req.param("id")), text: "one" }),
    },
  }
);

/** Resolved at build time; the test reads it from here. */
export const document = openapiDocument();
