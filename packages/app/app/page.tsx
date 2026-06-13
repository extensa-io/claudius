export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8">
      <div className="max-w-2xl space-y-4 text-center">
        <h1 className="text-4xl font-bold tracking-tight">Claudius</h1>
        <p className="text-lg text-zinc-600 dark:text-zinc-400">
          Building my own Claude, powered by MongoDB.
        </p>
        <p className="text-sm text-zinc-500">Phase 0 skeleton.</p>
      </div>
    </main>
  );
}
