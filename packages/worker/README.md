# @claudius/worker

The Claudius background worker. A long-lived Node process, deployed on
Railway, that takes long-running work off Vercel's request path. MongoDB is the
only coordination layer between the app and this worker — there is no queue
product; that constraint is deliberate.

## What it does

- **Deep research.** Consumes `research` jobs: plan → search (Tavily) → fetch and
  read pages → iterate to coverage or budget → synthesize a cited Markdown report.
  The report is written to `jobs.result` and appended to the conversation's
  checkpoint so it lives in chat history. Every model call passes the shared tier
  gate and writes a `research` `usage_events` row.
- **Memory extraction.** Consumes `memory_extraction` jobs, reusing the exact
  Phase 3 orchestrator (`processConversationMemories`). The Vercel cron and the
  sign-in pass now only *enqueue* these jobs; the model work happens here.

## How it consumes jobs

The worker claims work with an atomic `findOneAndUpdate` (queued → running) and is
woken by one of two triggers, selected by `JOB_CONSUME_MODE`:

- `changestream` (default): a MongoDB change stream on `jobs` inserts. Needs a
  replica set — Atlas M10 and up. A low-frequency safety sweep covers missed
  events.
- `poll`: a timer-based fallback. The documented path for readers on Atlas M0,
  which has no change streams.

On boot it runs **stale-claim recovery**: any job left `running` by a process that
was killed mid-job is reset to `queued` and re-run, so a restart never strands
work.

## Two facts that shape the install

1. **It's an npm workspaces package.** The install must run at the **repo root**,
   not inside `packages/worker`. Only a root install creates the `node_modules`
   symlink for `@claudius/shared` and pulls in its transitive deps. If the build
   context is scoped to `packages/worker`, the worker can't resolve the shared
   package and fails at import.
2. **It runs TypeScript directly with `tsx`** (no compile step), so `tsx` has to
   exist at runtime. For that reason `tsx` is a runtime **dependency**, not a
   devDependency: a build environment that prunes devDependencies would otherwise
   leave the container without it and the start command would fail with
   `tsx: not found`. (`typescript` stays in dev; `tsx` transpiles via esbuild and
   doesn't need `tsc` at runtime.)

## Running locally

From the repo root (a workspaces install shares one `node_modules`):

```bash
npm install
npm run worker:dev        # tsx watch, loads ../../.env
```

The only differences from production are the env source (a local `.env` vs. the
Railway service variables) and the file watch.

## Deploying to Railway

The worker is a background service: it listens on no port and needs no health
check. Railway just keeps the long-lived process running; ignore any
"no port detected" prompt.

### 1. Create the service

Create a Railway project and add a service from the GitHub repo
(`extensa-io/claudius`).

### 2. Root Directory = repo root

In the service **Settings**, leave **Root Directory** blank (the repo root). This
is the critical setting: it makes the whole monorepo the build context so the
workspace install can resolve `@claudius/shared`.

### 3. Build and start commands

Either path works; the UI-command path is simplest.

- **Railway UI (recommended).** Set:
  - **Custom Build Command:** `npm install`
  - **Custom Start Command:** `npm --workspace @claudius/worker run start`
- **Config as code.** Keep `packages/worker/nixpacks.toml` and set a service
  variable `NIXPACKS_CONFIG_FILE=packages/worker/nixpacks.toml`. The toml pins
  Node 20, runs `npm install`, forces an empty build phase (so Nixpacks does not
  auto-run the root `next build`), and starts the worker.

The start command is a plain `tsx src/index.ts` with no `--env-file`, because
Railway injects the service variables into the process directly. (The `--env-file`
flag is only for local dev via `worker:dev`.)

### 4. Environment variables

The worker needs only a subset of the app's env (the shared schema makes the
app-only secrets optional so the worker runs without them). Add these under the
service **Variables**:

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI` | Atlas connection (the job bus, checkpointer, and all data) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` | Bedrock model access |
| `TAVILY_API_KEY` | Research web search + page extraction |
| `VOYAGE_API_KEY` | Embeddings for memory persistence |
| `JOB_CONSUME_MODE` | `changestream` (default) or `poll` (optional) |
| `LANGSMITH_TRACING` / `LANGSMITH_API_KEY` / `LANGSMITH_PROJECT` / `LANGSMITH_ENDPOINT` | Tracing, optional; same flags as the app |

It does **not** need `AUTH_SECRET`, `AUTH_GOOGLE_ID/SECRET`, `ADMIN_EMAIL`,
`BLOB_READ_WRITE_TOKEN`, or `CRON_SECRET`.

`changestream` mode needs a replica set (Atlas M10+). On an M0, set
`JOB_CONSUME_MODE=poll`.

### 5. Deploy and verify

On deploy the logs should show:

```
[worker] starting consumer {"mode":"changestream"}
[worker] worker ready
```

For an end-to-end check, start a research job from the app and watch the logs
carry it through to `research job complete`.

## Cancellation & budgets

Research jobs are bounded by the `researchBudget` settings singleton (max
searches, pages, tokens, wall-clock) and stop at whichever ceiling they hit first.
A job the user cancels (status `cancelled`) is honored between steps, so a cancel
lands within one step.
