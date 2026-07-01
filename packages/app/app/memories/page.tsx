import { ObjectId } from "mongodb";
import { redirect } from "next/navigation";
import { getMemorySettings, listMemories } from "@claudius/shared";
import { MemoriesView } from "@/components/memories/memories-view";
import { auth } from "@/lib/auth";

// Node runtime: this page reaches Mongo directly for the initial memory list.
export const runtime = "nodejs";

/**
 * The memory dashboard — Phase 3's signature screen. Initial data (the memory
 * list, newest first, plus the on/off setting and count) is fetched server-side
 * and handed to the client view, which owns filtering, sorting, editing, and the
 * master toggle. Everything is owner-scoped (invariant #1).
 */
export default async function MemoriesPage(): Promise<React.ReactNode> {
  const session = await auth();
  if (!session?.user) redirect("/");

  const userId = new ObjectId(session.user.id);
  const [memories, settings] = await Promise.all([
    listMemories(userId, { sort: "newest" }),
    getMemorySettings(userId),
  ]);

  return <MemoriesView initialMemories={memories} initialSettings={settings} />;
}
