import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { chunksCol, documentsCol } from "../../db/collections";
import { embedQuery } from "../../embeddings/voyage";

/**
 * The agent's document-RAG tool: semantic search over the chunks of the
 * documents attached to *this* conversation.
 *
 * The query is embedded with Voyage (query-side embedding), then matched against
 * `chunks_vector` with Atlas Vector Search. Two filters are applied as a
 * PRE-filter inside $vectorSearch, never as a post-filter (CLAUDE.md invariant
 * #1, and a vector search must never even consider another user's vectors):
 *   - userId: the owner, taken from the run config, never from the model.
 *   - documentId ∈ the conversation's attached, embedded documents.
 * Both are filter fields on the index, so the pre-filter is index-supported.
 */

const TOP_K = 6;
const NUM_CANDIDATES = 150;

const retrieveSchema = z.object({
  query: z
    .string()
    .describe(
      "A focused natural-language query describing what to find in the attached documents.",
    ),
});

/** What we hand back to the model (and the UI), one entry per matched chunk. */
export interface RetrievedChunk {
  text: string;
  documentName: string;
  location: string | null;
}

/** Config the chat route must populate for this tool to run. */
interface RetrieveConfigurable {
  userId?: string;
  attachedDocumentIds?: string[];
}

interface ChunkSearchHit {
  text: string;
  pageOrSection: string | null;
  documentId: ObjectId;
}

export const retrieveDocumentsTool = tool(
  async ({ query }, config: RunnableConfig): Promise<string> => {
    const configurable = (config.configurable ?? {}) as RetrieveConfigurable;
    const { userId, attachedDocumentIds } = configurable;

    // Defensive: the tool is only bound when documents are attached, but never
    // run an unscoped vector search if that contract is somehow broken.
    if (!userId || !attachedDocumentIds || attachedDocumentIds.length === 0) {
      return JSON.stringify({ results: [] });
    }

    const ownerId = new ObjectId(userId);
    const documentIds = attachedDocumentIds.map((id) => new ObjectId(id));

    const queryVector = await embedQuery(query);

    const col = await chunksCol();
    const hits = (await col
      .aggregate([
        {
          $vectorSearch: {
            index: "chunks_vector",
            path: "embedding",
            queryVector,
            numCandidates: NUM_CANDIDATES,
            limit: TOP_K,
            // Pre-filter: owner AND this conversation's documents only.
            filter: {
              userId: { $eq: ownerId },
              documentId: { $in: documentIds },
            },
          },
        },
        {
          $project: {
            _id: 0,
            text: 1,
            pageOrSection: 1,
            documentId: 1,
          },
        },
      ])
      .toArray()) as ChunkSearchHit[];

    if (hits.length === 0) return JSON.stringify({ results: [] });

    // Resolve document names for citation. Scoped by userId again as defense in
    // depth, even though the chunks were already owner-filtered above.
    const docsCol = await documentsCol();
    const docs = await docsCol
      .find(
        { _id: { $in: documentIds }, userId: ownerId },
        { projection: { filename: 1 } },
      )
      .toArray();
    const nameById = new Map(docs.map((d) => [d._id!.toString(), d.filename]));

    const results: RetrievedChunk[] = hits.map((h) => ({
      text: h.text,
      documentName: nameById.get(h.documentId.toString()) ?? "document",
      location: h.pageOrSection,
    }));

    return JSON.stringify({ results });
  },
  {
    name: "retrieve_documents",
    description:
      "Search the documents the user attached to this conversation and return the most relevant excerpts, each with its document name and location (e.g. page). Use this whenever the question may be answered by an attached document. Cite the document name and location in your answer.",
    schema: retrieveSchema,
  },
);
