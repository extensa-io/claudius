/**
 * The model the LOOKUP operators run on: `?` (dictionary) and `&` (translate).
 *
 * Pinned rather than inherited from the model picker, for three reasons found by
 * benchmarking both operators on Haiku 4.5 against Sonnet 4.6 (3 reps each over
 * 6 cases):
 *
 *   - LATENCY. Time to first token is a wash (~1.7-1.9s on both), but median
 *     time to a COMPLETE entry is 4.7s vs 10.3s for a define and 4.3s vs 7.8s
 *     for a translation, with a Sonnet worst case over 13s. These operators sell
 *     themselves as faster than opening a dictionary tab; a ten-second median is
 *     a different product from a five-second one.
 *   - TIER REACH. `sonnet` is member/admin-only in the catalog, so pinning it
 *     would break both operators outright for guests. `haiku` is permitted for
 *     every role, so one pinned model serves all three with no special case.
 *   - CONSISTENCY. Pinning makes a lookup cost and feel the same regardless of
 *     what the user happens to have selected in the picker, which is the point
 *     of a lookup operator as opposed to a chat turn.
 *
 * The quality cost is real but narrow: Sonnet is better on genuinely hard,
 * culturally loaded words (it offers *morriña* for *saudade* where Haiku offers
 * *melancolía*). That is not worth ~5 extra seconds on every easy lookup.
 *
 * Same choice, and the same reasoning, as `titleGen.ts` — cheapest in the
 * catalog, allowed for every role. Unlike titling, these DO consume a daily
 * message on a cache miss: they are turns the user typed, not system calls.
 */
export const LOOKUP_MODEL_ID = "haiku";
