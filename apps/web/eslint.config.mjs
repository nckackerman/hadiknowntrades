import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // OpenNext's own generated Lambda build output (issue #6's real web
    // Lambda) -- same "never lint generated/bundled output" reasoning as
    // .next/** above, not source this repo owns.
    ".open-next/**",
  ]),
]);

export default eslintConfig;
