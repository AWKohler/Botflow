import { NextResponse } from "next/server";
import { auth } from "@/lib/auth/server";
import { getIdentityUser } from "@/lib/auth/directory";
export const dynamic = "force-dynamic";
export async function GET() {
  const { userId, actor } = await auth();
  if (!userId) return NextResponse.json({ user: null }, { status: 401 });
  const user = await getIdentityUser(userId);
  const {
    privateMetadata: _private,
    unsafeMetadata: _unsafe,
    ...profile
  } = user;
  void _private;
  void _unsafe;
  return NextResponse.json(
    { user: profile, actor },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
