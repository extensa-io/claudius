import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    name: "app",
    include: ["__tests__/**/*.test.ts", "lib/**/*.test.ts"],
  },
});
