/**
 * Shared, storage-agnostic constants and helpers for document ingestion. They
 * live in `shared` because both the Next.js routes (upload token, create,
 * parse) and the parsing pipeline need the same caps and the same notion of
 * "which files we accept" — defining them once keeps the upload gate and the
 * parser from disagreeing about what is allowed.
 */

/** Hard upload ceiling. Enforced at the Blob token and again before parsing. */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024; // 20 MB

/**
 * Cap on chunks per document. Two jobs: a defensive ceiling against pathological
 * files (a huge spreadsheet dumped to text, a minified bundle), and the lever
 * that keeps a parse inside the Vercel Hobby 60s function window — embedding is
 * the slow step, and the chunk count is known cheaply *before* embedding, so a
 * file that would exceed the budget fails fast with a clear message instead of
 * being killed mid-embed by a timeout. ~600 chunks comfortably embeds in well
 * under 60s; a normal 50-page PDF is a few hundred. Raise this once the Phase 4
 * worker takes ingestion off the request path.
 */
export const MAX_CHUNKS_PER_DOCUMENT = 600;

/**
 * How a file is handled. Source code is parsed identically to plain text.
 * "image" is the odd one out: it is not parsed at all. It skips the whole
 * text pipeline and is hydrated straight into a single model request (Phase 12).
 */
export type DocumentKind = "pdf" | "docx" | "text" | "image";

/**
 * The image types Bedrock accepts natively, as an extension -> MIME map (Phase
 * 12). This is the single source for the picker filter, the classifier, the
 * upload content type, and the media type on the hydrated content block, so
 * those four cannot drift apart.
 *
 * Deliberately short. HEIC (an iPhone default) and SVG are absent and stay
 * absent: Bedrock does not accept HEIC, and SVG is markup that can carry script
 * and remote references, which is not something to hand a fetcher.
 */
export const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

const IMAGE_EXTENSIONS = new Set(Object.keys(IMAGE_MIME_BY_EXTENSION));

/** The distinct MIME types of the above, for the upload allowlist. */
const IMAGE_CONTENT_TYPES = [
  ...new Set(Object.values(IMAGE_MIME_BY_EXTENSION)),
];

/**
 * Content types accepted at the Blob token boundary. Deliberately broad: many
 * source files arrive as text/plain or application/octet-stream, and browsers
 * disagree on MIME for code extensions. The authoritative filter is the
 * extension check in `classifyDocument` at the create-record step; this list is
 * only the coarse first gate Vercel Blob can enforce on the client token.
 */
export const ALLOWED_UPLOAD_CONTENT_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/*",
  "application/json",
  "application/octet-stream",
  // The four image types Bedrock accepts natively (Phase 12). Listed exactly,
  // not as "image/*", so HEIC and SVG are refused at the token boundary as well
  // as by the extension check.
  ...IMAGE_CONTENT_TYPES,
];

// Source-code and plain-text extensions we treat as text. Kept explicit (rather
// than "anything") so an unexpected binary is rejected rather than embedded as
// mojibake.
const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "mdx",
  "csv",
  "json",
  "yaml",
  "yml",
  "toml",
  "xml",
  "html",
  "css",
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "c",
  "h",
  "cpp",
  "hpp",
  "cc",
  "cs",
  "php",
  "swift",
  "scala",
  "sh",
  "bash",
  "sql",
  "r",
]);

/**
 * Every extension `classifyDocument` accepts, as a comma-separated `accept`
 * attribute for a file input. Derived from the same sets the classifier uses so
 * the picker and the server cannot drift: adding an extension above is enough to
 * make it selectable. This is a UX filter only (an `accept` attribute is
 * trivially bypassed), so it complements rather than replaces the server gate.
 */
export const UPLOAD_ACCEPT_ATTRIBUTE = [
  "pdf",
  "docx",
  ...TEXT_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
]
  .map((ext) => `.${ext}`)
  .join(",");

/**
 * The same list minus images, for a picker on a model that cannot see. Filtering
 * the picker is friendlier than accepting the file and rejecting it afterwards,
 * and the composer explains why alongside it.
 */
export const UPLOAD_ACCEPT_ATTRIBUTE_NO_IMAGES = ["pdf", "docx", ...TEXT_EXTENSIONS]
  .map((ext) => `.${ext}`)
  .join(",");

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
}

/**
 * Decide how to parse a file from its name, or return null if we do not accept
 * it. Extension-based on purpose: it is the one signal that is consistent across
 * browsers and is also what the parser dispatches on.
 */
export function classifyDocument(filename: string): DocumentKind | null {
  const ext = extensionOf(filename);
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return null;
}

/**
 * The MIME type to upload a file as, derived from its extension. Images must
 * carry their true type: it becomes the `media_type` on the content block sent
 * to Bedrock, and it is what the Blob-token allowlist checks. Everything else
 * keeps the pre-Phase-12 behaviour of declaring the coarse type the parser
 * expects, since the parser dispatches on extension regardless and text/code is
 * re-decoded as UTF-8 anyway.
 */
export function uploadContentTypeFor(filename: string): string {
  const ext = extensionOf(filename);
  if (ext === "pdf") return "application/pdf";
  if (ext === "docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  return IMAGE_MIME_BY_EXTENSION[ext] ?? "text/plain";
}
