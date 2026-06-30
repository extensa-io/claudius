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

/** How a file is parsed. Source code is parsed identically to plain text. */
export type DocumentKind = "pdf" | "docx" | "text";

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
  return null;
}
