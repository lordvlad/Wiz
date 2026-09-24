// @wiz-ignore
import { describe, expect, test } from "bun:test";
import { silentLogger } from "../src/logger.ts";
import { transformSource } from "../src/plugin.ts";
import { evalModule } from "./helpers.ts";

/**
 * Several `@response` tags can share a status and differ only in media type.
 * That is one response object with several `content` entries; emitting one
 * response per tag meant the last tag was the only one documented.
 */
describe("a status offered in several media types", () => {
    const doc = (): Record<string, any> => {
        const source = `
      import { openapiSchema } from "./src/index.ts";

      export interface Pet { id: number; name: string }

      export interface PetService {
        /**
         * @get /pets/{id}
         * @response 200 application/json Pet
         * @response 200 application/xml Pet
         * @response 200 text/csv Pet
         * @response 404 Not found
         */
        getPet(params: { path: { id: number } }): Promise<Pet>;
      }

      export const schema = openapiSchema<[PetService]>({
        openapi: "3.1.0",
        info: { title: "Pets", version: "1.0.0" },
      });
    `;

        const res = transformSource({
            path: "app.ts",
            contents: source,
            logger: silentLogger,
        });
        const code = Array.from(res.modules.values())[0]!.files["index.js"]!;
        return evalModule<{ openapiSchema: (base?: any) => any }>(code).openapiSchema();
    };

    test("every media type reaches the one response object", () => {
        const ok = doc().paths["/pets/{id}"].get.responses["200"];
        expect(Object.keys(ok.content).sort()).toEqual(["application/json", "application/xml", "text/csv"]);
    });

    test("each media type carries the payload schema", () => {
        const content = doc().paths["/pets/{id}"].get.responses["200"].content;
        for (const mediatype of Object.keys(content)) {
            expect(content[mediatype].schema).toEqual({
                $ref: "#/components/schemas/Pet",
            });
        }
    });

    test("a status declared once is unaffected", () => {
        const responses = doc().paths["/pets/{id}"].get.responses;
        expect(Object.keys(responses).sort()).toEqual(["200", "404"]);
        expect(responses["404"].description).toBe("Not found");
        expect(responses["404"].content).toBeUndefined();
    });
});
