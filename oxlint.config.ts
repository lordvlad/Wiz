import { defineConfig } from "oxlint";
import { oxlint } from "oxc-config-mantine";

export default defineConfig({
  extends: [oxlint],
  rules: {
    ...oxlint.rules,
    "no-console": "off",
    "no-unused-vars": "off",
    "typescript/no-unused-vars": "off",
    "no-duplicate-imports": "off",
    "no-lonely-if": "off",
  },
  ignorePatterns: [
    "**/*.{mjs,cjs,js,d.ts,d.mts}",
    "node_modules/**",
    "dist/**",
    "wiz-virtual/**",
    "test/fixtures/**",
  ],
});
