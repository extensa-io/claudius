import type { ObjectId } from "mongodb";
import { usageEventsCol } from "../db/collections";
import type { ModelCatalogEntry, Role } from "../db/schemas";
import { loadModelCatalog } from "../tiers/catalog";

/**
 * Aggregation helpers over the `usage_events` time-series collection. These are
 * the single source of the numbers the circuit breaker, the member budget
 * soft-stop, and the admin cost dashboard all read, so cost is computed the same
 * way everywhere: token sums come from the pipeline, dollar cost is applied in
 * code from the catalog's per-million-token prices.
 *
 * Pricing note: a catalog price of -1 is the "not yet confirmed" placeholder
 * (see seed.ts). Unconfirmed prices are treated as $0 rather than negative, so a
 * mis-seeded price can never *lower* an aggregate or accidentally trip a spend
 * control. Confirm prices (manually or via `db:sync:pricing`) before the dollar
 * figures mean anything.
 */

/** Midnight UTC at the start of the day containing `now`. */
export function startOfUtcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/** Midnight UTC on the first of the month containing `now`. */
export function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Midnight UTC on the first of the month *before* the one containing `now`. */
export function startOfPreviousUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
}

/** A per-model unit-cost lookup, with unconfirmed (-1) prices clamped to 0. */
export type PriceMap = Map<string, { input: number; output: number }>;

export function buildPriceMap(catalog: ModelCatalogEntry[]): PriceMap {
  const map: PriceMap = new Map();
  for (const m of catalog) {
    map.set(m.id, {
      input: Math.max(0, m.inputPricePerMTok),
      output: Math.max(0, m.outputPricePerMTok),
    });
  }
  return map;
}

/** Dollar cost of a model's token counts. Prices are per million tokens. */
export function costUsd(
  prices: PriceMap,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const p = prices.get(modelId);
  if (!p) return 0;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

interface ModelTokens {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Guest spend for the current UTC day, in USD. Joins usage_events to users to
 * keep only guest-role events, sums tokens per model, and prices them in code.
 * This is what the circuit breaker compares against its daily ceiling.
 */
export async function guestSpendTodayUsd(now: Date = new Date()): Promise<number> {
  const col = await usageEventsCol();
  const rows = (await col
    .aggregate([
      { $match: { timestamp: { $gte: startOfUtcDay(now) } } },
      {
        $lookup: {
          from: "users",
          localField: "meta.userId",
          foreignField: "_id",
          as: "user",
        },
      },
      { $match: { "user.role": "guest" } },
      {
        $group: {
          _id: "$meta.modelId",
          inputTokens: { $sum: "$inputTokens" },
          outputTokens: { $sum: "$outputTokens" },
        },
      },
    ])
    .toArray()) as Array<{ _id: string; inputTokens: number; outputTokens: number }>;

  const prices = buildPriceMap(await loadModelCatalog());
  return rows.reduce(
    (sum, r) => sum + costUsd(prices, r._id, r.inputTokens, r.outputTokens),
    0,
  );
}

/**
 * Total tokens (input + output) a user has spent in the current UTC month.
 * Backs the member monthly-budget soft-stop.
 */
export async function userMonthTokensUsed(
  userId: ObjectId,
  now: Date = new Date(),
): Promise<number> {
  const col = await usageEventsCol();
  const rows = (await col
    .aggregate([
      {
        $match: {
          "meta.userId": userId,
          timestamp: { $gte: startOfUtcMonth(now) },
        },
      },
      {
        $group: {
          _id: null,
          tokens: { $sum: { $add: ["$inputTokens", "$outputTokens"] } },
        },
      },
    ])
    .toArray()) as Array<{ tokens: number }>;
  return rows[0]?.tokens ?? 0;
}

// --- Admin cost dashboard --------------------------------------------------

export interface DimensionRow {
  key: string;
  label: string;
  inputTokens: number;
  outputTokens: number;
  spendUsd: number;
}

export interface DayRow {
  day: string; // YYYY-MM-DD (UTC)
  inputTokens: number;
  outputTokens: number;
  spendUsd: number;
}

export interface DashboardData {
  monthToDate: { tokens: number; spendUsd: number };
  previousMonth: { tokens: number; spendUsd: number };
  byDay: DayRow[];
  byModel: DimensionRow[];
  byPurpose: DimensionRow[];
  byRole: DimensionRow[];
  byUser: DimensionRow[];
  pricingConfirmed: boolean;
}

/**
 * Fold token sums grouped by [dimension, modelId] into priced dimension rows.
 * Grouping keeps the model so each slice of tokens is charged at its own rate;
 * we then collapse to one row per dimension value with the total spend.
 */
function priceDimension(
  raw: Array<{
    key: string;
    label: string;
    modelId: string;
    inputTokens: number;
    outputTokens: number;
  }>,
  prices: PriceMap,
): DimensionRow[] {
  const byKey = new Map<string, DimensionRow>();
  for (const r of raw) {
    const existing = byKey.get(r.key) ?? {
      key: r.key,
      label: r.label,
      inputTokens: 0,
      outputTokens: 0,
      spendUsd: 0,
    };
    existing.inputTokens += r.inputTokens;
    existing.outputTokens += r.outputTokens;
    existing.spendUsd += costUsd(prices, r.modelId, r.inputTokens, r.outputTokens);
    byKey.set(r.key, existing);
  }
  return [...byKey.values()].sort((a, b) => b.spendUsd - a.spendUsd || b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
}

/**
 * Everything the admin cost dashboard renders, from one catalog load and a
 * handful of aggregation pipelines. Server-computed; the page passes it straight
 * to server-rendered tables and lightweight bars (no charting dependency).
 */
export async function dashboardUsage(now: Date = new Date()): Promise<DashboardData> {
  const col = await usageEventsCol();
  const catalog = await loadModelCatalog();
  const prices = buildPriceMap(catalog);
  const displayName = new Map(catalog.map((m) => [m.id, m.displayName]));
  const pricingConfirmed = catalog.every(
    (m) => m.inputPricePerMTok >= 0 && m.outputPricePerMTok >= 0,
  );

  const monthStart = startOfUtcMonth(now);
  const prevStart = startOfPreviousUtcMonth(now);

  // Per-[dimension, model] token sums for the current month, one pass each.
  const [byModelRaw, byPurposeRaw, byUserRaw, byDayRaw, prevRaw] = await Promise.all([
    col
      .aggregate([
        { $match: { timestamp: { $gte: monthStart } } },
        {
          $group: {
            _id: "$meta.modelId",
            inputTokens: { $sum: "$inputTokens" },
            outputTokens: { $sum: "$outputTokens" },
          },
        },
      ])
      .toArray(),
    col
      .aggregate([
        { $match: { timestamp: { $gte: monthStart } } },
        {
          $group: {
            _id: { purpose: "$meta.purpose", modelId: "$meta.modelId" },
            inputTokens: { $sum: "$inputTokens" },
            outputTokens: { $sum: "$outputTokens" },
          },
        },
      ])
      .toArray(),
    col
      .aggregate([
        { $match: { timestamp: { $gte: monthStart } } },
        {
          $group: {
            _id: { userId: "$meta.userId", modelId: "$meta.modelId" },
            inputTokens: { $sum: "$inputTokens" },
            outputTokens: { $sum: "$outputTokens" },
          },
        },
        {
          $lookup: {
            from: "users",
            localField: "_id.userId",
            foreignField: "_id",
            as: "user",
          },
        },
        { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
      ])
      .toArray(),
    col
      .aggregate([
        { $match: { timestamp: { $gte: monthStart } } },
        {
          $group: {
            _id: {
              day: {
                $dateToString: {
                  format: "%Y-%m-%d",
                  date: "$timestamp",
                  timezone: "UTC",
                },
              },
              modelId: "$meta.modelId",
            },
            inputTokens: { $sum: "$inputTokens" },
            outputTokens: { $sum: "$outputTokens" },
          },
        },
      ])
      .toArray(),
    col
      .aggregate([
        {
          $match: { timestamp: { $gte: prevStart, $lt: monthStart } },
        },
        {
          $group: {
            _id: "$meta.modelId",
            inputTokens: { $sum: "$inputTokens" },
            outputTokens: { $sum: "$outputTokens" },
          },
        },
      ])
      .toArray(),
  ]);

  const byModel = priceDimension(
    (byModelRaw as ModelTokens[]).map((r) => ({
      key: r.modelId,
      label: displayName.get(r.modelId) ?? r.modelId,
      modelId: r.modelId,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
    })),
    prices,
  );

  const byPurpose = priceDimension(
    (byPurposeRaw as Array<{
      _id: { purpose: string; modelId: string };
      inputTokens: number;
      outputTokens: number;
    }>).map((r) => ({
      key: r._id.purpose,
      label: r._id.purpose,
      modelId: r._id.modelId,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
    })),
    prices,
  );

  const userRows = byUserRaw as Array<{
    _id: { userId: ObjectId; modelId: string };
    inputTokens: number;
    outputTokens: number;
    user?: { email?: string; role?: Role };
  }>;
  const byUser = priceDimension(
    userRows.map((r) => ({
      key: r._id.userId.toString(),
      label: r.user?.email ?? r._id.userId.toString(),
      modelId: r._id.modelId,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
    })),
    prices,
  );
  const byRole = priceDimension(
    userRows.map((r) => ({
      key: r.user?.role ?? "unknown",
      label: r.user?.role ?? "unknown",
      modelId: r._id.modelId,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
    })),
    prices,
  );

  // Days fold to one row each, priced per model then summed, sorted by date.
  const dayRows = byDayRaw as Array<{
    _id: { day: string; modelId: string };
    inputTokens: number;
    outputTokens: number;
  }>;
  const byDayMap = new Map<string, DayRow>();
  for (const r of dayRows) {
    const existing = byDayMap.get(r._id.day) ?? {
      day: r._id.day,
      inputTokens: 0,
      outputTokens: 0,
      spendUsd: 0,
    };
    existing.inputTokens += r.inputTokens;
    existing.outputTokens += r.outputTokens;
    existing.spendUsd += costUsd(prices, r._id.modelId, r.inputTokens, r.outputTokens);
    byDayMap.set(r._id.day, existing);
  }
  const byDay = [...byDayMap.values()].sort((a, b) => a.day.localeCompare(b.day));

  const monthToDate = byModel.reduce(
    (acc, r) => ({
      tokens: acc.tokens + r.inputTokens + r.outputTokens,
      spendUsd: acc.spendUsd + r.spendUsd,
    }),
    { tokens: 0, spendUsd: 0 },
  );

  const prevRows = prevRaw as ModelTokens[];
  const previousMonth = prevRows.reduce(
    (acc, r) => ({
      tokens: acc.tokens + r.inputTokens + r.outputTokens,
      spendUsd: acc.spendUsd + costUsd(prices, r.modelId, r.inputTokens, r.outputTokens),
    }),
    { tokens: 0, spendUsd: 0 },
  );

  return {
    monthToDate,
    previousMonth,
    byDay,
    byModel,
    byPurpose,
    byRole,
    byUser,
    pricingConfirmed,
  };
}
