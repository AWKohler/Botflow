/**
 * Projects in the user's OWN Convex account ("bring your own Convex").
 *
 * Botflow creates one Convex project per Botflow project in the team the user
 * connected (see /api/convex/provision and /start). It never removes one on
 * its own: the data belongs to the user. Deleting happens only when the user
 * asks for it while deleting the Botflow project.
 *
 * Convex Management API (team access token):
 *   GET  /v1/token_details                 → { type, teamId }
 *   GET  /v1/teams/{teamId}/list_projects  → [{ id, slug, name, ... }]
 *   POST /v1/projects/{id}/delete
 * Botflow stores the project's slug, so deleting means finding its numeric id
 * in the token's team first. That lookup doubles as a safety check: a project
 * that is not in the connected team is never touched.
 */

const CONVEX_API = 'https://api.convex.dev/v1';
const TIMEOUT_MS = 10_000;

export type DeleteUserConvexProjectResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'not-connected' | 'rejected' | 'not-found' | 'failed';
      message: string;
    };

/** Team slug from the stored credentials or the token ("team:<slug>|<jwt>"). */
export function convexTeamSlug(creds: { convexTeamId?: string | null; convexOAuthAccessToken?: string | null }) {
  return creds.convexTeamId ?? creds.convexOAuthAccessToken?.match(/^team:([^|]+)\|/)?.[1] ?? null;
}

/** Where the user can see (or delete by hand) a project in their Convex dashboard. */
export function convexDashboardUrl(teamSlug: string | null, projectSlug?: string | null) {
  if (!teamSlug) return 'https://dashboard.convex.dev';
  return projectSlug
    ? `https://dashboard.convex.dev/t/${encodeURIComponent(teamSlug)}/${encodeURIComponent(projectSlug)}`
    : `https://dashboard.convex.dev/t/${encodeURIComponent(teamSlug)}`;
}

async function convexFetch(token: string, path: string, init?: RequestInit) {
  return fetch(`${CONVEX_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: 'no-store',
  });
}

const REJECTED = (status: number) => status === 401 || status === 403;

export async function deleteUserConvexProject(opts: {
  token: string | null | undefined;
  projectSlug: string;
}): Promise<DeleteUserConvexProjectResult> {
  const { token, projectSlug } = opts;
  if (!token) {
    return {
      ok: false,
      reason: 'not-connected',
      message: 'Your Convex account is no longer connected to Botflow, so its Convex project was kept.',
    };
  }
  try {
    const details = await convexFetch(token, '/token_details');
    if (REJECTED(details.status)) {
      return {
        ok: false,
        reason: 'rejected',
        message: 'Convex did not accept Botflow\'s access to your account any more, so the Convex project was kept.',
      };
    }
    if (!details.ok) throw new Error(`token_details ${details.status}`);
    const { teamId } = (await details.json()) as { teamId?: number | string };
    if (teamId === undefined || teamId === null) throw new Error('token_details has no teamId');

    const listed = await convexFetch(token, `/teams/${encodeURIComponent(String(teamId))}/list_projects`);
    if (REJECTED(listed.status)) {
      return {
        ok: false,
        reason: 'rejected',
        message: 'Convex did not accept Botflow\'s access to your account any more, so the Convex project was kept.',
      };
    }
    if (!listed.ok) throw new Error(`list_projects ${listed.status}`);
    const projects = (await listed.json()) as Array<{ id: number | string; slug?: string }>;
    const match = Array.isArray(projects) ? projects.find((p) => p.slug === projectSlug) : undefined;
    if (!match) {
      return {
        ok: false,
        reason: 'not-found',
        message:
          `The Convex project "${projectSlug}" is not in the Convex team Botflow is connected to. ` +
          'It may already be deleted, or it lives in a team you connected before.',
      };
    }

    const deleted = await convexFetch(token, `/projects/${encodeURIComponent(String(match.id))}/delete`, {
      method: 'POST',
    });
    if (deleted.ok) return { ok: true };
    if (REJECTED(deleted.status)) {
      return {
        ok: false,
        reason: 'rejected',
        message: 'Convex refused to delete the project with Botflow\'s access, so it was kept.',
      };
    }
    throw new Error(`delete ${deleted.status}`);
  } catch (error) {
    console.error('[convex] deleting the user\'s Convex project failed:', error instanceof Error ? error.message : error);
    return {
      ok: false,
      reason: 'failed',
      message: 'Convex could not be reached to delete the project, so it was kept.',
    };
  }
}
