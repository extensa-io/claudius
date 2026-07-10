import type { ObjectId } from "mongodb";
import { userSettingsCol } from "../db/collections";
import type { UserSettings } from "../db/schemas";

/**
 * The user-authored settings as the app consumes them: the two fields, never
 * the `_id`/`updatedAt` bookkeeping. A user with no document yet reads back as
 * both-null (the unset state), so callers never branch on existence.
 */
export interface UserSettingsView {
  preferredName: string | null;
  instructions: string | null;
  preferredModelId: string | null;
}

const EMPTY: UserSettingsView = {
  preferredName: null,
  instructions: null,
  preferredModelId: null,
};

/**
 * Read a user's authored settings. Missing document ⇒ the unset view. This runs
 * on the chat hot path (once per turn, primary-key findOne on _id = userId), so
 * it stays a single projected lookup with no aggregation.
 */
export async function getUserSettings(
  userId: ObjectId,
): Promise<UserSettingsView> {
  const col = await userSettingsCol();
  const doc = await col.findOne(
    { _id: userId },
    { projection: { preferredName: 1, instructions: 1, preferredModelId: 1 } },
  );
  if (!doc) return EMPTY;
  return {
    preferredName: doc.preferredName ?? null,
    instructions: doc.instructions ?? null,
    preferredModelId: doc.preferredModelId ?? null,
  };
}

/**
 * Trim and normalize a user-supplied field: whitespace-only (or absent) becomes
 * `null` (the unset state), so an emptied textarea clears the setting rather
 * than injecting a blank line into the prompt. A present value is trimmed.
 */
function normalize(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Upsert a user's authored settings. Callers pass only the fields they mean to
 * change; an omitted field is left untouched, an empty/whitespace field clears
 * it. Stamps `updatedAt`. Guest-gating lives at the API boundary — this layer
 * assumes the caller already checked the role, matching how the rest of the
 * store trusts its callers.
 */
export async function updateUserSettings(
  userId: ObjectId,
  patch: {
    preferredName?: string | null | undefined;
    instructions?: string | null | undefined;
    preferredModelId?: string | null | undefined;
  },
  now: Date,
): Promise<UserSettingsView> {
  const set: Partial<UserSettings> = { updatedAt: now };
  if ("preferredName" in patch) set.preferredName = normalize(patch.preferredName);
  if ("instructions" in patch) set.instructions = normalize(patch.instructions);
  // The model id is chosen from the catalog, not freeform, but the same
  // whitespace-only ⇒ null normalization keeps a blank from ever being stored.
  if ("preferredModelId" in patch)
    set.preferredModelId = normalize(patch.preferredModelId);

  const col = await userSettingsCol();
  await col.updateOne({ _id: userId }, { $set: set }, { upsert: true });

  return getUserSettings(userId);
}
