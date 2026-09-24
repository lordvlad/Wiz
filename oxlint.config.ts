import { defineConfig } from "oxlint";
import { oxlint } from "oxc-config-mantine";

export default defineConfig({
  extends: [oxlint],
  rules: {
    ...oxlint.rules,
    radix: "off",
    "no-unused-vars": [
      "error",
      {
        args: "all",
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrors: "none",
        ignoreRestSiblings: true,
      },
    ],
    "typescript/no-unused-vars": [
      "error",
      {
        args: "all",
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrors: "none",
        ignoreRestSiblings: true,
      },
    ],
    "no-console": "off",
    "no-duplicate-imports": "off",
    "no-lonely-if": "off",
  },
  ignorePatterns: [
    "**/*.{mjs,cjs,js,d.ts,d.mts}",
    "node_modules/**",
    "dist/**",
    "wiz-virtual/**",
    "test/fixtures/**",
    "src/index.ts",
  ],
});
