import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { requireAdminPage } from "@/lib/auth/admin";

// Node runtime: admin pages reach Mongo directly for their initial data.
export const runtime = "nodejs";

/**
 * Admin shell. The gate lives here so every nested /admin route inherits it: a
 * non-admin gets the 404 page before any admin data is loaded (invariant #6).
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.ReactNode> {
  await requireAdminPage();

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 py-6">
      <header className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-semibold tracking-tight">Admin</h1>
          <nav className="flex items-center gap-1 text-sm">
            <Link
              href="/admin"
              className="rounded-md px-2.5 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Dashboard
            </Link>
            <Link
              href="/admin/users"
              className="rounded-md px-2.5 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Users
            </Link>
            <Link
              href="/admin/config"
              className="rounded-md px-2.5 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Config
            </Link>
          </nav>
        </div>
        <Link
          href="/chat"
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Back to chat
        </Link>
      </header>
      <main className="min-h-0 flex-1">{children}</main>
    </div>
  );
}
