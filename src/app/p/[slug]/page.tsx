import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { auth } from "@/lib/auth/server";
import { PublicWorkspaceGuard, type PublicProjectData } from "@/components/public-workspace";

export const dynamic = "force-dynamic";

async function fetchPublicProject(slug: string): Promise<PublicProjectData | null> {
  const h = await headers();
  const host = h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = process.env.NEXT_PUBLIC_APP_URL || `${proto}://${host}`;

  const res = await fetch(`${base}/api/public/projects/${encodeURIComponent(slug)}`, {
    cache: "no-store",
    headers: { cookie: h.get("cookie") ?? "" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to load public project: ${res.status}`);
  return (await res.json()) as PublicProjectData;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data = await fetchPublicProject(slug).catch(() => null);
  if (!data) return { title: "Project not found" };
  return {
    title: `${data.project.name} — by ${data.project.author.name}`,
    description: data.project.publicDescription ?? `A public project built on Botflow by ${data.project.author.name}.`,
    openGraph: {
      title: data.project.name,
      description: data.project.publicDescription ?? undefined,
      images: data.project.thumbnailUrl ? [data.project.thumbnailUrl] : undefined,
    },
  };
}

export default async function PublicProjectPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [data, { userId }] = await Promise.all([fetchPublicProject(slug), auth()]);
  if (!data) notFound();
  return <PublicWorkspaceGuard data={data} isSignedIn={Boolean(userId)} />;
}
