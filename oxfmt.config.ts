import { defineConfig } from "oxfmt";
import { oxfmt } from "oxc-config-mantine";

export default defineConfig({
  ...oxfmt,
  ignorePatterns: [...(oxfmt.ignorePatterns ?? []), "dist/**", "wiz-virtual/**", "node_modules/**"],
});
