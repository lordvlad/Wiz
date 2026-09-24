// @wiz-ignore
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ejectFile, ejectProject, writeEjected } from "../src/cli/eject.ts";

/**
 * `wiz eject` writes what the plugin would have handed to Bun.
 *
 * The claim worth testing is not the text but the behaviour: an ejected tree
 * has to run on its own, with no plugin registered and nothing imported from
 * wiz. So each case runs its own output.
 */

const dirs: string[] = [];
const workspace = async () => {
    const dir = await mkdtemp(join(tmpdir(), "wiz-eject-"));
    dirs.push(dir);
    return dir;
};

afterEach(async () => {
    for (const dir of dirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const TSCONFIG = JSON.stringify({
    compilerOptions: {
        target: "ESNext",
        module: "Preserve",
        moduleResolution: "bundler",
        strict: true,
        noEmit: true,
        allowImportingTsExtensions: true,
    },
    include: ["src"],
});

const USER = `import { is, keysOf, validate } from "wiz";

export interface User {
  /** @minLength 2 */
  name: string;
  age?: number;
}

export const keys = keysOf<User>();
export const ok = is<User>({ name: "Ada" });
export const short = is<User>({ name: "A" });
export const errors = validate<User>({ name: "A" });
`;

describe("ejecting a single file", () => {
    test("inlines the generated code, so the output stands alone", async () => {
        const dir = await workspace();
        const source = join(dir, "user.ts");
        await Bun.write(source, USER);

        const code = ejectFile(source, USER);
        const out = join(dir, "user.ejected.ts");
        await Bun.write(out, code);

        const built = await import(pathToFileURL(out).href);
        expect(built.keys).toEqual(["name", "age"]);
        expect(built.ok).toBe(true);
        expect(built.short).toBe(false);
        expect(built.errors.map((e: { path: string }) => e.path)).toEqual(["name"]);
    });

    test("nothing is imported from wiz any more", async () => {
        const dir = await workspace();
        const source = join(dir, "user.ts");
        await Bun.write(source, USER);

        const code = ejectFile(source, USER);
        expect(code).not.toMatch(/from\s+"wiz"/);
        expect(code).not.toContain("keysOf");
    });

    test("only the generators the file uses are inlined", async () => {
        const dir = await workspace();
        const source = join(dir, "user.ts");
        await Bun.write(source, USER);

        const code = ejectFile(source, USER);
        // Validating and listing keys pulls in neither codec nor a schema document.
        expect(code).toContain("function validate(");
        expect(code).not.toContain("encodeProto");
        expect(code).not.toContain("encodeAvro");
        expect(code).not.toContain("schema_draft2020");
    });

    test("a type-only import from wiz survives, because it still typechecks", async () => {
        const dir = await workspace();
        const source = join(dir, "shape.ts");
        const text = `import type { NumberedUnion } from "wiz";
import { is } from "wiz";

export interface Circle { kind: "circle"; radius: number }
export interface Square { kind: "square"; side: number }
export type Shape = NumberedUnion<{ 1: Circle; 2: Square }>;

export const ok = is<Circle>({ kind: "circle", radius: 1 });
`;
        await Bun.write(source, text);

        const code = ejectFile(source, text);
        expect(code).toContain(`import type { NumberedUnion } from "wiz"`);
        // The value import is gone; only the type reference remains.
        expect(code).not.toMatch(/^import \{ is \} from "wiz";$/m);
    });

    test("refuses a file whose document needs the rest of the program", async () => {
        const dir = await workspace();
        const source = join(dir, "doc.ts");
        const text = `import { openapiDocument } from "wiz";\nexport const document = openapiDocument();\n`;
        await Bun.write(source, text);

        expect(() => ejectFile(source, text)).toThrow("eject it as a project");
    });

    test("a file with nothing for wiz to do comes back unchanged", async () => {
        const dir = await workspace();
        const source = join(dir, "plain.ts");
        const text = `export const answer = 42;\n`;
        await Bun.write(source, text);

        expect(ejectFile(source, text)).toBe(text);
    });
});

describe("ejecting a project", () => {
    const project = async () => {
        const dir = await workspace();
        await Bun.write(join(dir, "tsconfig.json"), TSCONFIG);
        await Bun.write(
            join(dir, "src", "types.ts"),
            `export interface User {\n  /** @minLength 2 */\n  name: string;\n}\n`,
        );
        await Bun.write(
            join(dir, "src", "api.ts"),
            `import type { User } from "./types.ts";

export interface UserApi {
  /**
   * @get /users
   * @response 200 User[]
   */
  getUsers(): Promise<User[]>;
}
`,
        );
        await Bun.write(
            join(dir, "src", "main.ts"),
            `import { is, openapiDocument } from "wiz";
import type { User } from "./types.ts";
import type { UserApi } from "./api.ts";

export const document = openapiDocument<[UserApi]>({
  openapi: "3.1.0",
  info: { title: "Demo", version: "1.0.0" },
});
export const ok = is<User>({ name: "Ada" });
`,
        );
        return dir;
    };

    test("the ejected tree runs with no plugin and no wiz", async () => {
        const dir = await project();
        const out = join(dir, "out");
        await writeEjected(out, ejectProject(dir));

        // Deferred on purpose: the path is a temp directory created by this test,
        // so no static specifier can name it.
        const main = await import(pathToFileURL(join(out, "src", "main.ts")).href);
        expect(main.ok).toBe(true);
        // The document is data by now, resolved across the whole program.
        expect(main.document.info).toEqual({ title: "Demo", version: "1.0.0" });
        expect(Object.keys(main.document.paths)).toEqual(["/users"]);
    });

    test("files the tsconfig includes are all present, transformed or not", async () => {
        const dir = await project();
        const paths = ejectProject(dir).map((file) => file.path);

        expect(paths).toContain("src/main.ts");
        expect(paths).toContain("src/api.ts");
        // Untouched, but still copied, or the tree would not run.
        expect(paths).toContain("src/types.ts");
    });

    test("generated modules are named for the type, not the build machine", async () => {
        const dir = await project();
        const generated = ejectProject(dir)
            .map((file) => file.path)
            .filter((path) => path.includes("wiz-"));

        expect(generated).toHaveLength(1);
        expect(generated[0]).toMatch(/^src\/wiz-User-[0-9a-f]+\/index\.js$/);
    });

    test("the document is inlined, so nothing imports wiz at runtime", async () => {
        const dir = await project();
        const main = ejectProject(dir).find((file) => file.path === "src/main.ts")!;

        expect(main.contents).not.toContain("openapiDocument");
        expect(main.contents).not.toMatch(/from\s+"wiz"/);
        // The paths are a literal in the file now, not a call that rebuilds them.
        expect(main.contents).toContain('"/users"');
    });

    test("a directory without a tsconfig is refused", async () => {
        const dir = await workspace();
        expect(() => ejectProject(dir)).toThrow("no tsconfig.json");
    });
});
