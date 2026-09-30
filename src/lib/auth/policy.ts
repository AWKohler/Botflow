export const DEFAULT_OWNER_IDS = [
  "user_3AXfS5TWRWoxbVQtZBs5NH3qbfw",
  "user_320xpm1gJPwkWAuyi0WMD3gpNKd",
];
export function ownerIds(): string[] {
  const configured = process.env.PANEL_ADMIN_USER_IDS;
  return configured === undefined
    ? DEFAULT_OWNER_IDS
    : configured
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
}
export function safeRedirect(
  value: string | null | undefined,
  fallback = "/",
): string {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\r\n]/.test(value)
  )
    return fallback;
  return value;
}
export function requireSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return Boolean(origin && origin === new URL(request.url).origin);
}
