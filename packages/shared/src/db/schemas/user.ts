import { z } from "zod";
import { zObjectId, zRole } from "./common";

/**
 * `users` combines Auth.js adapter-managed fields (name, email, image,
 * emailVerified) with Claudius application fields. The adapter writes the
 * former; our sign-in callback writes `role` and the tier/usage fields.
 *
 * `allowedModels: null` means "inherit the tier default from the model
 * catalog"; an explicit array overrides it for that user. `monthlyTokenBudget:
 * null` means "no per-user override, use the tier budget".
 */
export const UserSchema = z.object({
  _id: zObjectId.optional(),
  name: z.string().optional(),
  email: z.string().email(),
  image: z.string().optional(),
  emailVerified: z.date().nullable().optional(),
  role: zRole,
  allowedModels: z.array(z.string()).nullable(),
  monthlyTokenBudget: z.number().nullable(),
  dailyMessageCount: z.object({
    count: z.number().int().nonnegative(),
    resetsAt: z.date(),
  }),
  status: z.enum(["active", "disabled"]),
  /**
   * The user's long-term memory master switch (Phase 3). When false, Claudius
   * neither extracts new memories from this user's conversations nor retrieves
   * any in `load_context` — the feature is fully off for them. Defaults to true
   * at provisioning; the `/memories` toggle flips it.
   */
  memoryEnabled: z.boolean(),
});

export type User = z.infer<typeof UserSchema>;
