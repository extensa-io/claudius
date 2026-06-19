import { ObjectId } from "mongodb";
import { z } from "zod";

/**
 * Shared Zod building blocks. Zod is the single type source for every document
 * (CLAUDE.md invariant): we define the schema once and derive the TypeScript
 * type with `z.infer`, so the runtime validator and the compile-time type can
 * never drift apart.
 */

/** A BSON ObjectId, validated at the boundary. */
export const zObjectId = z.instanceof(ObjectId);

/** The three roles. Resolved server-side only; the client never supplies it. */
export const zRole = z.enum(["admin", "member", "guest"]);
export type Role = z.infer<typeof zRole>;
