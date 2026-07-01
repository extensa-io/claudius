import {
  GetProductsCommand,
  PricingClient,
} from "@aws-sdk/client-pricing";
import { clientPromise } from "../client";
import { updateModelCatalog } from "../../admin/settings";
import { loadModelCatalog } from "../../tiers/catalog";
import type { ModelCatalogEntry } from "../schemas";

/**
 * Best-effort: pull current on-demand Bedrock token prices from the AWS Price
 * List API and write them into the `settings.modelCatalog` document, so the cost
 * dashboard and the guest circuit breaker run on real numbers instead of the
 * seeded -1 placeholders.
 *
 * Why "best-effort": the Price List catalog names models in its own vocabulary
 * ("Claude Haiku 4.5", "Claude 3.5 Sonnet", ...) and there is no field that
 * carries the Bedrock inference-profile id we key on. So we match by normalizing
 * both names down to a {family, version} fingerprint. Anything we can't match is
 * left untouched and logged — the admin catalog editor is always the
 * authoritative manual override. Run: `npm run db:sync:pricing`.
 *
 * Kept as a script, not a shared export: it imports the dev-only AWS Pricing SDK,
 * which must never enter the app bundle (workspace dep rule in CLAUDE.md).
 * Promoting it to an admin button would mean moving the SDK to a runtime dep.
 *
 * The Price List API is only served from a few regions; us-east-1 is one, and it
 * returns global product data regardless of where Bedrock itself runs.
 */

const PRICING_REGION = "us-east-1";
const SERVICE_CODE = "AmazonBedrock";
// Query Bedrock prices for one region; token prices are uniform across the US
// cross-region inference footprint we use.
const BEDROCK_REGION = "us-east-1";

interface PriceListProduct {
  product?: {
    attributes?: Record<string, string>;
  };
  terms?: {
    OnDemand?: Record<
      string,
      {
        priceDimensions?: Record<
          string,
          { unit?: string; description?: string; pricePerUnit?: { USD?: string } }
        >;
      }
    >;
  };
}

/** Reduce a model name to a comparable fingerprint: family + version digits. */
function fingerprint(name: string): string | null {
  const lower = name.toLowerCase();
  const family = ["haiku", "sonnet", "opus"].find((f) => lower.includes(f));
  if (!family) return null;
  // Grab the first version-looking number (e.g. "4.5", "3.5", "4").
  const version = lower.match(/(\d+(?:\.\d+)?)/)?.[1] ?? "";
  return `${family}-${version}`;
}

/** Per-USD-per-million-token, converting from whatever unit the API reports. */
function toPerMTok(pricePerUnit: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u.includes("1k") || u.includes("1,000") || u.includes("1000")) {
    return pricePerUnit * 1000; // price is per 1K tokens
  }
  if (u.includes("token")) {
    return pricePerUnit * 1_000_000; // price is per single token
  }
  // Unknown unit: assume per 1K tokens (Bedrock's common convention) and warn.
  console.warn(`  ! unrecognized price unit "${unit}", assuming per-1K-tokens`);
  return pricePerUnit * 1000;
}

interface Prices {
  input?: number;
  output?: number;
}

async function fetchBedrockPrices(): Promise<Map<string, Prices>> {
  const client = new PricingClient({ region: PRICING_REGION });
  const prices = new Map<string, Prices>();
  let nextToken: string | undefined;

  do {
    const res = await client.send(
      new GetProductsCommand({
        ServiceCode: SERVICE_CODE,
        FormatVersion: "aws_v1",
        Filters: [
          { Type: "TERM_MATCH", Field: "regionCode", Value: BEDROCK_REGION },
        ],
        NextToken: nextToken,
        MaxResults: 100,
      }),
    );

    for (const raw of res.PriceList ?? []) {
      const product = JSON.parse(raw as string) as PriceListProduct;
      const attrs = product.product?.attributes ?? {};
      const name = attrs.model ?? attrs.titanModelName ?? attrs.modelName ?? "";
      const fp = fingerprint(name);
      if (!fp) continue;

      // Decide input vs output from the usage type / dimension description.
      const usage = `${attrs.usagetype ?? ""}`.toLowerCase();
      const dims = Object.values(product.terms?.OnDemand ?? {})
        .flatMap((t) => Object.values(t.priceDimensions ?? {}));
      for (const dim of dims) {
        const usd = Number(dim.pricePerUnit?.USD ?? "");
        if (!Number.isFinite(usd) || usd <= 0) continue;
        const text = `${usage} ${dim.description ?? ""}`.toLowerCase();
        const isInput = text.includes("input");
        const isOutput = text.includes("output");
        if (!isInput && !isOutput) continue;
        const perMTok = toPerMTok(usd, dim.unit ?? "");
        const entry = prices.get(fp) ?? {};
        if (isInput) entry.input = perMTok;
        if (isOutput) entry.output = perMTok;
        prices.set(fp, entry);
      }
    }
    nextToken = res.NextToken;
  } while (nextToken);

  return prices;
}

async function main(): Promise<void> {
  console.log("Fetching Bedrock on-demand token prices from AWS Price List...");
  const prices = await fetchBedrockPrices();
  console.log(`  matched ${prices.size} model fingerprint(s) with prices.`);

  const catalog = await loadModelCatalog();
  const updated: ModelCatalogEntry[] = [];
  let changed = 0;

  for (const entry of catalog) {
    const fp = fingerprint(entry.displayName);
    const found = fp ? prices.get(fp) : undefined;
    if (found?.input !== undefined && found.output !== undefined) {
      console.log(
        `  ${entry.displayName}: in ${entry.inputPricePerMTok} -> ${found.input.toFixed(2)}, out ${entry.outputPricePerMTok} -> ${found.output.toFixed(2)} ($/MTok)`,
      );
      updated.push({
        ...entry,
        inputPricePerMTok: found.input,
        outputPricePerMTok: found.output,
      });
      changed += 1;
    } else {
      console.log(`  ${entry.displayName}: no price match, left as-is.`);
      updated.push(entry);
    }
  }

  if (changed > 0) {
    await updateModelCatalog(updated);
    console.log(`Updated ${changed} catalog entr(ies).`);
  } else {
    console.log("No catalog entries updated. Set prices manually in /admin.");
  }

  const mongo = await clientPromise;
  await mongo.close();
  console.log("Pricing sync complete.");
}

main().catch((error: unknown) => {
  console.error("Pricing sync failed:", error);
  process.exit(1);
});
