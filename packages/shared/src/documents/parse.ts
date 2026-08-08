import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { get } from "@vercel/blob";
import mammoth from "mammoth";
import type { ObjectId } from "mongodb";
import { extractText } from "unpdf";
import { chunksCol, documentsCol } from "../db/collections";
import type { Chunk, DocumentRecord } from "../db/schemas";
import { embedTexts } from "../embeddings/voyage";
import { appEnv } from "../env";
import {
  classifyDocument,
  MAX_CHUNKS_PER_DOCUMENT,
  MAX_DOCUMENT_BYTES,
} from "./constants";

/**
 * The document ingestion pipeline: fetch the uploaded bytes from Blob, extract
 * text, chunk it, embed the chunks with Voyage, and store them for vector
 * search — advancing the document's status through `parsed` and `embedded`, or
 * landing it in `failed` with a readable reason.
 *
 * It is deliberately storage-agnostic and lives in `shared`: the Phase 4 worker
 * will call this exact function for large files instead of the Vercel route, so
 * there is one ingestion implementation, not two.
 */

// ~1000 chars (~250 tokens) per chunk with overlap so a fact split across a
// boundary still appears whole in at least one chunk. Sensible default across
// prose and code; not tuned per type in this phase.
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 150;

/** A piece of source text plus where it came from, before chunking. */
interface Section {
  text: string;
  /** Citation label, e.g. "p. 4". Null when the format has no natural unit. */
  pageOrSection: string | null;
}

async function setStatus(
  documentId: ObjectId,
  status: DocumentRecord["status"],
  failureReason?: string,
): Promise<void> {
  const col = await documentsCol();
  await col.updateOne(
    { _id: documentId },
    failureReason !== undefined
      ? { $set: { status, failureReason } }
      : // Clear any prior failure reason on a successful transition / retry.
        { $set: { status }, $unset: { failureReason: "" } },
  );
}

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  // The blob is in a PRIVATE store, so a plain fetch of its URL is forbidden;
  // we read it server-side with the SDK's authenticated get(). Private storage
  // is deliberate — these are user documents and must never be publicly fetchable
  // by URL (the app's per-user isolation extends to the raw files, not just chunks).
  const result = await get(url, {
    access: "private",
    token: appEnv().BLOB_READ_WRITE_TOKEN,
  });
  if (!result?.stream) {
    throw new Error("Could not fetch the uploaded file.");
  }
  const buf = await new Response(result.stream).arrayBuffer();
  if (buf.byteLength > MAX_DOCUMENT_BYTES) {
    throw new Error("File exceeds the 20 MB limit.");
  }
  return buf;
}

/** Extract raw text as one or more sections, depending on the file type. */
async function extractSections(
  document: DocumentRecord,
  bytes: ArrayBuffer,
): Promise<Section[]> {
  const kind = classifyDocument(document.filename);
  if (!kind) {
    throw new Error("Unsupported file type.");
  }
  // Images never enter the text pipeline (Phase 12): they are created "ready"
  // and hydrated into a single model request instead. Reaching here means a
  // caller tried to parse one, which is a bug rather than a user error — fail
  // loudly rather than producing an empty document with zero chunks.
  if (kind === "image") {
    throw new Error("Images are not parsed as text.");
  }

  if (kind === "pdf") {
    // mergePages:false keeps text per page, so each chunk can cite its page.
    const { text } = await extractText(new Uint8Array(bytes), {
      mergePages: false,
    });
    return text.map((pageText, i) => ({
      text: pageText,
      pageOrSection: `p. ${i + 1}`,
    }));
  }

  if (kind === "docx") {
    const { value } = await mammoth.extractRawText({
      buffer: Buffer.from(bytes),
    });
    return [{ text: value, pageOrSection: null }];
  }

  // Plain text and source code: decode as UTF-8 and treat as one section.
  const text = new TextDecoder().decode(bytes);
  return [{ text, pageOrSection: null }];
}

async function chunkSections(
  sections: Section[],
): Promise<Array<{ text: string; pageOrSection: string | null }>> {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
  });

  const chunks: Array<{ text: string; pageOrSection: string | null }> = [];
  for (const section of sections) {
    const pieces = await splitter.splitText(section.text);
    for (const piece of pieces) {
      const trimmed = piece.trim();
      if (trimmed.length === 0) continue; // skip blank pages / whitespace
      chunks.push({ text: trimmed, pageOrSection: section.pageOrSection });
    }
  }
  return chunks;
}

/**
 * Run the full pipeline for one already-uploaded document. Mutates the
 * document's status in the DB as it progresses and returns the terminal status.
 * Safe to re-run (retry): it clears any previously inserted chunks first, so a
 * failed-then-retried document never accumulates duplicates.
 */
export async function parseAndEmbedDocument(
  document: DocumentRecord,
): Promise<DocumentRecord["status"]> {
  const documentId = document._id;
  if (!documentId) throw new Error("Document has no id.");

  try {
    const bytes = await fetchBytes(document.blobUrl);
    const sections = await extractSections(document, bytes);
    const chunked = await chunkSections(sections);

    if (chunked.length === 0) {
      throw new Error("No readable text found in the file.");
    }
    // Fail fast and gracefully *before* the slow embedding step, so an oversized
    // file returns a clear message rather than being killed by the function
    // timeout. This is the function time-budget guard (see MAX_CHUNKS_PER_DOCUMENT).
    if (chunked.length > MAX_CHUNKS_PER_DOCUMENT) {
      throw new Error(
        "This file is too large to process on the current plan. Try splitting it into smaller files.",
      );
    }

    await setStatus(documentId, "parsed");

    const embeddings = await embedTexts(chunked.map((c) => c.text));
    const chunks: Chunk[] = chunked.map((c, i) => ({
      documentId,
      userId: document.userId,
      text: c.text,
      embedding: embeddings[i]!,
      pageOrSection: c.pageOrSection,
    }));

    const col = await chunksCol();
    // Idempotent retry: drop any chunks from a previous attempt before inserting.
    await col.deleteMany({ documentId });
    await col.insertMany(chunks);

    await setStatus(documentId, "embedded");
    return "embedded";
  } catch (err) {
    const reason =
      err instanceof Error ? err.message : "Parsing failed unexpectedly.";
    await setStatus(documentId, "failed", reason);
    return "failed";
  }
}
