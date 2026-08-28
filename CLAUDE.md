# Claudius

I'm building my own Claude-based chatbot, powered by MongoDB, for authorized users, with a capped public guest tier.
Built as a learning project and the subject of a published article series.
Not commercial.
The app is hosted at https://www.askclaudius.dev

## How to work in this repo

The build is no longer organized in phases. Work from the request in front of you: implement what was asked, at the scope asked, and don't pull in adjacent features because a spec once grouped them together. The invariants and conventions below still bind every change.

`specs/` is now a historical record, not a scope contract. The phase specs in there describe how the app got here and are useful for understanding why something is built the way it is, but they do not define current scope and are not a queue of work to pick up. Do not start a phase because a spec exists for it. Read a spec when you need the rationale behind existing code, or when I explicitly point you at one.

When I do ask for a spec-driven piece of work, say so and I'll name the spec; then that spec wins for scope, this file wins for conventions and invariants, and its Acceptance criteria are the definition of done. For anything larger than a small change, write the spec first and get my approval on it before building.

`npm run check` must pass before any work is called done.

`npm run check` is not sufficient on its own. It runs typecheck, lint and tests, none of which walk the client bundle, so a change that touches anything under `packages/app/components/`, or any module those components import (`lib/chat/help.ts`, `lib/chat/types.ts`, and friends), also needs `npm run build` before it is pushed. A value imported from the `@claudius/shared` barrel into client-reachable code passes all three checks and then fails the Vercel build with `Module not found: Can't resolve 'net'`, because the barrel re-exports the Mongo client and the search backends. Run the build locally rather than discovering it in a deployment. See Commands for the env wrapper the build needs locally.

The `specs/` directory is private. It is gitignored and never pushed to the public repo. The design rationale and editorial sequencing inside it are part of the article series, not the codebase. Do not quote or paraphrase spec contents in commit messages, PR descriptions, code comments, or any other text that lands in the public repo. Public-facing artifacts should derive from the work itself.

The `.resources/articles` directory is private and gitignored. Article source material is captured there when I ask for it, not automatically.

## Stack

- Next.js (App Router) on Vercel, TypeScript strict mode everywhere
- Auth.js v5 (`next-auth@beta`) with Google provider and `@auth/mongodb-adapter`
- MongoDB Atlas: application data, LangGraph checkpoints, Atlas Vector Search
- LangGraph JS (`@langchain/langgraph`) as the agent runtime
- `@langchain/langgraph-checkpoint-mongodb` for conversation state
- `@langchain/aws` ChatBedrockConverse for all Claude model access via AWS Bedrock
- Vercel AI SDK (`ai`, `@ai-sdk/react`) for the streaming chat frontend
- Voyage AI (`voyage-4`) for embeddings
- Vercel Blob for raw file storage with direct client uploads
- Tavily for web search
- Zod for every external boundary (API input, env, model output parsing)
- A Railway worker service in this same monorepo under `packages/worker/`

Install latest stable versions and consult current package documentation rather than assuming API shapes. LangChain and the AI SDK move fast; verify signatures against the installed version.

## Repo layout

npm workspaces monorepo. Three npm workspaces: `app`, `shared`, and `worker`. `packages/android` sits alongside them but is not a workspace: it is a Trusted Web Activity wrapper built with Gradle, it has no `package.json`, and npm ignores it despite the `packages/*` glob.

```
packages/
  app/                          Next.js App Router (the deployed Vercel web app)
    app/                          Routes and UI
    lib/auth/                     Auth.js config, role resolution, allowlist
    lib/                          App-only helpers (anything Next.js-bound)
  shared/                       Shared library, imported by app and worker
    src/env.ts                    Zod-validated env schema
    src/db/                       Mongo client, collection helpers, Zod schemas, indexes
    src/agent/                    LangGraph graph, tools, prompts, checkpointer setup
    src/tiers/                    Tier definitions, enforcement middleware, circuit breaker
    src/usage/                    usage_events writers and aggregation helpers
  worker/                       Railway worker
  android/                      Trusted Web Activity wrapper (Gradle, not an npm workspace)
specs/                          Historical phase specs — private, gitignored, never pushed
```

`@claudius/shared` is consumed by `@claudius/app` via npm workspace resolution and Next.js `transpilePackages`. Anything the worker also needs lives in `shared`; anything Next.js-bound (route handlers, Auth.js wiring, React components) lives in `app`.

## Data model

Database `claudius`. Collections: `users`, `conversations`, `checkpoints`, `checkpoint_writes`, `memories`, `documents`, `chunks`, `usage_events`, `settings`, `jobs`. Field-level definitions live in `packages/shared/src/db/schemas/`; `specs/phase-0-foundations.md` records the original design rationale. The checkpointer owns `checkpoints` and `checkpoint_writes`; never write to them directly.

## Non-negotiable invariants

These hold for every change. Violating any of them is a bug regardless of what else works.

1. Every query touching user-owned data filters by `userId` at the query layer. No route, tool, or vector search may return another user's conversations, memories, documents, or chunks. Vector searches use pre-filters, never post-filtering.
2. Roles are `admin`, `member`, `guest`. Role is resolved server-side in the Auth.js `signIn`/`jwt` callbacks from the allowlist in `settings`. The client never supplies role or tier information; the session token does.
3. Every Bedrock invocation goes through the tier enforcement layer in `packages/shared/src/tiers/` (model allowed for role, daily message cap, guest circuit breaker) and writes a `usage_events` document with token counts. No direct model calls that bypass these.
4. Guest-created documents in `conversations`, `memories`, and conversation threads carry `expiresAt` for the TTL index. Member and admin documents omit the field. The one deliberate exception is `jobs`: finished `memory_extraction` and `memory_consolidation` jobs carry a 30-day `expiresAt` whoever owns them, because a finished memory job is an audit trail nothing reads. A guest's shorter expiry is never extended, and research jobs never carry the field.
5. Secrets only via environment variables validated by a Zod env schema at startup. Never log secrets, tokens, or full message content in production paths.
6. Admin role grants access to settings, user management, and aggregate usage data. It never grants read access to other users' conversation or memory content.
7. No public registration logic beyond Google sign-in with server-side role assignment. There is no path that elevates a guest except an admin action.

## Conventions

- TypeScript strict, no `any`, no non-null assertions where a guard is reasonable
- Zod schemas are the single type source for documents; derive TS types with `z.infer`
- Server components by default; client components only where interactivity requires
- Route handlers stay thin: validate, call a `shared` or `app/lib` function, shape the response
- Named exports, no default exports except Next.js conventions require them
- Errors: typed result objects or thrown `AppError` with a user-safe message; never leak internals to the client
- Indexes are defined in code (`packages/shared/src/db/indexes.ts`) and applied by an idempotent script, not created ad hoc

### Client-reachable imports from `shared`

Client components and anything they import must never take a VALUE from the `@claudius/shared` barrel. The barrel re-exports the env schema, the Mongo client and the search backends, so a value import drags all of it into the browser bundle and the build fails on unresolvable Node built-ins. Type-only imports (`import type`) are fine anywhere, since TypeScript erases them.

When a client needs a real constant from `shared`, put it in a dependency-free leaf module, give it a subpath in the `exports` map of `packages/shared/package.json`, and deep-import that path. Existing examples: `@claudius/shared/documents/constants` for the upload caps and `@claudius/shared/answer/languages` for the translate operator's language table. Where a server module also needs the same constant, re-export the leaf from it so server callers keep one import.

### Workspace dependency ownership

Every devDep needed by a workspace's build, lint, typecheck, or test runs must be declared in that workspace's `package.json`, not at the monorepo root. Root devDeps are reserved for cross-workspace orchestration (currently only `vitest` for the root test runner that walks `test.projects`).

Why: Vercel's monorepo install scopes to the Root Directory workspace's declared deps. Anything sitting only at root is invisible to `next build` and surfaces as a `Cannot find module` error during the deployed TypeScript check. Duplication between root and workspace is fine — npm dedupes via the lockfile — but each workspace must self-declare what its scripts and config files import.

When adding a new tool: figure out which workspaces import it (in scripts, config files, source, or tests) and declare it as a devDep in each one. If it is only used at root, declare it at root and nowhere else.

### The mongodb peer override

Two packages want driver 6 while this repo runs driver 7. `@auth/mongodb-adapter` declares it as a peer dependency (`mongodb@^6`); `@langchain/langgraph-checkpoint-mongodb` declares it as a real dependency (`mongodb@^6.21.0`). The override covers both kinds, but the difference matters: without an entry the adapter produces a loud `ERESOLVE`, whereas the checkpointer quietly installs its own nested copy. Both entries are load-bearing; dropping either one reintroduces its failure mode.

The failure is invisible locally. `npm install` only does a full peer resolution against a clean tree, so with `node_modules` already present it reports "up to date" and typecheck, lint, tests and even `next build` all reuse the existing tree. Vercel installs into an empty container, does the full resolve, and hard-fails. To check an override change, copy every workspace `package.json` to a scratch directory **without** the lockfile, run `npm install --ignore-scripts`, and require zero peer warnings plus an `npm ls mongodb` free of `invalid:` markers. With the lockfile copied across, the check passes even when the override is broken.

The versions in the override are literal and must be bumped in lockstep with the `mongodb` range in the three workspaces. npm's `$mongodb` self-reference does not work here: it resolves against the root package's own `dependencies`, and this root has none, so it fails with `Unable to resolve reference $mongodb`. Adding a root `mongodb` dependency purely to feed the reference would contradict the ownership rule above.

Rejected alternatives: `--legacy-peer-deps` disables peer checking repo-wide and silently drops optional peers; setting it as a Vercel `installCommand` would make local and deployed resolution diverge, so a conflict could pass locally and still break the deploy.

**Changing any of these versions requires regenerating the lockfile from scratch.** npm's incremental resolver cannot apply these overrides to a package it is adding in the same pass. Bumping the driver alone fails with `ERESOLVE`; bumping the driver together with the adapter and checkpointer silently yields a tree with a nested `mongodb@6` under the checkpointer while the workspaces run 7, which means two drivers in one process and the checkpointer operating on a client built by the other one. Re-running `npm install` does not converge, it reports "up to date" over the wrong tree, and doing the refresh as a separate earlier commit does not help either.

The procedure is to delete `package-lock.json` and every `node_modules`, reinstall, and then confirm with `npm ls mongodb` that exactly one driver version appears, hoisted, with both dependents marked `overridden` and no `invalid:` markers. `npm install --package-lock-only` is not a substitute; it still reads an existing `node_modules` and reproduces the bad tree. Expect the regenerated lockfile to carry the rest of the tree forward within its existing caret ranges, which is a large diff and is normal for this operation.

## Environment variables

`MONGODB_URI`, `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `VOYAGE_API_KEY`, `TAVILY_API_KEY`, `BRAVE_API_KEY`, `BLOB_READ_WRITE_TOKEN`, `LANGSMITH_*`, `ADMIN_EMAIL` (bootstrap admin), `TWELVEDATA_API_KEY` (optional, market data for quote mode). Validate all of them in `packages/shared/src/env.ts`.

## Commands

- `npm run dev` local development
- `npm run check` typecheck + lint + tests (must pass before any work is done)
- `npm run build` production build (also required when a change is client-reachable; it is the only check that walks the browser bundle). Unlike `dev`, this script does not load `.env`, so it fails locally at page-data collection with `Invalid environment configuration`. Run it as `npx dotenv-cli -e ../../.env -- next build` from `packages/app`. Vercel is unaffected because it injects env itself.
- `npm run db:indexes` apply index definitions idempotently

## Bedrock notes

Use cross-region inference profile IDs from the `settings` model catalog, not bare model IDs. The model catalog document holds id, display name, per-million-token input and output pricing, and which roles may use it. Token counts for `usage_events` come from the Converse response usage metadata.

## Content awareness

This build is documented publicly. Prefer clear, explainable implementations over clever ones; code from this repo appears in articles read by developers coming from relational backgrounds. When a design decision is interesting (embed vs reference, pre-filtering vector search, TTL-based ephemerality, change streams as a job bus), leave a short comment explaining why, since those comments seed the articles.
