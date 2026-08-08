/**
 * One-off ops tool: set the importance of a user's ACTIVE memories whose content
 * matches a substring. The /memories UI does this per card; this is the scriptable
 * equivalent for a targeted correction (e.g. a core-identity fact the one-time
 * reclassify under-scored). Owner-scoped, active rows only. Prints what it touched.
 *
 *   tsx --env-file=../../.env src/db/scripts/set-importance.ts <email> <substring> <importance>
 */
import { getClient } from "../client";
import { memoriesCol, usersCol } from "../collections";

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function main(): Promise<void> {
  const [email, substring, importanceArg] = process.argv.slice(2);
  if (!email || !substring || importanceArg === undefined) {
    throw new Error(
      "Usage: set-importance.ts <email> <substring> <importance 0..1>",
    );
  }
  const importance = Math.min(1, Math.max(0, Number(importanceArg)));
  if (Number.isNaN(importance)) throw new Error("importance must be a number");

  const users = await usersCol();
  const user = await users.findOne({ email });
  if (!user?._id) throw new Error(`No user with email ${email}`);

  const col = await memoriesCol();
  const filter = {
    userId: user._id,
    supersededBy: null,
    content: { $regex: escapeRegex(substring), $options: "i" },
  };

  const matches = await col.find(filter).toArray();
  console.log(`Matched ${matches.length} active memory(ies) for "${substring}":`);
  for (const m of matches) {
    console.log(`  ${(m.importance ?? 0.5).toFixed(2)} -> ${importance.toFixed(2)}  (${m.category}) ${m.content}`);
  }
  if (matches.length > 0) {
    await col.updateMany(filter, { $set: { importance } });
  }

  const client = await getClient();
  await client.close();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
