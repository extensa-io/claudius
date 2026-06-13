import { describe, expect, it } from "vitest";
import { VERSION } from "./index";

describe("@claudius/shared", () => {
  it("exports VERSION", () => {
    expect(VERSION).toBe("0.0.0");
  });
});
