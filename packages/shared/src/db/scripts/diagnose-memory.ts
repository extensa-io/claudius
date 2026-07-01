/**
 * Read-only diagnostic for the memory pipeline. Given a user email, it dumps the
 * user's stored memories and replays retrieval against the exact queries that
 * misbehaved, printing vector scores against the MIN_SCORE floor. This tells us
 * whether "I don't know who you are" is an EXTRACTION miss (the fact was never
 * stored) or a RETRIEVAL miss (stored but below the floor / outside top-k).
 *
 * Throwaway: not wired into any route. Run:
 *   tsx --env-file=../../.env src/db/scripts/diagnose-memory.ts <email>
 */
import { memoriesCol, usersCol } from "../collections";
import { embedQuery } from "../../embeddings/voyage";

// Must match retrieve.ts.
const MIN_SCORE = 0.55;
const TOP_K = 5;
const MIN_INJECT = 3;

async function main() {
  const email = process.argv[2];
  const users = await usersCol();
  if (!email) {
    const list = await users.find({}).project({ email: 1, role: 1 }).toArray();
    console.log("Users:");
    for (const u of list) console.log(`  ${u.email}  (${u.role})`);
    process.exit(0);
  }

  const user = await users.findOne({ email });
  if (!user?._id) throw new Error(`No user with email ${email}`);
  console.log(`\nUser: ${email}  role=${user.role}  memoryEnabled=${user.memoryEnabled}  _id=${user._id}`);

  const mem = await memoriesCol();
  const all = await mem
    .find({ userId: user._id })
    .sort({ createdAt: 1 })
    .toArray();
  const active = all.filter((m) => !m.supersededBy);
  console.log(`\nStored memories: ${all.length} total, ${active.length} active (non-superseded)\n`);
  for (const m of all) {
    const flag = m.supersededBy ? " [SUPERSEDED]" : "";
    console.log(`  (${m.category}) ${m.content}${flag}`);
  }

  const queries = [
    "do you know who I am?",
    "check again, your memory should have relevant info about me",
    "who am I",
    "what is my job",
  ];

  for (const q of queries) {
    const qv = await embedQuery(q);
    const hits = (await mem
      .aggregate([
        {
          $vectorSearch: {
            index: "memories_vector",
            path: "embedding",
            queryVector: qv,
            numCandidates: 100,
            limit: 20,
            filter: { userId: { $eq: user._id } },
          },
        },
        { $addFields: { score: { $meta: "vectorSearchScore" } } },
        { $match: { supersededBy: null } },
        { $project: { _id: 0, content: 1, category: 1, score: 1 } },
      ])
      .toArray()) as { content: string; category: string; score: number }[];

    const aboveFloor = hits.filter((h) => h.score >= MIN_SCORE).slice(0, TOP_K);
    const injected =
      aboveFloor.length >= MIN_INJECT ? aboveFloor : hits.slice(0, MIN_INJECT);
    const injectedSet = new Set(injected.map((h) => h.content));

    console.log(
      `\n=== query: "${q}"  (MIN_SCORE=${MIN_SCORE}, TOP_K=${TOP_K}, MIN_INJECT=${MIN_INJECT}) ===`,
    );
    hits.slice(0, 12).forEach((h) => {
      const mark = injectedSet.has(h.content)
        ? "INJECT"
        : h.score >= MIN_SCORE
          ? "  ·   "
          : "  drop";
      console.log(`  ${mark} ${h.score.toFixed(4)}  (${h.category}) ${h.content}`);
    });
    const viaFallback = aboveFloor.length < MIN_INJECT ? "  (never-blind fallback)" : "";
    console.log(`  -> would inject ${injected.length} memories${viaFallback}`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
