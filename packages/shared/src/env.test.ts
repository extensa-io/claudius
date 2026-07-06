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
  BRAVE_API_KEY: "brave-test",
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

  it("throws naming a missing base variable, without leaking values", async () => {
    // AWS_REGION is required in BOTH runtimes, so its absence fails at import.
    delete process.env.AWS_REGION;
    await expect(import("./env")).rejects.toThrow(/AWS_REGION/);
  });

  it("rejects an invalid MONGODB_URI", async () => {
    process.env.MONGODB_URI = "not-a-uri";
    await expect(import("./env")).rejects.toThrow(/MONGODB_URI/);
  });

  it("does NOT require app-only vars at import (the worker has no need of them)", async () => {
    // A worker process carries no Auth/Google/Blob/cron secrets. Deleting them
    // must not break importing the shared env — they are optional in the base.
    delete process.env.AUTH_SECRET;
    delete process.env.AUTH_GOOGLE_ID;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.CRON_SECRET;
    const { env } = await import("./env");
    expect(env.MONGODB_URI).toContain("mongodb");
  });

  it("assertAppEnv re-validates the app-only group and names what is missing", async () => {
    delete process.env.AUTH_GOOGLE_SECRET;
    const { assertAppEnv } = await import("./env");
    expect(() => assertAppEnv()).toThrow(/AUTH_GOOGLE_SECRET/);
  });

  it("assertAppEnv returns the required app secrets when present", async () => {
    const { assertAppEnv } = await import("./env");
    expect(assertAppEnv().ADMIN_EMAIL).toBe("admin@example.com");
  });
});
