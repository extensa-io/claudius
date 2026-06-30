import { VoyageAIClient } from "voyageai";
import { z } from "zod";
import { env } from "../env";

/**
 * Voyage embeddings, the single embedding entry point for the whole app.
 *
 * Lives in `shared` on purpose: Phase 2 embeds document chunks here, Phase 3
 * embeds memories with the same helper, and the Phase 4 worker reuses it without
 * a second implementation. Keeping one helper also keeps the embedding *model*
 * and *dimensionality* in one place, which has to match the Atlas vector index
 * definition exactly (1024-dim cosine, see db/indexes.ts) — a mismatch there is
 * a silent retrieval failure, not a loud error.
 *
 * Voyage distinguishes the embedding of a *document* from the embedding of a
 * *query* (`inputType`); using the right one on each side measurably improves
 * retrieval. So we expose two functions rather than one generic embed().
 */

/** Must equal VECTOR_DIMENSIONS in db/indexes.ts and the index definitions. */
export const EMBEDDING_DIMENSIONS = 1024;

/** voyage-4 is the project's chosen embedding model (CLAUDE.md stack). */
const EMBEDDING_MODEL = "voyage-4";

// Voyage caps a single embed call at 128 inputs; we batch larger sets.
const MAX_BATCH = 128;

// Only the fields we depend on, validated at the boundary (CLAUDE.md: Zod on
// every external response). Voyage returns embeddings in request order, but we
// sort by `index` defensively rather than trust ordering.
const EmbedResponseSchema = z.object({
  data: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        embedding: z.array(z.number()),
      }),
    )
    .min(1),
});

let client: VoyageAIClient | null = null;
function getClient(): VoyageAIClient {
  client ??= new VoyageAIClient({ apiKey: env.VOYAGE_API_KEY });
  return client;
}

async function embedBatch(
  texts: string[],
  inputType: "document" | "query",
): Promise<number[][]> {
  const response = await getClient().embed({
    input: texts,
    model: EMBEDDING_MODEL,
    inputType,
    // Pin the output size to the index dimensionality rather than relying on the
    // model default, so the two can never drift.
    outputDimension: EMBEDDING_DIMENSIONS,
  });

  const parsed = EmbedResponseSchema.parse(response);
  if (parsed.data.length !== texts.length) {
    throw new Error(
      `Voyage returned ${parsed.data.length} embeddings for ${texts.length} inputs.`,
    );
  }
  return parsed.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

/**
 * Embed a list of document chunks for storage. Batches transparently to respect
 * Voyage's 128-input limit and returns vectors aligned to the input order.
 * An empty input returns an empty array without calling the API.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    const batch = texts.slice(i, i + MAX_BATCH);
    out.push(...(await embedBatch(batch, "document")));
  }
  return out;
}

/**
 * Embed a single search query. Uses Voyage's `query` input type, the correct
 * counterpart to the `document` embeddings stored for chunks and memories.
 */
export async function embedQuery(text: string): Promise<number[]> {
  const [embedding] = await embedBatch([text], "query");
  if (!embedding) throw new Error("Voyage returned no embedding for the query.");
  return embedding;
}
