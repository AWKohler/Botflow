import { auth } from "@/lib/auth/server";
import { requireSameOrigin } from "@/lib/auth/policy";
import { getIdentityDb } from "@/lib/auth/database";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { NextResponse } from "next/server";
export async function POST(request: Request) {
  if (!requireSameOrigin(request))
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  const { userId, actor } = await auth();
  if (!userId || actor)
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  if (Number(request.headers.get("content-length") || 0) > 4 * 1024 * 1024)
    return NextResponse.json({ error: "Image too large" }, { status: 413 });
  const form = await request.formData();
  const file = form.get("image");
  if (!(file instanceof File) || file.size > 3 * 1024 * 1024)
    return NextResponse.json(
      { error: "Choose an image under 3 MB" },
      { status: 400 },
    );
  try {
    const data = await sharp(Buffer.from(await file.arrayBuffer()), {
      limitInputPixels: 16000000,
    })
      .rotate()
      .resize(256, 256, { fit: "cover" })
      .webp({ quality: 85 })
      .toBuffer();
    const digest = createHash("sha256").update(data).digest("hex");
    const image = `/api/identity/avatar/${userId}?v=${digest.slice(0, 12)}`;
    const client = await getIdentityDb().connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO identity_avatar(user_id,data,digest)VALUES($1,$2,$3)ON CONFLICT(user_id)DO UPDATE SET data=$2,digest=$3,updated_at=now()",
        [userId, data, digest],
      );
      await client.query(
        'UPDATE identity_user SET image=$2,"updatedAt"=now() WHERE id=$1',
        [userId, image],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    return NextResponse.json({ image });
  } catch {
    return NextResponse.json(
      { error: "The image could not be processed" },
      { status: 400 },
    );
  }
}
