import { auth, signIn, signOut } from "@/lib/auth";

/**
 * Phase 0 landing page. Signed out: a single Google sign-in button. Signed in:
 * the user's name, email, and server-resolved role. Role comes from the session
 * token (set in the auth callbacks), never from the client.
 */
export default async function Home() {
  const session = await auth();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8">
      <div className="w-full max-w-md space-y-6 text-center">
        <div className="space-y-2">
          <h1 className="text-4xl font-bold tracking-tight">Claudius</h1>
          <p className="text-zinc-600 dark:text-zinc-400">
            Building my own Claude, powered by MongoDB.
          </p>
        </div>

        {session?.user ? (
          <div className="space-y-4 rounded-lg border border-zinc-200 p-6 text-left dark:border-zinc-800">
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-zinc-500">Name</dt>
                <dd className="font-medium">{session.user.name ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-zinc-500">Email</dt>
                <dd className="font-medium">{session.user.email ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-zinc-500">Role</dt>
                <dd className="font-medium">{session.user.role}</dd>
              </div>
            </dl>
            <form
              action={async () => {
                "use server";
                await signOut();
              }}
            >
              <button
                type="submit"
                className="w-full rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
              >
                Sign out
              </button>
            </form>
          </div>
        ) : (
          <form
            action={async () => {
              "use server";
              await signIn("google");
            }}
          >
            <button
              type="submit"
              className="w-full rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              Sign in with Google
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
