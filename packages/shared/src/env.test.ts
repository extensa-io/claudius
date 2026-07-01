import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The env module validates process.env at import time, so each test seeds a
 * controlled environment and imports a fresh copy via resetModules.
 */
const VALID_ENV: Record<string, string> = {
  MONGODB_URI: "mongodb+srv://user:pass@cluster.example.mongodb.net/claudius",
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
};

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  vi.resetModules();
  process.env = { ...VALID_ENV };
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe("env", () => {
  it("parses a complete environment", async () => {
    const { env } = await import("./env");
    expect(env.ADMIN_EMAIL).toBe("admin@example.com");
    expect(env.AWS_REGION).toBe("us-east-1");
  });

  it("throws naming the missing variable, without leaking values", async () => {
    delete process.env.ADMIN_EMAIL;
    await expect(import("./env")).rejects.toThrow(/ADMIN_EMAIL/);
  });

  it("rejects an invalid MONGODB_URI", async () => {
    process.env.MONGODB_URI = "not-a-uri";
    await expect(import("./env")).rejects.toThrow(/MONGODB_URI/);
  });
});
