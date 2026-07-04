/**
 * Read-only diagnostic for the memory pipeline. Given a user email, it dumps the
 * user's stored memories (with importance) and replays retrieval against the
 * exact queries that misbehaved, printing BOTH the raw vector score and the
 * Phase 6 blended score against the adaptive band. It also prints the always-on
 * profile the user would carry every turn. This tells us whether "I don't know
 * who you are" is an EXTRACTION miss (never stored), a RETRIEVAL miss (stored but
 * out of band/top-k), or covered by the resident profile regardless.
 *
 * Constants and blend below MUST track retrieve.ts. Throwaway: not wired into any
 * route. Run:
 *   tsx --env-file=../../.env src/db/scripts/diagnose-memory.ts <email>
 */
import { memoriesCol, usersCol } from "../collections";
import { embedQuery } from "../../embeddings/voyage";

// Must match retrieve.ts.
const TOP_K = 5;
const MIN_INJECT = 3;
const IMPORTANCE_WEIGHT = 0.15;
const NEUTRAL_IMPORTANCE = 0.5;
const ABS_FLOOR = 0.5;
const RELATIVE_BAND = 0.08;
const PROFILE_SIZE = 5;
const PROFILE_MIN_IMPORTANCE = 0.7;

function blended(score: number, importance: number | undefined): number {
  return score + IMPORTANCE_WEIGHT * ((importance ?? NEUTRAL_IMPORTANCE) - 0.5);
}

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
    const flag = m.supersededBy ? ` [SUPERSEDED:${m.supersededReason ?? "update"}]` : "";
    const imp = (m.importance ?? NEUTRAL_IMPORTANCE).toFixed(2);
    console.log(`  imp=${imp} (${m.category}) ${m.content}${flag}`);
  }

  // The always-on profile: what the user carries on EVERY turn, no vector search.
  const profile = active
    .filter((m) => (m.importance ?? NEUTRAL_IMPORTANCE) >= PROFILE_MIN_IMPORTANCE)
    .sort(
      (a, b) =>
        (b.importance ?? 0) - (a.importance ?? 0) ||
        b.lastAccessedAt.getTime() - a.lastAccessedAt.getTime(),
    )
    .slice(0, PROFILE_SIZE);
  console.log(`\n=== always-on profile (importance >= ${PROFILE_MIN_IMPORTANCE}, top ${PROFILE_SIZE}) ===`);
  if (profile.length === 0) console.log("  (empty — no defining-salience memories)");
  for (const m of profile) {
    console.log(`  PROFILE imp=${(m.importance ?? 0).toFixed(2)} (${m.category}) ${m.content}`);
  }

  const queries = [
    "do you know who I am?",
    "check again, your memory should have relevant info about me",
    "who am I",
    "what is my job",
  ];

  const profileIds = new Set(profile.map((m) => m._id!.toString()));

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
        { $project: { _id: 1, content: 1, category: 1, score: 1, importance: 1 } },
      ])
      .toArray()) as {
      _id: { toString(): string };
      content: string;
      category: string;
      score: number;
      importance?: number;
    }[];

    // Mirror retrieve.ts: exclude the profile, blend, sort, adaptive band, then
    // the never-blind fallback.
    const ranked = hits
      .filter((h) => !profileIds.has(h._id.toString()))
      .map((h) => ({ ...h, b: blended(h.score, h.importance) }))
      .sort((a, b) => b.b - a.b);
    const top = ranked[0]?.b ?? 0;
    const withinBand = ranked
      .filter((r) => r.b >= ABS_FLOOR && r.b >= top - RELATIVE_BAND)
      .slice(0, TOP_K);
    const injected =
      withinBand.length >= MIN_INJECT ? withinBand : ranked.slice(0, MIN_INJECT);
    const injectedSet = new Set(injected.map((h) => h.content));

    console.log(
      `\n=== query: "${q}"  (band=top-${RELATIVE_BAND}, floor=${ABS_FLOOR}, TOP_K=${TOP_K}, MIN_INJECT=${MIN_INJECT}) ===`,
    );
    ranked.slice(0, 12).forEach((h) => {
      const mark = injectedSet.has(h.content) ? "INJECT" : "  drop";
      console.log(
        `  ${mark} raw=${h.score.toFixed(4)} blend=${h.b.toFixed(4)} imp=${(h.importance ?? NEUTRAL_IMPORTANCE).toFixed(2)}  (${h.category}) ${h.content}`,
      );
    });
    const viaFallback = withinBand.length < MIN_INJECT ? "  (never-blind fallback)" : "";
    console.log(
      `  -> profile ${profile.length} + retrieved ${injected.length}${viaFallback}`,
    );
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
