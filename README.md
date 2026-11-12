# SledWerx

**Your Snowmobile Garage.** SledWerx is a snowmobile garage and maintenance management application.

> Status: project foundation only. The app currently shows a placeholder homepage. Authentication, database access, and maintenance features have not been built yet.

## Tech stack

- [Next.js](https://nextjs.org) (App Router) with TypeScript
- [Tailwind CSS](https://tailwindcss.com) v4
- ESLint (`eslint-config-next`)
- [Supabase](https://supabase.com) for auth, PostgreSQL, and storage (clients configured with `@supabase/ssr`; schema built in staged migrations; no auth screens yet)
- [Vercel](https://vercel.com) for hosting (not deployed yet)
- Progressive Web App support (a web app manifest is in place; offline/service worker support comes later)

## Prerequisites

- Node.js 20.9 or newer
- npm (ships with Node.js)

## Getting started

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000).

## Scripts

| Command             | Description                                    |
| ------------------- | ---------------------------------------------- |
| `npm run dev`       | Start the development server                   |
| `npm run build`     | Create a production build                      |
| `npm run start`     | Serve the production build (run `build` first) |
| `npm run lint`      | Run ESLint                                     |
| `npm run typecheck` | Run the TypeScript compiler without emitting   |

To build and run in production mode locally:

```bash
npm run build
```

```bash
npm run start
```

## Continuous integration

GitHub Actions (`.github/workflows/ci.yml`) runs lint, typecheck, build, and database tests on Node.js 22 for every pull request and every push to `main`. The database tests run against a temporary local Supabase database, never the live project.

## Deployment

SledWerx is hosted on [Vercel](https://vercel.com). The Vercel project is connected to this GitHub repository, so:

- Each pull request gets its own **preview deployment**.
- Merging into `main` creates a **production deployment**.

Vercel detects Next.js and runs `npm run build`; no extra configuration is needed. Set environment variables (see [Environment variables](#environment-variables)) in the Vercel project settings, not in the repository.

## Project structure

```
.
├── .github/workflows/      # CI (lint, typecheck, build, database tests)
├── docs/
│   └── database.md         # Data model, permissions, migration workflow
├── public/
│   └── icons/              # App icons (favicon, PWA)
├── src/
│   ├── app/                # App Router routes, layouts, global styles
│   │   ├── globals.css     # Tailwind import and theme tokens
│   │   ├── layout.tsx      # Root layout, fonts, metadata, viewport
│   │   ├── manifest.ts     # PWA web app manifest
│   │   └── page.tsx        # Placeholder homepage
│   ├── lib/
│   │   └── supabase/
│   │       ├── client.ts   # Browser client (Client Components)
│   │       ├── server.ts   # Server client (Server Components, Server Functions, Route Handlers)
│   │       ├── proxy.ts    # Session refresh used by src/proxy.ts
│   │       └── env.ts      # Reads Supabase environment variables
│   └── proxy.ts            # Next.js Proxy: refreshes the Supabase session on each request
├── supabase/
│   ├── config.toml         # Local Supabase settings (CLI)
│   ├── migrations/         # Version-controlled SQL migrations
│   └── tests/              # pgTAP database tests
├── .env.example            # Template for local environment variables
├── eslint.config.mjs
├── next.config.ts
└── tsconfig.json
```

Import from `src` using the `@/` alias, for example `import { createClient } from "@/lib/supabase/server"`.

## Environment variables

Copy the template and fill in the values from your Supabase project (**Project Settings → API**):

```bash
cp .env.example .env.local
```

| Variable                               | Purpose                                         |
| -------------------------------------- | ----------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`             | Supabase project URL                            |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key (`sb_publishable_...`) |

`.env.local` and all other `.env*` files (except `.env.example`) are git-ignored. **Never commit credentials, API keys, or secrets**, and never put a secret or `service_role` key in a `NEXT_PUBLIC_` variable. For deployments, add the same variables in the Vercel project settings.

If the variables are missing, the app still runs: the proxy skips the session refresh, and creating a Supabase client throws an error that names the missing variables.

## Database

The schema lives in version-controlled SQL migrations in `supabase/migrations/`, with pgTAP tests in `supabase/tests/`. Migrations are reviewed in pull requests and applied to the live project manually. CI never applies them. See [docs/database.md](docs/database.md) for the data model, permissions, and the steps for applying a migration.

```bash
npm run db:start
```

```bash
npm run db:test
```

(`db:start` runs the local Supabase stack and requires Docker.)

## Supabase

- **Browser:** `import { createClient } from "@/lib/supabase/client"` in Client Components.
- **Server:** `const supabase = await createClient()` from `@/lib/supabase/server` in Server Components, Server Functions, and Route Handlers. Create one per request.
- **Session refresh:** `src/proxy.ts` (Next.js 16 renamed Middleware to Proxy) calls `supabase.auth.getClaims()` on each request, which validates the auth token and refreshes expired sessions in cookies.
- To check who is signed in on the server, use `supabase.auth.getClaims()` or `getUser()`, not `getSession()`.
