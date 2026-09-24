import { defineConfig } from "oxfmt";
import { oxfmt } from "oxc-config-mantine";

export default defineConfig({
  ...oxfmt,
  printWidth: 120,
  tabWidth: 4,
  singleQuote: false,
  endOfLine: "lf",
  trailingComma: "all",
  sortPackageJson: true,
  overrides: [
    {
      files: ["*.yaml", "*.yml", "**/*.yaml", "**/*.yml"],
      options: {
        tabWidth: 2,
      },
    },
  ],
  ignorePatterns: [
    ...(oxfmt.ignorePatterns ?? []),
    "dist/**",
    "wiz-virtual/**",
    "node_modules/**",
  ],
});
