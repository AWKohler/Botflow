import { SignIn } from "@/components/auth";
import { AuthShell } from "@/components/auth/auth-shell";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ redirect_url?: string }>;
}) {
  const resolvedParams = await searchParams;
  const redirectUrl = resolvedParams?.redirect_url ?? "/";

  return (
    <AuthShell>
      <SignIn forceRedirectUrl={redirectUrl} />
    </AuthShell>
  );
}
