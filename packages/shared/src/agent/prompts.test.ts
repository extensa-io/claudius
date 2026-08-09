import { describe, expect, it } from "vitest";
import { currentDateLine, userSettingsNote } from "./prompts";

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

/**
 * The user-authored settings block. This is the layer the user typed themselves,
 * so it must be injected verbatim, only when present, and must assert precedence
 * over inferred memory — that precedence is the entire reason the feature exists.
 */
describe("userSettingsNote", () => {
  it("returns null when neither field is set", () => {
    expect(
      userSettingsNote({ preferredName: null, instructions: null }),
    ).toBeNull();
  });

  it("treats whitespace-only fields as unset", () => {
    expect(
      userSettingsNote({ preferredName: "   ", instructions: "\n\t " }),
    ).toBeNull();
  });

  it("renders the preferred name as a direct address", () => {
    const note = userSettingsNote({
      preferredName: "Néstor",
      instructions: null,
    });
    expect(note).toContain("Néstor");
    expect(note).toContain("prefers to be called");
  });

  it("injects the instructions verbatim inside a delimited block", () => {
    const instructions = "Always answer in metric units.\nBe terse.";
    const note = userSettingsNote({ preferredName: null, instructions });
    expect(note).toContain("<user_instructions>");
    expect(note).toContain(instructions);
    expect(note).toContain("</user_instructions>");
  });

  it("states that these instructions outrank recalled memory", () => {
    const note = userSettingsNote({
      preferredName: null,
      instructions: "Be terse.",
    });
    expect(note?.toLowerCase()).toContain("precedence");
  });

  it("includes both fields when both are set", () => {
    const note = userSettingsNote({
      preferredName: "Néstor",
      instructions: "Be terse.",
    });
    expect(note).toContain("Néstor");
    expect(note).toContain("Be terse.");
  });

  /**
   * An incognito turn withholds the instructions and keeps the name, so the
   * name-only shape is a real prompt this time, not a corner case: it must not
   * announce instructions that were deliberately left out, or the model reads a
   * missing section and asks about it.
   */
  it("does not announce instructions when only the name is set", () => {
    const note = userSettingsNote({
      preferredName: "Néstor",
      instructions: null,
    });
    expect(note).toContain("Néstor");
    expect(note).not.toContain("<user_instructions>");
    expect(note?.toLowerCase()).not.toContain("personal instructions");
    expect(note?.toLowerCase()).not.toContain("precedence");
  });
});
