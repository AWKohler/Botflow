import { NextRequest } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getDb } from '@/db';
import { projects } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { createHash } from 'crypto';
import { extname, basename } from 'path';
import {
  getOrCreatePersistentSandbox,
  sandboxListFiles,
  sandboxRun,
} from '@/lib/vercel-sandbox';
import { materializeFrontendEnv } from '@/lib/sandbox-env';
import { getUserTierAndLimits } from '@/lib/tier';
import { countUserCfPagesDeployments } from '@/lib/usage';
import { reconcilePublicState } from '@/lib/public-bundle';
import { refreshAuthSiteUrl } from '@/lib/convex-auth-setup';
import { enforce, identifierFor } from '@/lib/rate-limit';
import { ensureBrandedDeploymentUrl } from '@/lib/cloudflare-zones';

// SSE endpoint — Vercel Pro plans allow up to 300s. Builds can be slow.
export const maxDuration = 300;
export const runtime = 'nodejs';

const SANDBOX_ROOT = '/vercel/sandbox';
const CF_BASE = 'https://api.cloudflare.com/client/v4';

function getCfConfig() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) throw new Error('Cloudflare env vars missing');
  return { accountId, apiToken };
}

async function cfFetch<T>(path: string, apiToken: string, opts: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { Authorization: `Bearer ${apiToken}` };
  let body: BodyInit | undefined;
  if (opts.body instanceof FormData) {
    body = opts.body;
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(CF_BASE + path, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body });
  return (await res.json()) as { result: T; success: boolean; errors?: Array<{ code: number; message: string }> };
}

const MIME: Record<string, string> = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject', '.txt': 'text/plain',
  '.xml': 'application/xml', '.wasm': 'application/wasm', '.map': 'application/json',
};

function computeHash(b64: string, filename: string): string {
  const ext = extname(basename(filename)).substring(1);
  return createHash('md5').update(b64 + ext).digest('hex');
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  // Strictest per-user cap — runs the full build + Cloudflare Pages deploy pipeline.
  const blocked = await enforce(identifierFor(userId, req), 'deploy');
  if (blocked) return blocked;

  const { id: projectId } = await params;

  // Public/showcase opt-in for this deploy. Off by default — a project is only
  // listed publicly when the deploy popover's checkbox is checked.
  const publishBody = (await req.json().catch(() => ({}))) as {
    public?: boolean;
    description?: string;
  };
  const makePublic = publishBody.public === true;
  const publicDescription = typeof publishBody.description === 'string' ? publishBody.description : null;
  const db = getDb();
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!project) return new Response('Not found', { status: 404 });
  if (project.platform !== 'sandboxed-web') {
    return new Response('This endpoint is only for sandboxed-web projects', { status: 400 });
  }

  // Enforce CF Pages deployment limit on first publish
  if (!project.cloudflareProjectName) {
    const [limits, current] = await Promise.all([
      getUserTierAndLimits(userId),
      countUserCfPagesDeployments(userId),
    ]);
    if (current >= limits.maxCfPagesDeployments) {
      return new Response(
        `Deployment limit reached for your ${limits.tier} plan (${current}/${limits.maxCfPagesDeployments}). Upgrade or unpublish another project.`,
        { status: 403 },
      );
    }
  }

  const projectName = project.cloudflareProjectName ?? `bf-${projectId.slice(0, 8)}`;
  const cf = getCfConfig();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: string) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data.replace(/\n/g, '\\n')}\n\n`));
      };

      try {
        send('status', 'Starting build...');

        // ── 1. pnpm run build, streaming logs ──
        const sandbox = await getOrCreatePersistentSandbox(projectId);

        // Regenerate .env from the DB so the production bundle inlines the same
        // frontend vars the user configured in the Env panel (Vite inlines
        // VITE_* at build time). DB is the source of truth.
        send('status', 'Syncing environment variables');
        try {
          await materializeFrontendEnv(projectId);
        } catch (envErr) {
          send('output', `[warn] failed to sync .env: ${envErr instanceof Error ? envErr.message : String(envErr)}`);
        }

        // Ensure dependencies are present. Fresh / migrated / forked sandboxes
        // may never have had a dev server started, so node_modules (and the
        // build's `tsc`/`vite` binaries) won't exist yet. Install on demand.
        send('status', 'Checking dependencies');
        const nmCheck = await sandbox.runCommand({
          cmd: 'sh',
          args: ['-lc', `test -d ${SANDBOX_ROOT}/node_modules`],
          cwd: SANDBOX_ROOT,
        });
        if ((await nmCheck.wait()).exitCode !== 0) {
          send('status', 'Installing dependencies (first deploy)…');
          const inst = await sandbox.runCommand({
            cmd: 'pnpm',
            args: ['install'],
            cwd: SANDBOX_ROOT,
            detached: true,
          });
          try {
            for await (const chunk of inst.logs()) {
              const text = typeof chunk.data === 'string' ? chunk.data : new TextDecoder().decode(chunk.data);
              for (const line of text.split('\n')) {
                if (line.length > 0) send('output', line);
              }
            }
          } catch { /* ignore log stream hiccups */ }
          const instRes = await inst.wait();
          if (instRes.exitCode !== 0) {
            send('build_error', `Dependency install failed (exit ${instRes.exitCode}). Try again.`);
            controller.close();
            return;
          }
        }

        send('status', 'Running pnpm build');
        const cmd = await sandbox.runCommand({
          cmd: 'pnpm',
          args: ['run', 'build'],
          cwd: SANDBOX_ROOT,
          detached: true,
        });

        let outputBuffer = '';
        try {
          for await (const chunk of cmd.logs()) {
            const text = typeof chunk.data === 'string' ? chunk.data : new TextDecoder().decode(chunk.data);
            outputBuffer += text;
            // Emit each line individually so the client can render terminal-style.
            for (const line of text.split('\n')) {
              if (line.length > 0) send('output', line);
            }
          }
        } catch (logErr) {
          send('output', `[log stream error: ${logErr instanceof Error ? logErr.message : String(logErr)}]`);
        }

        const result = await cmd.wait();
        if (result.exitCode !== 0) {
          send('build_error', outputBuffer || `Build failed with exit code ${result.exitCode}`);
          controller.close();
          return;
        }

        // ── 2. Locate the build output directory ──
        // vite → dist, create-react-app → build, next export → out
        send('status', 'Build complete. Locating output...');
        let outputDir = 'dist';
        const candidates = ['dist', 'build', 'out', '.output/public'];
        for (const c of candidates) {
          const ls = await sandboxRun(projectId, 'sh', ['-c', `test -d ${SANDBOX_ROOT}/${c} && echo yes || echo no`]);
          if (ls.stdout.trim() === 'yes') { outputDir = c; break; }
        }
        send('status', `Reading ${outputDir}/`);

        // ── 3. List + read files ──
        const entries = await sandboxListFiles(projectId, `/${outputDir}`, true);
        const fileEntries = entries.filter(e => e.type === 'file');
        if (fileEntries.length === 0) {
          send('build_error', `No files found in /${outputDir}. Make sure your build script writes there.`);
          controller.close();
          return;
        }

        // Read all files in a single tar+base64 round-trip to keep this fast.
        // Pipe tar | base64 -w 0 stdout → we then unpack client-side. Simpler: read each.
        const files: Record<string, string> = {};
        const batchSize = 6;
        for (let i = 0; i < fileEntries.length; i += batchSize) {
          const batch = fileEntries.slice(i, i + batchSize);
          await Promise.all(batch.map(async (e) => {
            const abs = `${SANDBOX_ROOT}${e.path}`;
            // Use sandbox.readFileToBuffer through a fresh shell would be slow; use base64 cat
            const res = await sandboxRun(projectId, 'sh', ['-c', `base64 -w 0 < "${abs}"`]);
            if (res.exitCode === 0) {
              // Strip output dir prefix so paths in CF manifest are relative to root.
              const rel = e.path.replace(new RegExp(`^/${outputDir}/?`), '');
              if (rel) files[rel] = res.stdout.trim();
            }
          }));
          send('status', `Read ${Math.min(i + batchSize, fileEntries.length)}/${fileEntries.length} files`);
        }

        // ── 4. CF Pages upload ──
        send('status', 'Creating Cloudflare project...');
        if (!project.cloudflareProjectName) {
          const createRes = await cfFetch(`/accounts/${cf.accountId}/pages/projects`, cf.apiToken, {
            body: { name: projectName, production_branch: 'main' },
          });
          if (!createRes.success) {
            const isConflict = createRes.errors?.some(e => e.code === 8000007);
            if (!isConflict) {
              send('build_error', `Failed to create CF project: ${JSON.stringify(createRes.errors)}`);
              controller.close();
              return;
            }
          }
        }

        interface FileEntry { filename: string; base64: string; hash: string; contentType: string }
        const fileMeta: FileEntry[] = [];
        for (const [filePath, b64] of Object.entries(files)) {
          const filename = filePath.startsWith('/') ? filePath.slice(1) : filePath;
          const hash = computeHash(b64, filename);
          const ext = extname(filename).toLowerCase();
          fileMeta.push({ filename, base64: b64, hash, contentType: MIME[ext] ?? 'application/octet-stream' });
        }

        send('status', 'Requesting upload token...');
        const jwtRes = await cfFetch<{ jwt: string }>(
          `/accounts/${cf.accountId}/pages/projects/${projectName}/upload-token`,
          cf.apiToken,
        );
        if (!jwtRes.success) {
          send('build_error', `Upload token failed: ${JSON.stringify(jwtRes.errors)}`);
          controller.close();
          return;
        }
        const uploadJwt = jwtRes.result.jwt;

        const allHashes = [...new Set(fileMeta.map(f => f.hash))];
        const missingRes = await cfFetch<string[]>('/pages/assets/check-missing', cf.apiToken, {
          body: { hashes: allHashes },
        });
        const missingHashes = new Set(missingRes.success ? missingRes.result : allHashes);

        if (missingHashes.size > 0) {
          send('status', `Uploading ${missingHashes.size} files...`);
          const seen = new Set<string>();
          const toUpload = fileMeta.filter(f => {
            if (!missingHashes.has(f.hash) || seen.has(f.hash)) return false;
            seen.add(f.hash);
            return true;
          });
          const BATCH = 20;
          for (let i = 0; i < toUpload.length; i += BATCH) {
            const batch = toUpload.slice(i, i + BATCH);
            const payload = batch.map(f => ({ key: f.hash, value: f.base64, metadata: { contentType: f.contentType }, base64: true }));
            const r = await fetch(CF_BASE + '/pages/assets/upload', {
              method: 'POST',
              headers: { Authorization: `Bearer ${uploadJwt}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });
            if (!r.ok) {
              send('build_error', `Upload failed: ${await r.text()}`);
              controller.close();
              return;
            }
            send('status', `Uploaded ${Math.min(i + BATCH, toUpload.length)}/${toUpload.length}`);
          }
          await fetch(CF_BASE + '/pages/assets/upsert-hashes', {
            method: 'POST',
            headers: { Authorization: `Bearer ${uploadJwt}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ hashes: allHashes }),
          });
        }

        send('status', 'Deploying...');
        const manifest: Record<string, string> = {};
        for (const f of fileMeta) manifest['/' + f.filename] = f.hash;

        const form = new FormData();
        form.append('manifest', JSON.stringify(manifest));
        form.append('branch', 'main');
        const deployRes = await cfFetch<{ url: string; id: string }>(
          `/accounts/${cf.accountId}/pages/projects/${projectName}/deployments`,
          cf.apiToken,
          { body: form },
        );
        if (!deployRes.success) {
          send('build_error', `Deployment failed: ${JSON.stringify(deployRes.errors)}`);
          controller.close();
          return;
        }

        // Preserve managed-domain hostname if already attached; otherwise use the
        // white-label branded domain (falls back to *.pages.dev when unconfigured).
        const deploymentUrl = project.managedDomainHostname
          ? `https://${project.managedDomainHostname}`
          : await ensureBrandedDeploymentUrl(projectName);

        await db
          .update(projects)
          .set({
            cloudflareProjectName: projectName,
            cloudflareDeploymentUrl: deploymentUrl,
            updatedAt: new Date(),
          })
          .where(eq(projects.id, projectId));

        // Now that the published origin is known, expand the Convex Auth
        // redirect allowlist so OAuth sign-in returns to the live site (not the
        // dev preview). No-op when auth isn't configured. Fire-and-forget.
        void refreshAuthSiteUrl(projectId).catch(() => {});

        send('published', JSON.stringify({ url: deploymentUrl, projectName }));

        // Reconcile public/showcase state: tar the source → UploadThing and mark
        // public when opted in, otherwise delete any bundle and mark private.
        try {
          send('status', makePublic ? 'Saving public source bundle…' : 'Updating visibility…');
          const result = await reconcilePublicState(projectId, { makePublic, description: publicDescription });
          send('public_listed', JSON.stringify(result));
        } catch (e) {
          // Non-fatal — the deploy itself already succeeded.
          send('public_error', e instanceof Error ? e.message : String(e));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        send('build_error', `Publish failed: ${msg}`);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
