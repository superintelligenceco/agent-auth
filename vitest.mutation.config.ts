import { defineConfig } from "vitest/config";

// Stryker runs only the scope engine's tests against each mutant of src/scope.
export default defineConfig({
  test: {
    include: ["test/scope/**/*.test.ts"],
    env: { FC_NUM_RUNS: "200" },
  },
});
