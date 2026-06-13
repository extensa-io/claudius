# Claudius

I'm building my own Claude, powered by MongoDB.

A personal Claude-style chat app for authorized users with a capped public guest tier. Built as a learning project and the subject of a published article series. Not commercial. Hosted at [askclaudius.dev](https://askclaudius.dev).

## Stack

Next.js App Router (TypeScript strict), Auth.js v5, MongoDB Atlas (app data, LangGraph checkpoints, Vector Search), LangGraph JS, AWS Bedrock (Claude via cross-region inference), Vercel AI SDK, Voyage AI embeddings, Tavily web search, Vercel Blob, deployed on Vercel with a Railway worker arriving in Phase 4.

## Development

Requires Node 20 or newer.

```bash
npm install
cp .env.example .env.local   # fill in the required values
npm run dev
```

Open http://localhost:3000.

### Scripts

- `npm run dev` — start the Next.js app in development mode
- `npm run build` — production build
- `npm run check` — typecheck + lint + tests across all workspaces; the gate that must pass before any phase is marked complete
- `npm run test` — Vitest run
- `npm run typecheck` — TypeScript check across workspaces
- `npm run lint` — ESLint across workspaces

## Repo layout

```
packages/
  app/         Next.js App Router (the deployed web app)
  shared/      Shared library (db client, schemas, env validation, tiers)
specs/         Phase specs — read-only scope contracts
```

## Phases

The build is staged across five phase specs in `specs/`. Each phase's scope is locked by its spec; conventions and invariants live in `CLAUDE.md`. Current phase: **Phase 0 — Foundations**.
