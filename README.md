# SledWerx

**Your Snowmobile Garage.** SledWerx is a snowmobile garage and maintenance management application.

> Status: project foundation only. The app currently shows a placeholder homepage. Authentication, database access, and maintenance features have not been built yet.

## Tech stack

- [Next.js](https://nextjs.org) (App Router) with TypeScript
- [Tailwind CSS](https://tailwindcss.com) v4
- ESLint (`eslint-config-next`)
- [Supabase](https://supabase.com) for auth, PostgreSQL, and storage (planned, not connected yet)
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

GitHub Actions (`.github/workflows/ci.yml`) runs lint, typecheck, and build on Node.js 22 for every pull request and every push to `main`.

## Deployment

SledWerx is hosted on [Vercel](https://vercel.com). The Vercel project is connected to this GitHub repository, so:

- Each pull request gets its own **preview deployment**.
- Merging into `main` creates a **production deployment**.

Vercel detects Next.js and runs `npm run build`; no extra configuration is needed. Set environment variables (see [Environment variables](#environment-variables)) in the Vercel project settings, not in the repository.

## Project structure

```
.
├── .github/workflows/      # CI (lint, typecheck, build)
├── public/
│   └── icons/              # App icons (favicon, PWA)
├── src/
│   ├── app/                # App Router routes, layouts, global styles
│   │   ├── globals.css     # Tailwind import and theme tokens
│   │   ├── layout.tsx      # Root layout, fonts, metadata, viewport
│   │   ├── manifest.ts     # PWA web app manifest
│   │   └── page.tsx        # Placeholder homepage
│   └── lib/
│       └── supabase/       # Supabase config placeholder (no client yet)
├── .env.example            # Template for local environment variables
├── eslint.config.mjs
├── next.config.ts
└── tsconfig.json
```

Import from `src` using the `@/` alias, for example `import { getSupabaseConfig } from "@/lib/supabase/config"`.

## Environment variables

The app runs without any environment variables today. For future Supabase integration, copy the template and fill in values locally:

```bash
cp .env.example .env.local
```

`.env.local` and all other `.env*` files (except `.env.example`) are git-ignored. **Never commit credentials, API keys, or secrets.** In production, set these values in the Vercel project settings.

| Variable                        | Purpose                     |
| ------------------------------- | --------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | Supabase project URL        |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anonymous (public) key |
