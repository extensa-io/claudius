import { describe, expect, it } from "vitest";
import { bangHost, buildHelpText, isHelpCommand, type BangView } from "./help";

const bangs: BangView[] = [
  { token: "g", host: "google.com" },
  { token: "gh", host: "github.com" },
];

describe("isHelpCommand", () => {
  it("accepts the command with surrounding whitespace and any casing", () => {
    expect(isHelpCommand("/help")).toBe(true);
    expect(isHelpCommand("  /HELP  ")).toBe(true);
    expect(isHelpCommand("/?")).toBe(true);
  });

  it("leaves real questions that merely start with the word alone", () => {
    // A prefix match here would swallow a legitimate turn.
    expect(isHelpCommand("/help me write a function")).toBe(false);
    expect(isHelpCommand("help")).toBe(false);
    expect(isHelpCommand("what does /help do?")).toBe(false);
    expect(isHelpCommand("?help")).toBe(false);
    expect(isHelpCommand("")).toBe(false);
  });
});

describe("bangHost", () => {
  it("reduces a template to a www-stripped host", () => {
    expect(bangHost("https://www.google.com/search?q={query}")).toBe(
      "google.com",
    );
    expect(bangHost("https://kagi.com/search?q={query}")).toBe("kagi.com");
  });

  it("falls back to the raw template when it will not parse", () => {
    expect(bangHost("not a url")).toBe("not a url");
  });
});

describe("buildHelpText", () => {
  it("lists every bang it is given", () => {
    const text = buildHelpText({ role: "member", bangs, canAttachImages: true });
    expect(text).toContain("`!g` google.com");
    expect(text).toContain("`!gh` github.com");
  });

  it("omits member-only features for guests", () => {
    const text = buildHelpText({ role: "guest", bangs, canAttachImages: false });
    expect(text).not.toContain("$SYMBOL");
    expect(text).not.toContain("Research");
    expect(text).not.toContain("paperclip");
    expect(text).not.toContain("incognito");
    // Guests still get the shortcuts and search that do work for them.
    expect(text).toContain("?word");
    expect(text).toContain("!bang");
    expect(text).toContain("Web search");
    expect(text).toContain("guest tier");
  });

  it("includes member features and omits the admin panel for members", () => {
    const text = buildHelpText({ role: "member", bangs, canAttachImages: true });
    expect(text).toContain("$SYMBOL");
    expect(text).toContain("Research");
    expect(text).toContain("incognito");
    expect(text).not.toContain("/admin");
    expect(text).not.toContain("guest tier");
  });

  it("mentions the admin panel only for admins", () => {
    const text = buildHelpText({ role: "admin", bangs, canAttachImages: true });
    expect(text).toContain("/admin");
  });

  it("mentions images only when the role and model allow them", () => {
    const on = buildHelpText({ role: "member", bangs, canAttachImages: true });
    const off = buildHelpText({ role: "member", bangs, canAttachImages: false });
    expect(on).toContain("attach a picture");
    expect(off).not.toContain("attach a picture");
  });

  it("drops the bang list rather than rendering an empty heading", () => {
    const text = buildHelpText({
      role: "member",
      bangs: [],
      canAttachImages: true,
    });
    expect(text).not.toContain("Available bangs");
  });
});
