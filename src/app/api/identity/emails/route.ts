import { getAuth } from "@/lib/auth/config";
import { handleIdentityEmails } from "@/lib/auth/manage-emails";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (request: Request) =>
  handleIdentityEmails(request, getAuth());
export const POST = GET;
