import { ObjectId } from "mongodb";
import { redirect } from "next/navigation";
import { getUserSettings } from "@claudius/shared";
import { SettingsView } from "@/components/settings/settings-view";
import { auth } from "@/lib/auth";

// Node runtime: this page reaches Mongo directly for the initial settings.
export const runtime = "nodejs";

/**
 * The personalization screen — the user-authored layer that sits above inferred
 * memory. A preferred name and freeform instructions, typed by the user and fed
 * verbatim into every turn. Members and admins only; guests are bounced to chat,
 * since they can't author settings (invariant: guests stay ephemeral and capped).
 */
export default async function SettingsPage(): Promise<React.ReactNode> {
  const session = await auth();
  if (!session?.user) redirect("/");
  if (session.user.role === "guest") redirect("/chat");

  const userId = new ObjectId(session.user.id);
  const settings = await getUserSettings(userId);

  return <SettingsView initial={settings} />;
}
