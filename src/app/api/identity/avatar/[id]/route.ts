import { getIdentityDb } from "@/lib/auth/database";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { rows } = await getIdentityDb().query(
    "SELECT data,digest FROM identity_avatar WHERE user_id=$1",
    [id],
  );
  if (!rows[0]) return new Response(null, { status: 404 });
  return new Response(new Uint8Array(rows[0].data), {
    headers: {
      "Content-Type": "image/webp",
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      ETag: rows[0].digest,
    },
  });
}
