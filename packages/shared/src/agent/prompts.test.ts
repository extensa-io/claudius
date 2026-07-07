import { describe, expect, it } from "vitest";
import { currentDateLine } from "./prompts";

/**
 * The current-date line is the fix for the model answering "what day is it?"
 * from its training cutoff. It's a pure function of `now`, so we can pin its
 * formatting and its UTC handling exactly.
 */
describe("currentDateLine", () => {
  it("formats the date and time in UTC with the weekday", () => {
    // 2026-07-06T14:03:00Z is a Monday.
    const line = currentDateLine(new Date("2026-07-06T14:03:00Z"));
    expect(line).toContain("Monday");
    expect(line).toContain("6 July 2026");
    expect(line).toContain("14:03");
    expect(line).toContain("UTC");
  });

  it("renders in UTC regardless of the input's zone offset", () => {
    // Same instant expressed with an offset; must still read as 14:03 UTC, not
    // the local wall-clock time of the offset.
    const line = currentDateLine(new Date("2026-07-06T10:03:00-04:00"));
    expect(line).toContain("14:03");
    expect(line).toContain("Monday");
  });

  it("tells the model to trust it over training data", () => {
    const line = currentDateLine(new Date("2026-07-06T14:03:00Z"));
    expect(line.toLowerCase()).toContain("trust this over");
    expect(line.toLowerCase()).toContain("training");
  });
});
