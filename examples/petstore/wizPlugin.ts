import { plugin } from "bun";
import { wizPlugin } from "wiz/plugin";

// Preloaded by bunfig.toml for both `bun run` and `bun test`, so every module
// loaded afterwards is transformed. A schema entrypoint prints nothing useful
// without this: the helpers throw `PluginInactiveError` instead.
plugin(wizPlugin());
