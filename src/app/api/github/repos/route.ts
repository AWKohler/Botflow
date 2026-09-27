import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth/server';
import { getUserCredentials } from '@/lib/user-credentials';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const creds = await getUserCredentials(userId);

    if (!creds.githubAccessToken) {
      return NextResponse.json({ error: 'GitHub not connected' }, { status: 400 });
    }

    const { name, description, isPrivate } = await req.json() as {
      name: string;
      description?: string;
      isPrivate?: boolean;
    };

    if (!name) return NextResponse.json({ error: 'Repository name is required' }, { status: 400 });

    // Create repo on GitHub
    const createRes = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.githubAccessToken}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name,
        description: description ?? '',
        private: isPrivate ?? false,
        auto_init: true,
      }),
    });

    if (!createRes.ok) {
      const err = await createRes.json() as { message?: string };
      return NextResponse.json({ error: err.message ?? 'Failed to create repository' }, { status: createRes.status });
    }

    const repo = await createRes.json() as {
      full_name: string;
      html_url: string;
      default_branch: string;
      owner: { login: string };
      name: string;
    };

    // Fetch the HEAD commit SHA
    const branchRes = await fetch(
      `https://api.github.com/repos/${repo.full_name}/branches/${repo.default_branch}`,
      {
        headers: {
          Authorization: `Bearer ${creds.githubAccessToken}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );

    let headSha: string | null = null;
    if (branchRes.ok) {
      const branchData = await branchRes.json() as { commit?: { sha: string } };
      headSha = branchData.commit?.sha ?? null;
    }

    return NextResponse.json({
      owner: repo.owner.login,
      name: repo.name,
      fullName: repo.full_name,
      url: repo.html_url,
      defaultBranch: repo.default_branch,
      headSha,
    });
  } catch (e) {
    console.error('Create GitHub repo failed:', e);
    return NextResponse.json({ error: 'Failed to create repository' }, { status: 500 });
  }
}

// List user's repos for "connect existing repo"
export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const creds = await getUserCredentials(userId);

    if (!creds.githubAccessToken) {
      return NextResponse.json({ error: 'GitHub not connected' }, { status: 400 });
    }

    const res = await fetch('https://api.github.com/user/repos?sort=updated&per_page=50', {
      headers: {
        Authorization: `Bearer ${creds.githubAccessToken}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch repos' }, { status: res.status });

    const repos = await res.json() as Array<{
      full_name: string;
      name: string;
      html_url: string;
      default_branch: string;
      owner: { login: string };
      private: boolean;
    }>;

    return NextResponse.json(repos.map(r => ({
      owner: r.owner.login,
      name: r.name,
      fullName: r.full_name,
      url: r.html_url,
      defaultBranch: r.default_branch,
      isPrivate: r.private,
    })));
  } catch (e) {
    console.error('List GitHub repos failed:', e);
    return NextResponse.json({ error: 'Failed to list repositories' }, { status: 500 });
  }
}
