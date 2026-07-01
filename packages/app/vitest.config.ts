import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    name: "app",
    include: ["__tests__/**/*.test.ts", "lib/**/*.test.ts"],
    // Importing @claudius/shared loads its Zod env schema, which validates at
    // module load. These dummy values let tests import shared helpers without a
    // real .env, mirroring the shared workspace's test env.
    env: {
      MONGODB_URI:
        "mongodb+srv://user:pass@cluster.example.mongodb.net/claudius",
      AUTH_SECRET: "test-secret",
      AUTH_GOOGLE_ID: "google-id",
      AUTH_GOOGLE_SECRET: "google-secret",
      AWS_ACCESS_KEY_ID: "akia-test",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      AWS_REGION: "us-east-1",
      ADMIN_EMAIL: "admin@example.com",
      TAVILY_API_KEY: "tvly-test",
      VOYAGE_API_KEY: "pa-test",
      BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_test",
      CRON_SECRET: "cron-secret-test",
    },
  },
});
