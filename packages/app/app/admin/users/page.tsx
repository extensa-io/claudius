import { listUsersWithUsage, loadModelCatalog } from "@claudius/shared";
import { UsersTable } from "@/components/admin/users-table";

export const runtime = "nodejs";

/**
 * Admin Users panel. Loads the user list with usage and the model catalog (so
 * the per-user model-override editor can offer the real set), then hands both to
 * the interactive client table.
 */
export default async function AdminUsersPage(): Promise<React.ReactNode> {
  const [users, catalog] = await Promise.all([
    listUsersWithUsage(),
    loadModelCatalog(),
  ]);
  const models = catalog.map((m) => ({ id: m.id, displayName: m.displayName }));
  return <UsersTable initialUsers={users} models={models} />;
}
