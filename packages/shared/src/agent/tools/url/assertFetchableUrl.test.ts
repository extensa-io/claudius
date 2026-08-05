import { beforeEach, describe, expect, it, vi } from "vitest";

// Control DNS resolution so tests never touch the network. The synchronous
// rejections (scheme, name, IP literal) return before lookup is ever called;
// the resolve-to-private case drives it explicitly.
const lookup = vi.fn();
vi.mock("node:dns", () => ({ promises: { lookup: () => lookup() } }));

import { AppError } from "../../../errors";
import { assertFetchableUrl } from "./assertFetchableUrl";

async function rejectionCode(url: string): Promise<string | null> {
  try {
    await assertFetchableUrl(url);
    return null;
  } catch (err) {
    return err instanceof AppError ? err.code : "not-app-error";
  }
}

describe("assertFetchableUrl", () => {
  beforeEach(() => {
    lookup.mockReset();
    // Default: resolves to a public address, so a valid host passes.
    lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  it("accepts a normal https URL and returns the parsed URL", async () => {
    const url = await assertFetchableUrl("https://example.com/path");
    expect(url.hostname).toBe("example.com");
  });

  it("accepts http as well as https", async () => {
    await expect(assertFetchableUrl("http://example.com")).resolves.toBeInstanceOf(URL);
  });

  it("rejects a non-HTTP scheme (file://)", async () => {
    expect(await rejectionCode("file:///etc/passwd")).toBe("invalid_input");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("rejects the cloud metadata address 169.254.169.254", async () => {
    expect(
      await rejectionCode("http://169.254.169.254/latest/meta-data/"),
    ).toBe("invalid_input");
  });

  it("rejects loopback 127.0.0.1", async () => {
    expect(await rejectionCode("http://127.0.0.1:8080/")).toBe("invalid_input");
  });

  it("rejects private ranges (10/8, 192.168/16, 172.16/12)", async () => {
    expect(await rejectionCode("http://10.0.0.5/")).toBe("invalid_input");
    expect(await rejectionCode("http://192.168.1.1/")).toBe("invalid_input");
    expect(await rejectionCode("http://172.16.4.9/")).toBe("invalid_input");
  });

  it("rejects internal names (localhost, *.internal, *.local)", async () => {
    expect(await rejectionCode("http://localhost/")).toBe("invalid_input");
    expect(await rejectionCode("http://db.internal/")).toBe("invalid_input");
    expect(await rejectionCode("http://printer.local/")).toBe("invalid_input");
  });

  it("rejects IPv6 loopback ::1", async () => {
    expect(await rejectionCode("http://[::1]/")).toBe("invalid_input");
  });

  it("rejects a garbage string that isn't a URL", async () => {
    expect(await rejectionCode("not a url")).toBe("invalid_input");
  });

  it("rejects a public name that RESOLVES to a private address", async () => {
    lookup.mockResolvedValue([{ address: "10.1.2.3", family: 4 }]);
    expect(await rejectionCode("https://rebind.example.com/")).toBe(
      "invalid_input",
    );
  });

  it("does not block when DNS resolution fails (dead link, not SSRF)", async () => {
    lookup.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(
      assertFetchableUrl("https://nonexistent.example/"),
    ).resolves.toBeInstanceOf(URL);
  });
});
