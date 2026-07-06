import {
  DEFAULT_BANGS,
  DEFAULT_CACHE_TTLS,
  DEFAULT_ESCALATION_KEYWORDS,
  getAdminAllowlist,
  getAllowlist,
  guestBreakerView,
  loadModelCatalog,
  loadSearchSettings,
  loadTier,
} from "@claudius/shared";
import { AllowlistEditor } from "@/components/admin/allowlist-editor";
import { BreakerPanel } from "@/components/admin/breaker-panel";
import { ModelCatalogEditor } from "@/components/admin/model-catalog-editor";
import {
  SearchSettingsEditor,
  type SearchSettingsView,
} from "@/components/admin/search-settings-editor";
import { TierEditor } from "@/components/admin/tier-editor";

export const runtime = "nodejs";

/**
 * Admin config: the circuit breaker, member + admin allowlists, model catalog,
 * and tier limits. All current values are loaded server-side and handed to
 * interactive client panels that persist through the /api/admin/* routes.
 */
export default async function AdminConfigPage(): Promise<React.ReactNode> {
  const [memberEmails, adminEmails, models, admin, member, guest, breaker, search] =
    await Promise.all([
      getAllowlist(),
      getAdminAllowlist(),
      loadModelCatalog(),
      loadTier("admin"),
      loadTier("member"),
      loadTier("guest"),
      guestBreakerView(),
      loadSearchSettings(),
    ]);

  // Phase 8 fields are optional on the stored document (older Phase 7 docs), so
  // fill built-in defaults for the panel's initial state.
  const searchView: SearchSettingsView = {
    braveMonthlyThreshold: search.braveMonthlyThreshold,
    highValueMinResults: search.highValueMinResults,
    customBangs: search.customBangs ?? DEFAULT_BANGS,
    escalationKeywords: search.escalationKeywords ?? DEFAULT_ESCALATION_KEYWORDS,
    cacheTtls: search.cacheTtls ?? DEFAULT_CACHE_TTLS,
    braveUsage: search.braveUsage,
  };

  return (
    <div className="space-y-6">
      <BreakerPanel initial={breaker} />
      <AllowlistEditor
        title="Admin allowlist"
        endpoint="/api/admin/admin-allowlist"
        initial={adminEmails}
        note="These emails resolve to admin at sign-in. The bootstrap ADMIN_EMAIL is always admin and is managed via the environment, not this list."
      />
      <AllowlistEditor
        title="Member allowlist"
        endpoint="/api/admin/allowlist"
        initial={memberEmails}
      />
      <ModelCatalogEditor initial={models} />
      <TierEditor initial={{ admin, member, guest }} />
      <SearchSettingsEditor initial={searchView} />
    </div>
  );
}
