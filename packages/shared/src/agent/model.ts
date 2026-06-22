import { ChatBedrockConverse } from "@langchain/aws";
import { env } from "../env";

/** Default output ceiling per turn. Generous for chat, bounded for cost. */
const DEFAULT_MAX_TOKENS = 4096;

export interface BuildChatModelOptions {
  maxTokens?: number;
  /**
   * Sampling temperature. Left UNSET by default on purpose: the newest models
   * (e.g. Opus 4.8) reject `temperature` outright with a ValidationException, so
   * we only send it when a caller explicitly opts in (and only for models known
   * to accept it, like Haiku for title generation). Chat runs omit it and let
   * each model use its own default.
   */
  temperature?: number;
}

/**
 * Construct a Bedrock chat model bound to a specific cross-region inference
 * profile (CLAUDE.md: use inference profile IDs from the catalog, not bare
 * model IDs). The profile ID comes from `assertCanInvoke`, which resolves it
 * from the catalog after enforcing that the user may use it — this function
 * never decides *which* model, only *how* to talk to it.
 *
 * `streamUsage: true` makes Converse emit token counts on the final streamed
 * chunk, which is how the chat route gets the numbers it writes to usage_events
 * without a second, non-streaming call.
 */
export function buildChatModel(
  inferenceProfileId: string,
  options: BuildChatModelOptions = {},
): ChatBedrockConverse {
  return new ChatBedrockConverse({
    model: inferenceProfileId,
    region: env.AWS_REGION,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
    maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    streamUsage: true,
    // Only include temperature when explicitly provided — see the option doc.
    ...(options.temperature !== undefined
      ? { temperature: options.temperature }
      : {}),
  });
}
