import { dashboardUsage, type DimensionRow } from "@claudius/shared";
import { formatTokens, formatUsd } from "@/lib/format";

export const runtime = "nodejs";

/**
 * Admin cost dashboard. Everything is server-computed from `usage_events`
 * aggregation pipelines and rendered as plain tables and CSS bars — no charting
 * dependency, matching the spec's "simple charts" and the repo's lean posture.
 */
export default async function AdminDashboardPage(): Promise<React.ReactNode> {
  const data = await dashboardUsage();
  const maxDay = Math.max(1, ...data.byDay.map((d) => d.inputTokens + d.outputTokens));

  return (
    <div className="space-y-8">
      {!data.pricingConfirmed && (
        <div className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning-foreground">
          Some model prices are unconfirmed (placeholder <code>-1</code>), so
          dollar figures below understate real spend. Set prices in{" "}
          <a href="/admin/config" className="underline">
            Config → Models
          </a>{" "}
          or run <code>npm run db:sync:pricing</code>.
        </div>
      )}

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Tokens (MTD)" value={formatTokens(data.monthToDate.tokens)} />
        <StatCard label="Spend (MTD)" value={formatUsd(data.monthToDate.spendUsd)} />
        <StatCard
          label="Tokens (prev month)"
          value={formatTokens(data.previousMonth.tokens)}
        />
        <StatCard
          label="Spend (prev month)"
          value={formatUsd(data.previousMonth.spendUsd)}
        />
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold">Tokens by day (this month)</h2>
        {data.byDay.length === 0 ? (
          <Empty />
        ) : (
          <div className="space-y-1.5">
            {data.byDay.map((d) => {
              const total = d.inputTokens + d.outputTokens;
              return (
                <div key={d.day} className="flex items-center gap-3 text-xs">
                  <span className="w-20 shrink-0 text-muted-foreground">
                    {d.day.slice(5)}
                  </span>
                  <div className="h-4 flex-1 overflow-hidden rounded bg-muted">
                    <div
                      className="h-full rounded bg-primary/70"
                      style={{ width: `${(total / maxDay) * 100}%` }}
                    />
                  </div>
                  <span className="w-16 shrink-0 text-right tabular-nums">
                    {formatTokens(total)}
                  </span>
                  <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">
                    {formatUsd(d.spendUsd)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <DimensionTable title="By model" head="Model" rows={data.byModel} />
        <DimensionTable title="By purpose" head="Purpose" rows={data.byPurpose} />
        <DimensionTable title="By tier" head="Role" rows={data.byRole} />
        <DimensionTable title="By user" head="User" rows={data.byUser} />
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }): React.ReactNode {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function DimensionTable({
  title,
  head,
  rows,
}: {
  title: string;
  head: string;
  rows: DimensionRow[];
}): React.ReactNode {
  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {rows.length === 0 ? (
        <Empty />
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="pb-2 font-medium">{head}</th>
              <th className="pb-2 text-right font-medium">Tokens</th>
              <th className="pb-2 text-right font-medium">Spend</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-b border-border/50">
                <td className="py-1.5 pr-2">{r.label}</td>
                <td className="py-1.5 text-right tabular-nums">
                  {formatTokens(r.inputTokens + r.outputTokens)}
                </td>
                <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                  {formatUsd(r.spendUsd)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Empty(): React.ReactNode {
  return <p className="text-sm text-muted-foreground">No usage yet.</p>;
}
