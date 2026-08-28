import type { BunPlugin } from "bun";
import { getTypeModule } from "./registry.ts";
import type { WizLogger } from "./logger.ts";

export type TransformSource = (options: {
  path: string;
  contents: string;
  logger: WizLogger;
}) => { code: string };

type Build = Parameters<NonNullable<BunPlugin["setup"]>>[0];

/** Register Bun's resolve/load hooks for generated wiz modules and sources. */
export function setupVirtualModuleLifecycle(
  build: Build,
  logger: WizLogger,
  transformSource: TransformSource
): void {
  build.onResolve({ filter: /wiz-virtual/ }, (args) => ({
    path: args.path,
    namespace: "wiz-virtual",
  }));

  build.onLoad({ filter: /.*/, namespace: "wiz-virtual" }, (args) => {
    const hash = args.path
      .replace(/^.*wiz-virtual-?/, "")
      .replace(/^\//, "")
      .replace(/\.js$/, "");
    const contents = getTypeModule(hash);
    if (!contents) {
      const message = `[wiz] Virtual module for hash '${hash}' not found in registry.`;
      logger.error(message);
      throw new Error(message);
    }
    return { contents, loader: "js" };
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
