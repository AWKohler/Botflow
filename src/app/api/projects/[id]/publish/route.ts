import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getDb } from '@/db';
import { projects } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { createHash } from 'crypto';
import { extname, basename } from 'path';
import { getUserTierAndLimits } from '@/lib/tier';
import { countUserCfPagesDeployments } from '@/lib/usage';
import { limitReachedResponse } from '@/lib/plan-response';
import { refreshAuthSiteUrl } from '@/lib/convex-auth-setup';
import { enforce, identifierFor } from '@/lib/rate-limit';

function getCfConfig() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set');
  }
  return { accountId, apiToken };
}

const CF_BASE = 'https://api.cloudflare.com/client/v4';

async function cfFetch<T = unknown>(path: string, apiToken: string, options: { body?: unknown; method?: string } = {}) {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${apiToken}`,
  };
  let body: BodyInit | undefined;
  if (options.body instanceof FormData) {
    body = options.body;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const res = await fetch(CF_BASE + path, {
    method: options.method ?? (body ? 'POST' : 'GET'),
    headers,
    body,
  });

  const data = await res.json() as { result: T; success: boolean; errors?: Array<{ code: number; message: string }> };
  return data;
}

function computeHash(base64Content: string, filename: string): string {
  const extension = extname(basename(filename)).substring(1); // e.g. "html", "js"
  return createHash('md5').update(base64Content + extension).digest('hex');
}

async function getProjectWithAuth(userId: string, projectId: string) {
  const db = getDb();
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  return project ?? null;
}

// POST — Publish / update deployment
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const blocked = await enforce(identifierFor(userId, request), 'deploy');
    if (blocked) return blocked;

    const { id: projectId } = await params;
    const project = await getProjectWithAuth(userId, projectId);
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

    const cf = getCfConfig();
    const projectName = project.cloudflareProjectName ?? `bf-${projectId.slice(0, 8)}`;

    // Enforce CF Pages deployment limit (only check on first publish for this project)
    if (!project.cloudflareProjectName) {
      const [limits, currentDeployments] = await Promise.all([
        getUserTierAndLimits(userId),
        countUserCfPagesDeployments(userId),
      ]);
      if (currentDeployments >= limits.maxCfPagesDeployments) {
        return limitReachedResponse({
          limitType: 'cf_pages_count',
          current: currentDeployments,
          limit: limits.maxCfPagesDeployments,
          tier: limits.tier,
        });
      }

      // Custom domain gating
      if (!limits.customDomain && process.env.CLOUDFLARE_BRANDED_DOMAIN) {
        // Free users get .pages.dev only — skip branded domain attachment
        // (handled below by checking limits.customDomain before the domain attach call)
      }
    }

    // Create Pages project if first publish
    if (!project.cloudflareProjectName) {
      const createRes = await cfFetch(`/accounts/${cf.accountId}/pages/projects`, cf.apiToken, {
        body: { name: projectName, production_branch: 'main' },
      });
      // 409 = already exists, fine
      if (!createRes.success) {
        const isConflict = createRes.errors?.some(e => e.code === 8000007);
        if (!isConflict) {
          return NextResponse.json(
            { error: `Failed to create Cloudflare project: ${JSON.stringify(createRes.errors)}` },
            { status: 500 }
          );
        }
      }
    }

    // Parse files from request body: { files: { "path": "base64data" } }
    const body = await request.json() as { files: Record<string, string> };
    if (!body.files || Object.keys(body.files).length === 0) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 });
    }

    // Compute hashes for all files
    interface FileEntry {
      filename: string;    // e.g. "index.html", "assets/main.js"
      base64: string;
      hash: string;
      contentType: string;
    }

    const fileEntries: FileEntry[] = [];
    for (const [filePath, base64Content] of Object.entries(body.files)) {
      const filename = filePath.startsWith('/') ? filePath.slice(1) : filePath;
      const hash = computeHash(base64Content, filename);
      // Determine content type from extension
      const ext = extname(filename).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.json': 'application/json',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.ico': 'image/x-icon',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
        '.ttf': 'font/ttf',
        '.eot': 'application/vnd.ms-fontobject',
        '.txt': 'text/plain',
        '.xml': 'application/xml',
        '.wasm': 'application/wasm',
        '.map': 'application/json',
      };
      fileEntries.push({
        filename,
        base64: base64Content,
        hash,
        contentType: mimeTypes[ext] || 'application/octet-stream',
      });
    }

    // Step 1: Get upload JWT
    const jwtRes = await cfFetch<{ jwt: string }>(
      `/accounts/${cf.accountId}/pages/projects/${projectName}/upload-token`,
      cf.apiToken
    );
    if (!jwtRes.success) {
      return NextResponse.json(
        { error: `Failed to get upload token: ${JSON.stringify(jwtRes.errors)}` },
        { status: 500 }
      );
    }
    const uploadJwt = jwtRes.result.jwt;

    // Step 2: Check which files are missing
    const allHashes = [...new Set(fileEntries.map(f => f.hash))];
    const missingRes = await cfFetch<string[]>('/pages/assets/check-missing', cf.apiToken, {
      body: { hashes: allHashes },
    });
    // Use Authorization with JWT for asset operations
    const missingHashes = new Set(missingRes.success ? missingRes.result : allHashes);

    // Step 3: Upload missing files
    if (missingHashes.size > 0) {
      // Deduplicate by hash
      const seen = new Set<string>();
      const toUpload = fileEntries.filter(f => {
        if (!missingHashes.has(f.hash) || seen.has(f.hash)) return false;
        seen.add(f.hash);
        return true;
      });

      // Upload in batches (Cloudflare accepts arrays)
      const BATCH_SIZE = 20;
      for (let i = 0; i < toUpload.length; i += BATCH_SIZE) {
        const batch = toUpload.slice(i, i + BATCH_SIZE);
        const payload = batch.map(f => ({
          key: f.hash,
          value: f.base64,
          metadata: { contentType: f.contentType },
          base64: true,
        }));

        const uploadRes = await fetch(CF_BASE + '/pages/assets/upload', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${uploadJwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        if (!uploadRes.ok) {
          const err = await uploadRes.text();
          return NextResponse.json(
            { error: `File upload failed: ${err}` },
            { status: 500 }
          );
        }
      }

      // Upsert hashes to finalize uploads
      await fetch(CF_BASE + '/pages/assets/upsert-hashes', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${uploadJwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ hashes: allHashes }),
      });
    }

    // Step 4: Create deployment with manifest
    const manifest: Record<string, string> = {};
    for (const f of fileEntries) {
      manifest['/' + f.filename] = f.hash;
    }

    const formData = new FormData();
    formData.append('manifest', JSON.stringify(manifest));
    formData.append('branch', 'main');

    const deployRes = await cfFetch<{ url: string; id: string }>(
      `/accounts/${cf.accountId}/pages/projects/${projectName}/deployments`,
      cf.apiToken,
      { body: formData }
    );

    if (!deployRes.success) {
      return NextResponse.json(
        { error: `Deployment failed: ${JSON.stringify(deployRes.errors)}` },
        { status: 500 }
      );
    }

    // Step 5: Optionally attach branded custom domain (Pro/Max only)
    const tierLimits = await getUserTierAndLimits(userId);
    const brandedDomain = tierLimits.customDomain ? process.env.CLOUDFLARE_BRANDED_DOMAIN : null;
    let deploymentUrl = `https://${projectName}.pages.dev`;

    if (brandedDomain) {
      const customDomain = `${projectName}.${brandedDomain}`;
      try {
        const domainRes = await cfFetch(
          `/accounts/${cf.accountId}/pages/projects/${projectName}/domains`,
          cf.apiToken,
          { body: { name: customDomain } }
        );
        // 409 = domain already attached, that's fine
        if (!domainRes.success) {
          const is409 = domainRes.errors?.some(e => e.code === 8000040 || e.message?.includes('already'));
          if (!is409) {
            console.warn('Failed to attach custom domain:', domainRes.errors);
          }
        }
        deploymentUrl = `https://${customDomain}`;
      } catch (err) {
        // Non-fatal — fall back to .pages.dev URL
        console.warn('Custom domain attachment error:', err);
      }
    }

    // Update DB
    const db = getDb();
    await db.update(projects)
      .set({
        cloudflareProjectName: projectName,
        cloudflareDeploymentUrl: deploymentUrl,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, projectId));

    // Expand the Convex Auth redirect allowlist to include the published origin
    // so OAuth sign-in returns to the live site. No-op when auth isn't set up.
    void refreshAuthSiteUrl(projectId).catch(() => {});

    return NextResponse.json({
      ok: true,
      url: deploymentUrl,
      projectName,
    });
  } catch (error) {
    console.error('Publish error:', error);
    return NextResponse.json(
      { error: `Publish failed: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}

// DELETE — Unpublish
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const blocked = await enforce(identifierFor(userId, _request), 'deploy');
    if (blocked) return blocked;

    const { id: projectId } = await params;
    const project = await getProjectWithAuth(userId, projectId);
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

    if (!project.cloudflareProjectName) {
      return NextResponse.json({ error: 'Not published' }, { status: 400 });
    }

    const cf = getCfConfig();

    await cfFetch(
      `/accounts/${cf.accountId}/pages/projects/${project.cloudflareProjectName}`,
      cf.apiToken,
      { method: 'DELETE' }
    );

    const db = getDb();
    await db.update(projects)
      .set({
        cloudflareProjectName: null,
        cloudflareDeploymentUrl: null,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, projectId));

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Unpublish error:', error);
    return NextResponse.json(
      { error: `Unpublish failed: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}

// GET — Status check
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const blocked = await enforce(identifierFor(userId, _request), 'read');
    if (blocked) return blocked;

    const { id: projectId } = await params;
    const project = await getProjectWithAuth(userId, projectId);
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

    return NextResponse.json({
      published: Boolean(project.cloudflareProjectName),
      url: project.cloudflareDeploymentUrl,
      projectName: project.cloudflareProjectName,
    });
  } catch (error) {
    console.error('Publish status error:', error);
    return NextResponse.json(
      { error: 'Failed to check publish status' },
      { status: 500 }
    );
  }
}
