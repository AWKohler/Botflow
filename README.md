<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/botflow_white.svg">
  <img src="public/botflow_black.svg" alt="Botflow" height="60">
</picture>

# Botflow.io

OpenVibeCode is an open source AI-powered web IDE for creating, editing, and shipping projects from a browser workspace.


## Screenshots

**Building a web app**

![Demo app being created in the workspace](public/demo-app.png)

**Browsing your Convex database**

![Built-in Convex database viewer](public/convex.png)

## What It Includes

- Next.js App Router frontend and API routes
- Clerk authentication
- Project/workspace flows with cloud-backed services
- GitHub integration hooks
- Drizzle database tooling

## Prerequisites

- Node.js 20+
- [pnpm](https://pnpm.io/installation)

## Quick Start (pnpm)

1. Install dependencies:

```bash
pnpm install
```

2. Create your environment file:

```bash
cp .env.local.example .env.local
```

If `.env.local.example` does not exist yet, create `.env.local` manually with the template below.

3. Add all required environment variables to `.env.local`:

```env
# Required: PostgreSQL / Neon
DATABASE_URL="postgresql://USER:PASSWORD@HOST/DB?sslmode=require&channel_binding=require"

# Required: Clerk
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="pk_test_or_pk_live_xxx"
CLERK_SECRET_KEY="sk_test_or_sk_live_xxx"

# Required: App behavior
NEXT_PUBLIC_DEBUG_PREVIEW="1"

# Required: Convex
CONVEX_TEAM_ID="your_convex_team_id"
CONVEX_TEAM_TOKEN="your_convex_team_token"
CONVEX_TEAM_TOKEN_NAME="your_convex_team_token_name"

# Required: Worker
FLY_WORKER_URL="https://your-worker-url.fly.dev"
WORKER_AUTH_TOKEN="your_worker_auth_token"

# Required: GitHub OAuth
GITHUB_CLIENT_ID="your_github_client_id"
GITHUB_CLIENT_SECRET="your_github_client_secret"

# Required: Public app URL
NEXT_PUBLIC_APP_URL="https://your-app-domain.example"

# Required: Cloudflare
CLOUDFLARE_API_TOKEN="your_cloudflare_api_token"
CLOUDFLARE_ACCOUNT_ID="your_cloudflare_account_id"
```

All variables above are required for this project configuration.

4. Start the dev server:

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## Database Commands

```bash
pnpm db:generate
pnpm db:migrate
pnpm db:push
```

## Scripts

```bash
pnpm dev
pnpm build
pnpm start
pnpm lint
```

## Security Note

Never commit `.env.local` or share real credentials in issues, screenshots, or docs.
