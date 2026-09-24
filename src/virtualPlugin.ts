import { dirname, join } from "node:path";
import type { BunPlugin } from "bun";
import { VIRTUAL_ENTRY } from "./generators/virtualGenerator.ts";
import type { WizLogger } from "./logger.ts";
import { getTypeModuleFiles } from "./registry.ts";

export type TransformSource = (options: { path: string; contents: string; logger: WizLogger }) => {
    code: string;
};

type Build = Parameters<NonNullable<BunPlugin["setup"]>>[0];

/** The mount every generated module lives under: `wiz-virtual/<key>/<file>`. */
const MOUNT = "wiz-virtual/";

const loaderFor = (file: string): "js" | "ts" => (file.endsWith(".ts") ? "ts" : "js");

/** Register Bun's resolve/load hooks for generated wiz modules and sources. */
export function setupVirtualModuleLifecycle(build: Build, logger: WizLogger, transformSource: TransformSource): void {
    build.onResolve({ filter: /wiz-virtual/ }, (args) => ({
        path: args.path,
        namespace: "wiz-virtual",
    }));

    // A relative import inside a mounted module must stay inside it: `./x.js`
    // from `wiz-virtual/<key>/index.js` names a sibling, not a file next to the
    // importer's original source. Bun hands us the specifier with the importer,
    // so the join is ours. Returning undefined lets every other relative import
    // in the build resolve the normal way.
    build.onResolve({ filter: /^\.\.?(\/|$)/ }, (args) => {
        if (!args.importer.includes(MOUNT)) {
            return undefined;
        }
        return {
            path: join(dirname(args.importer), args.path),
            namespace: "wiz-virtual",
        };
    });

    build.onLoad({ filter: /.*/, namespace: "wiz-virtual" }, (args) => {
        // The key is one path segment by construction - `getTypeKey` sanitizes it
        // - so the first slash after the mount ends it. A key that ever broke that
        // rule fails the lookup below, naming itself, rather than mounting wrong.
        const mounted = args.path.replace(/^\.?\//, "").slice(MOUNT.length);
        const boundary = mounted.indexOf("/");
        const key = boundary === -1 ? mounted : mounted.slice(0, boundary);
        const file = boundary === -1 ? VIRTUAL_ENTRY : mounted.slice(boundary + 1);

        const contents = getTypeModuleFiles(key)?.[file];
        if (contents === undefined) {
            const message = `[wiz] Virtual module for hash '${key}' has no file '${file}'.`;
            logger.error(message);
            throw new Error(message);
        }
        return { contents, loader: loaderFor(file) };
    });

    // Do not return contents for node_modules: doing so makes Bun treat CommonJS
    // dependencies as ESM and loses their default export.
    build.onLoad({ filter: /^(?!.*node_modules).*\.[jt]sx?$/ }, async (args) => {
        const loader: "ts" | "tsx" | "js" | "jsx" = args.path.endsWith(".tsx")
            ? "tsx"
            : args.path.endsWith(".jsx")
              ? "jsx"
              : args.path.endsWith(".ts")
                ? "ts"
                : "js";
        const contents = await Bun.file(args.path).text();
        const { code } = transformSource({ path: args.path, contents, logger });
        return { contents: code, loader };
    });
}
