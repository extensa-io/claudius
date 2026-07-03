import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    name: "worker",
    // Same rationale as the shared project: importing worker modules transitively
    // loads `@claudius/shared`'s `env`, which validates at module load. These
    // dummy values let pure-logic unit tests import freely without a real .env.
    // The worker needs only the base (both-runtime) vars, but seeding the full
    // set is harmless and keeps parity with the shared project's config.
    env: {
      MONGODB_URI:
        "mongodb+srv://user:pass@cluster.example.mongodb.net/claudius",
      AWS_ACCESS_KEY_ID: "akia-test",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      AWS_REGION: "us-east-1",
      TAVILY_API_KEY: "tvly-test",
      VOYAGE_API_KEY: "pa-test",
    },
  },
});
