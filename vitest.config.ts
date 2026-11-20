import { defineConfig } from "vitest/config";

// eslint-disable-next-line no-restricted-syntax -- vitest requires a default export
export default defineConfig({
  // The package's `main` is a UMD build that vitest cannot import as a module.
  resolve: { alias: { "@panzoom/panzoom": "@panzoom/panzoom/dist/panzoom.es.js" } },
  test: { environment: "happy-dom", include: ["test/**/*.test.ts"] },
});
