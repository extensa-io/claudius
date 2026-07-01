import type { ObjectId } from "mongodb";
import { usersCol } from "../db/collections";
import type { Role } from "../db/schemas";
import { AppError } from "../errors";
import {
  findModelEntry,
  isModelPermitted,
  loadGuestCircuitBreaker,
  loadModelCatalog,
  loadTier,
} from "./catalog";
import { consumeDailyMessage } from "./dailyCap";

/** What the caller needs after enforcement passes: how to actually invoke. */
export interface InvokeGrant {
  modelId: string;
  /** The Bedrock cross-region inference profile ID to pass to Converse. */
  inferenceProfileId: string;
  displayName: string;
  role: Role;
  /**
   * The user's long-term memory switch, surfaced here so the chat route can pass
   * it into the graph's load_context without a second user lookup (Phase 3).
   */
  memoryEnabled: boolean;
}

export interface AssertCanInvokeOptions {
  /**
   * Whether this invocation spends one of the user's daily messages. True for
   * user-initiated chat turns; false for system calls like title generation,
   * which still must clear model-permission and the circuit breaker but do not
   * count against (or get blocked by) the per-user message cap.
   */
  consumeDailyMessage?: boolean;
}

/**
 * The single gate every Bedrock invocation passes through (CLAUDE.md invariant
 * #3). It enforces, in order:
 *
 *   1. the account is active,
 *   2. the model exists and the user's role / allowedModels permit it,
 *   3. the guest circuit breaker is not tripped (guests only),
 *   4. the daily message cap, consumed atomically.
 *
 * On success it returns the inference profile ID the model layer needs. On any
 * failure it throws an AppError whose message is safe to show the user. Tripping
 * logic for the breaker (computing aggregate spend) is Phase 5; this phase only
 * *respects* a manually set `state: "tripped"`.
 */
export async function assertCanInvoke(
  userId: ObjectId,
  modelId: string,
  options: AssertCanInvokeOptions = {},
): Promise<InvokeGrant> {
  const { consumeDailyMessage: consume = true } = options;

  const users = await usersCol();
  const user = await users.findOne({ _id: userId });
  if (!user) {
    throw new AppError("unauthorized", "Your account could not be found.");
  }
  if (user.status === "disabled") {
    throw new AppError("account_disabled", "Your account is disabled.");
  }

  // 2. Model permission, resolved from the catalog (never trusting the client).
  const catalog = await loadModelCatalog();
  const entry = findModelEntry(catalog, modelId);
  if (!entry || !isModelPermitted(user, entry)) {
    throw new AppError(
      "model_not_permitted",
      "That model isn't available on your plan.",
    );
  }

  // 3. Guest circuit breaker: a global kill switch, checked for guests only.
  if (user.role === "guest") {
    const breaker = await loadGuestCircuitBreaker();
    if (breaker.state === "tripped") {
      throw new AppError(
        "circuit_breaker_tripped",
        "Guest access is paused for today. Please try again later.",
      );
    }
  }

  // 4. Daily message cap, atomically consumed. Skipped for non-message calls.
  if (consume) {
    const tier = await loadTier(user.role);
    const allowed = await consumeDailyMessage(userId, tier.dailyMessageCap);
    if (!allowed) {
      throw new AppError(
        "daily_cap_reached",
        `You've reached your daily limit of ${tier.dailyMessageCap} messages. It resets at midnight UTC.`,
      );
    }
  }

  return {
    modelId: entry.id,
    inferenceProfileId: entry.inferenceProfileId,
    displayName: entry.displayName,
    role: user.role,
    // memoryEnabled predates Phase 3 for some rows; treat a missing flag as on,
    // matching the provisioning default and the migration backfill.
    memoryEnabled: user.memoryEnabled ?? true,
  };
}
