# Neuron

Neuron is a codebase intelligence app that ingests GitHub repositories, builds a dependency graph, and supports grounded Q&A plus onboarding brief generation.

## Local Development

1. Install dependencies:

```bash
npm install
```

2. Create local environment file from template:

```bash
cp .env.example .env.local
```

3. Run development server:

```bash
npm run dev
```

4. Open:

```text
http://localhost:3000
```

## Environment Variables

Use [`.env.example`](.env.example) as the source of truth.

Required:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (server only)
- `GEMINI_API_KEY` (server only)

Optional:
- `GEMINI_MODEL`
- `GITHUB_TOKEN`

## Deployment Checklist

1. Add all required env vars in your hosting provider (Vercel/Render/etc).
2. Do not commit `.env.local` or any secret-bearing files.
3. Rotate secrets before production if they were ever shared in logs/screenshots.
4. Run checks:

```bash
npm run lint
npm run build
```

5. Confirm auth flow works in production domain.
6. Verify Supabase RLS and policies are applied from [supabase/schema.sql](supabase/schema.sql).

## Security Notes

- API routes return sanitized errors (no raw provider/database internals).
- Service keys remain server-side only.
- Production headers are configured in [next.config.mjs](next.config.mjs).
- Auth middleware protects non-auth pages.

