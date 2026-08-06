import { describe, expect, it } from "vitest";
import {
  ALLOWED_UPLOAD_CONTENT_TYPES,
  classifyDocument,
  UPLOAD_ACCEPT_ATTRIBUTE,
  UPLOAD_ACCEPT_ATTRIBUTE_NO_IMAGES,
  sniffImageMime,
  uploadContentTypeFor,
} from "./constants";

/**
 * The upload gate is defined once and read by the picker, the Blob token, the
 * create-record step, and the parser. These tests pin the pieces that must agree
 * — particularly which image types are in and, more importantly, which are out.
 */

describe("classifyDocument", () => {
  it("classifies the four supported image types", () => {
    for (const name of ["a.jpg", "a.jpeg", "a.png", "a.gif", "a.webp"]) {
      expect(classifyDocument(name)).toBe("image");
    }
  });

  it("is case-insensitive about the extension", () => {
    expect(classifyDocument("PHOTO.JPG")).toBe("image");
  });

  it("rejects HEIC and SVG", () => {
    // HEIC is an iPhone default Bedrock does not accept; SVG is markup that can
    // carry script and remote references. Both must fail the extension check,
    // not just the picker filter, since `accept` is trivially bypassed.
    expect(classifyDocument("photo.heic")).toBeNull();
    expect(classifyDocument("diagram.svg")).toBeNull();
  });

  it("still classifies documents and code as before", () => {
    expect(classifyDocument("report.pdf")).toBe("pdf");
    expect(classifyDocument("notes.docx")).toBe("docx");
    expect(classifyDocument("server.ts")).toBe("text");
  });
});

describe("uploadContentTypeFor", () => {
  it("sends the real MIME type for images", () => {
    // This is what becomes mime_type on the content block, and what the
    // Blob-token allowlist checks — it can no longer be flattened to text/plain.
    expect(uploadContentTypeFor("a.jpg")).toBe("image/jpeg");
    expect(uploadContentTypeFor("a.jpeg")).toBe("image/jpeg");
    expect(uploadContentTypeFor("a.png")).toBe("image/png");
    expect(uploadContentTypeFor("a.webp")).toBe("image/webp");
  });

  it("keeps the pre-existing behaviour for everything else", () => {
    expect(uploadContentTypeFor("a.pdf")).toBe("application/pdf");
    expect(uploadContentTypeFor("a.ts")).toBe("text/plain");
  });
});

describe("upload allowlists", () => {
  it("accepts each image MIME type exactly, never image/*", () => {
    expect(ALLOWED_UPLOAD_CONTENT_TYPES).toContain("image/jpeg");
    expect(ALLOWED_UPLOAD_CONTENT_TYPES).toContain("image/png");
    expect(ALLOWED_UPLOAD_CONTENT_TYPES).not.toContain("image/*");
    expect(ALLOWED_UPLOAD_CONTENT_TYPES).not.toContain("image/heic");
    expect(ALLOWED_UPLOAD_CONTENT_TYPES).not.toContain("image/svg+xml");
  });

  it("offers image extensions in the picker, and a variant without them", () => {
    expect(UPLOAD_ACCEPT_ATTRIBUTE).toContain(".png");
    expect(UPLOAD_ACCEPT_ATTRIBUTE_NO_IMAGES).not.toContain(".png");
    // The no-images variant is for a model that cannot see; documents still work.
    expect(UPLOAD_ACCEPT_ATTRIBUTE_NO_IMAGES).toContain(".pdf");
  });
});

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);
const GIF = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0,
]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
]);

describe("sniffImageMime", () => {
  it("reads the format from the magic bytes", () => {
    expect(sniffImageMime(JPEG)).toBe("image/jpeg");
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(GIF)).toBe("image/gif");
    expect(sniffImageMime(WEBP)).toBe("image/webp");
  });

  it("returns null for bytes it does not recognise", () => {
    expect(sniffImageMime(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    // RIFF without the WEBP tag is some other RIFF container, not an image.
    expect(
      sniffImageMime(
        new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20]),
      ),
    ).toBeNull();
  });
});
