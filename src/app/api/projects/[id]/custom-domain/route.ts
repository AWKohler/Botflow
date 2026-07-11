import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getDb } from '@/db';
import { projects } from '@/db/schema';
import { eq, and, isNull, ne } from 'drizzle-orm';
import { requireProjectAccess } from '@/lib/project-access';
import { getUserTierAndLimits } from '@/lib/tier';

const CF_BASE = 'https://api.cloudflare.com/client/v4';

function getCfConfig() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set');
  }
  return { accountId, apiToken };
}

async function cfFetch<T = unknown>(
  path: string,
  apiToken: string,
  options: { body?: unknown; method?: string } = {}
) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiToken}`,
  };
  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  const res = await fetch(CF_BASE + path, {
    method: options.method ?? (body ? 'POST' : 'GET'),
    headers,
    body,
  });
  const data = await res.json() as {
    result: T;
    success: boolean;
    errors?: Array<{ code: number; message: string }>;
  };
  return data;
}

/**
 * Map a Cloudflare Pages domain status string to our internal status.
 */
function mapCfStatus(cfStatus: string): 'pending' | 'active' | 'error' {
  switch (cfStatus) {
    case 'active':
    case 'active_redeployment':
      return 'active';
    case 'error':
    case 'blocked':
    case 'moved':
    case 'deleted':
      return 'error';
    default:
      // initializing, pending_deployment, pending, etc.
      return 'pending';
  }
}

/**
 * Normalize a domain string entered by the user.
 *
 * - Strips protocol, paths, ports, and trailing dots
 * - Lowercases and trims
 * - If the input is an apex domain (2 labels, e.g. myapp.com), auto-prepends "www."
 *   so the CNAME can be set up without nameserver migration.
 *
 * Returns the normalized domain, the apex domain (if applicable), and whether
 * the input was auto-converted from apex.
 */
function normalizeDomain(input: string): {
  normalized: string;
  apex: string | null;
  wasApex: boolean;
} {
  let domain = input.toLowerCase().trim();
  // Strip protocol
  domain = domain.replace(/^https?:\/\//, '');
  // Strip path / query
  domain = domain.split('/')[0];
  // Strip port
  domain = domain.split(':')[0];
  // Strip trailing dot
  domain = domain.replace(/\.$/, '');

  // Canonicalize: remove leading www. so we can make the decision ourselves
  const withoutWww = domain.replace(/^www\./, '');
  const parts = withoutWww.split('.').filter(Boolean);

  // Apex heuristic: exactly 2 labels (myapp.com). Most common TLDs.
  // Multi-part TLDs like .co.uk have 3 labels — treated as subdomain here.
  // Users with .co.uk etc. can prepend www. themselves; we note this in the UI.
  const isApex = parts.length === 2;

  if (isApex) {
    return { normalized: `www.${withoutWww}`, apex: withoutWww, wasApex: true };
  }

  return { normalized: domain, apex: null, wasApex: false };
}

/**
 * Basic domain format validation.
 * Each label: 1-63 chars, alphanumeric + hyphens, no leading/trailing hyphens.
 * Minimum 2 labels.
 */
function isValidDomain(domain: string): boolean {
  const labelRegex = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
  const parts = domain.split('.');
  if (parts.length < 2) return false;
  return parts.every((p) => p.length >= 1 && labelRegex.test(p));
}

async function getProjectWithAuth(userId: string, projectId: string) {
  const access = await requireProjectAccess(projectId, userId, "owner");
  return access?.project ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST — Add / replace custom domain
// Body: { domain: string }
// ─────────────────────────────────────────────────────────────────────────────
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id: projectId } = await params;
    const project = await getProjectWithAuth(userId, projectId);
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

    // Must be published first
    if (!project.cloudflareProjectName) {
      return NextResponse.json(
        { error: 'Your project must be published before you can connect a custom domain.' },
        { status: 400 }
      );
    }

    // Tier gate: Pro/Max only
    const tierLimits = await getUserTierAndLimits(userId);
    if (!tierLimits.customDomain) {
      return NextResponse.json(
        {
          error: 'upgrade_required',
          message: 'Custom domains are available on Pro and Max plans.',
          upgradeTarget: 'pro',
        },
        { status: 402 }
      );
    }

    const body = await request.json() as { domain?: string };
    if (!body.domain || typeof body.domain !== 'string') {
      return NextResponse.json({ error: 'A domain name is required.' }, { status: 400 });
    }

    const { normalized, apex, wasApex } = normalizeDomain(body.domain);

    if (!isValidDomain(normalized)) {
      return NextResponse.json(
        {
          error:
            'Please enter a valid domain name (e.g., myapp.com or app.myapp.com). ' +
            'Do not include "https://" or any path.',
        },
        { status: 422 }
      );
    }

    const db = getDb();

    // ── Cross-project conflict check (our DB) ─────────────────────────────
    // Prevent the same domain from being silently linked to two projects.
    const [conflict] = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(
        and(
          eq(projects.customDomain, normalized),
          ne(projects.id, projectId),
          isNull(projects.deletedAt)
        )
      )
      .limit(1);

    if (conflict) {
      return NextResponse.json(
        {
          error: 'domain_in_use',
          message: `"${normalized}" is already connected to your project "${conflict.name}". Please remove it there before connecting it here.`,
          conflictProjectName: conflict.name,
        },
        { status: 409 }
      );
    }

    const cf = getCfConfig();

    // ── Attach domain to CF Pages project ─────────────────────────────────
    const domainRes = await cfFetch<{ name: string; status: string }>(
      `/accounts/${cf.accountId}/pages/projects/${project.cloudflareProjectName}/domains`,
      cf.apiToken,
      { body: { name: normalized } }
    );

    if (!domainRes.success) {
      const errors = domainRes.errors ?? [];
      const errorMessages = errors.map((e) => e.message).join('; ');

      // Already attached to THIS project — idempotent, fetch current status
      const alreadyAttached = errors.some(
        (e) =>
          e.code === 8000040 ||
          e.message?.toLowerCase().includes('already exists') ||
          e.message?.toLowerCase().includes('already attached')
      );
      if (alreadyAttached) {
        const statusRes = await cfFetch<{ name: string; status: string }>(
          `/accounts/${cf.accountId}/pages/projects/${project.cloudflareProjectName}/domains/${encodeURIComponent(normalized)}`,
          cf.apiToken
        );
        const dbStatus = statusRes.success && statusRes.result
          ? mapCfStatus(statusRes.result.status)
          : 'pending';
        await db
          .update(projects)
          .set({ customDomain: normalized, customDomainStatus: dbStatus, updatedAt: new Date() })
          .where(eq(projects.id, projectId));
        return NextResponse.json({ ok: true, domain: normalized, apex, wasApex, status: dbStatus });
      }

      // CF-level conflict (domain used by another account's CF project)
      const isCfConflict = errors.some(
        (e) =>
          e.message?.toLowerCase().includes('in use') ||
          e.message?.toLowerCase().includes('conflict') ||
          e.message?.toLowerCase().includes('another project')
      );
      if (isCfConflict) {
        return NextResponse.json(
          {
            error: 'domain_cf_conflict',
            message:
              'This domain is already in use by another Cloudflare Pages project. ' +
              'If you recently removed it from another project, please try again in a few minutes.',
          },
          { status: 409 }
        );
      }

      return NextResponse.json(
        { error: `Cloudflare rejected the domain: ${errorMessages}` },
        { status: 500 }
      );
    }

    const cfStatus = domainRes.result?.status ?? 'initializing';
    const dbStatus = mapCfStatus(cfStatus);

    await db
      .update(projects)
      .set({ customDomain: normalized, customDomainStatus: dbStatus, updatedAt: new Date() })
      .where(eq(projects.id, projectId));

    return NextResponse.json({ ok: true, domain: normalized, apex, wasApex, status: dbStatus });
  } catch (error) {
    console.error('Custom domain add error:', error);
    return NextResponse.json(
      { error: `Failed to add custom domain: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET — Return current domain state, polling CF if status is pending
// ─────────────────────────────────────────────────────────────────────────────
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id: projectId } = await params;
    const project = await getProjectWithAuth(userId, projectId);
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

    const domain = project.customDomain;
    const status = project.customDomainStatus as 'pending' | 'active' | 'error' | null;

    if (!domain) {
      return NextResponse.json({ domain: null, status: null, apex: null });
    }

    // Derive apex for redirect instructions
    const apex = domain.startsWith('www.') ? domain.slice(4) : null;

    // If pending, check CF for the latest status
    if (status === 'pending' && project.cloudflareProjectName) {
      try {
        const cf = getCfConfig();
        const statusRes = await cfFetch<{ name: string; status: string }>(
          `/accounts/${cf.accountId}/pages/projects/${project.cloudflareProjectName}/domains/${encodeURIComponent(domain)}`,
          cf.apiToken
        );

        if (statusRes.success && statusRes.result) {
          const newStatus = mapCfStatus(statusRes.result.status);
          if (newStatus !== status) {
            const db = getDb();
            await db
              .update(projects)
              .set({ customDomainStatus: newStatus, updatedAt: new Date() })
              .where(eq(projects.id, projectId));
            return NextResponse.json({ domain, status: newStatus, apex });
          }
        }
      } catch {
        // Non-fatal: return current DB status
      }
    }

    return NextResponse.json({ domain, status, apex });
  } catch (error) {
    console.error('Custom domain status error:', error);
    return NextResponse.json({ error: 'Failed to check domain status' }, { status: 500 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE — Remove custom domain
// ─────────────────────────────────────────────────────────────────────────────
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id: projectId } = await params;
    const project = await getProjectWithAuth(userId, projectId);
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

    if (!project.customDomain) {
      return NextResponse.json({ error: 'No custom domain is configured for this project.' }, { status: 400 });
    }

    // Remove from Cloudflare (non-fatal if it fails — still clean up DB)
    if (project.cloudflareProjectName) {
      try {
        const cf = getCfConfig();
        await cfFetch(
          `/accounts/${cf.accountId}/pages/projects/${project.cloudflareProjectName}/domains/${encodeURIComponent(project.customDomain)}`,
          cf.apiToken,
          { method: 'DELETE' }
        );
      } catch (err) {
        console.warn('CF domain delete error (non-fatal):', err);
      }
    }

    const db = getDb();
    await db
      .update(projects)
      .set({ customDomain: null, customDomainStatus: null, updatedAt: new Date() })
      .where(eq(projects.id, projectId));

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Custom domain delete error:', error);
    return NextResponse.json(
      { error: `Failed to remove custom domain: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}
