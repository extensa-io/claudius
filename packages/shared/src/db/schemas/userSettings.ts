import { z } from "zod";
import { zObjectId } from "./common";

/** Cap the freeform instructions so one user can't bloat every prompt. */
export const USER_INSTRUCTIONS_MAX = 4000;
/** A display name, not an essay — kept short so it reads as an address. */
export const USER_PREFERRED_NAME_MAX = 100;

/**
 * `user_settings` holds the user-AUTHORED personalization that sits above the
 * system's INFERRED memory. Where the profile and recalled-memory blocks are
 * distilled from past conversations, these two fields are typed verbatim by the
 * user and injected unchanged every turn: `preferredName` ("What should Claudius
 * call you?") and `instructions` ("Instructions for Claudius"). They are never
 * summarized, consolidated, or superseded — that is the whole point of the layer.
 *
 * One document per user, keyed by `_id = user._id`, so a read is a primary-key
 * findOne with no extra index. Members and admins only: guests never get a
 * document, which keeps this layer clear of the guest `expiresAt` TTL machinery
 * (invariant #4). `null` on either field means "unset" — the corresponding line
 * is simply omitted from the prompt, never padded.
 */
export const UserSettingsSchema = z.object({
  _id: zObjectId,
  preferredName: z.string().max(USER_PREFERRED_NAME_MAX).nullable(),
  instructions: z.string().max(USER_INSTRUCTIONS_MAX).nullable(),
  updatedAt: z.date(),
});

export type UserSettings = z.infer<typeof UserSettingsSchema>;
