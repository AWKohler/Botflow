/**
 * Project HTML snapshots are written by whoever can edit a project — with
 * sharing, that is someone other than the person who later views them. They
 * are therefore untrusted HTML and must never execute in Botflow's origin.
 *
 * The PRIMARY control is the iframe sandbox below: no `allow-scripts`, no
 * `allow-same-origin`, so the document gets an opaque origin and runs no
 * script at all. A snapshot is a static DOM capture (styles + images), so it
 * needs neither. `stripActiveContent` is defense in depth for the stored
 * file and the server-side thumbnail renderer — it is NOT a sanitizer to be
 * trusted on its own.
 */

/** Sandbox for every iframe that renders snapshot HTML: everything denied. */
export const SNAPSHOT_IFRAME_SANDBOX = "";

/** Escape a string for use inside a double-quoted HTML attribute. */
export function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Remove the obvious script-bearing constructs from snapshot HTML before it
 * is stored or rendered server-side. Best-effort only (see file comment).
 */
export function stripActiveContent(html: string): string {
  return (
    html
      // Whole elements that execute, embed or redirect.
      .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
      .replace(/<(iframe|frame|object|embed|applet|portal)\b[\s\S]*?<\/\1\s*>/gi, "")
      // Self-closing / unclosed variants of the above, plus <base> and
      // <meta http-equiv> (refresh redirects, CSP overrides).
      .replace(/<\/?(script|iframe|frame|frameset|object|embed|applet|portal|base)\b[^>]*>/gi, "")
      .replace(/<meta\b[^>]*http-equiv[^>]*>/gi, "")
      // Inline event handlers: on*="…", on*='…', on*=bare.
      .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      // javascript:/vbscript: URLs in any attribute.
      .replace(/(\s(?:href|src|action|formaction|xlink:href|data)\s*=\s*["']?)\s*(?:javascript|vbscript):/gi, "$1about:blank#")
  );
}
