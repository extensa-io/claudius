import { ChatBedrockConverse } from "@langchain/aws";
import { env } from "../env";

/**
 * The Haiku inference profile used for the cheapest possible liveness check.
 * Kept in sync with the seeded model catalog (settings.modelCatalog).
 */
const HAIKU_INFERENCE_PROFILE = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
}

export type BedrockHealth =
  | { ok: true; inputTokens: number | null; outputTokens: number | null }
  | { ok: false; error: string };

/**
 * A near-zero-cost probe that proves Bedrock connectivity and that our
 * credentials can invoke a Claude model via the Converse API. Capped at one
 * output token. Errors are reduced to a user-safe string; AWS internals never
 * leak past this boundary.
 */
export async function bedrockHealthProbe(): Promise<BedrockHealth> {
  try {
    const llm = new ChatBedrockConverse({
      model: HAIKU_INFERENCE_PROFILE,
      region: env.AWS_REGION,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      },
      maxTokens: 1,
      temperature: 0,
    });

    const response = await llm.invoke([["human", "ping"]]);

    // @langchain/core v1's generic message types infer usage_metadata as
    // `never` under the default structure, so we read it through an explicit
    // shape. The runtime value carries the Converse token counts.
    const usage = response.usage_metadata as TokenUsage | undefined;

    return {
      ok: true,
      inputTokens: usage?.input_tokens ?? null,
      outputTokens: usage?.output_tokens ?? null,
    };
  } catch {
    // Do not surface the underlying AWS/SDK error to callers.
    return { ok: false, error: "Bedrock probe failed" };
  }
}
