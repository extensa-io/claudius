import { redirect } from "next/navigation";
import { auth, signIn } from "@/lib/auth";

/**
 * Landing page. Signed-in users are sent straight to the chat app; signed-out
 * visitors get a single Google sign-in button. Role is resolved server-side in
 * the auth callbacks (never supplied by the client) and used once they reach /chat.
 */
export default async function Home(): Promise<React.ReactNode> {
  const session = await auth();
  if (session?.user) redirect("/chat");

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center p-8">
      <div className="w-full max-w-md space-y-8 text-center">
        <div className="space-y-3">
          <h1 className="text-4xl font-semibold tracking-tight">Claudius</h1>
          <p className="text-muted-foreground">
            My own Claude-based chatbot, powered by MongoDB.
          </p>
        </div>

        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: "/chat" });
          }}
        >
          <button
            type="submit"
            className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Sign in with Google
          </button>
        </form>
      </div>
    </main>
  );
}
