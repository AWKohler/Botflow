/**
 * Shared per-turn request helpers for the in-sandbox agent routes
 * (/api/agent/claude-code and /api/agent/opencode).
 *
 * These were extracted VERBATIM from the Claude Code route so the two routes
 * can't drift on the contracts that must stay identical:
 *   - the 412 `{fallback: true}` response the client AgentPanel keys on to
 *     transparently retry against /api/agent,
 *   - current-turn text/image extraction (last-message-only semantics),
 *   - the image fetch caps,
 *   - the prior-conversation preamble format used after backend switches.
 */
import type { UIMessage } from "ai";

/** 412 + a structured body. The client AgentPanel inspects status === 412
 *  and retries against /api/agent. */
export function fallbackResponse(reason: string): Response {
  return new Response(JSON.stringify({ fallback: true, reason }), {
    status: 412,
    headers: { "Content-Type": "application/json" },
  });
}

export function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Pull the CURRENT turn's user text — from the LAST message only. The route
 * guarantees the last message is the user's new message (replay guard), so the
 * current prompt always lives there. Scanning backward (as an earlier version
 * did) is wrong once a turn can be image-only: an image-only message has no
 * text, and a backward scan would replay the PREVIOUS turn's text as if it were
 * a brand-new prompt. Prior turns are carried separately by the preamble.
 */
export function extractCurrentUserText(messages: UIMessage[]): string {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return "";
  const texts: string[] = [];
  for (const p of last.parts ?? []) {
    if (p.type === "text" && typeof p.text === "string") texts.push(p.text);
  }
  return texts.join("\n");
}

/**
 * Id of the CURRENT turn's user message (the last message — same replay-guard
 * guarantee as above). Stored in the turn record so recovery can match a
 * registry record to the exact user message that spawned it — timestamps
 * can't establish turn identity (clock skew, quick back-to-back turns).
 */
export function extractCurrentUserMessageId(messages: UIMessage[]): string | null {
  const last = messages[messages.length - 1];
  return last && last.role === "user" && typeof last.id === "string" ? last.id : null;
}

/* ------------------------------- images -------------------------------- */

/** A base64-encoded image, ready to embed as a provider image block. */
export interface PromptImage {
  media_type: string;
  data: string;
}

// Media types the model providers accept for image blocks. The uploader only
// ever produces jpeg/png/webp, but gif is kept since the APIs support it.
const SUPPORTED_IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
// Per-image byte ceiling — matches the uploader's 5MB cap and stays under the
// provider per-image limits. Oversized fetches are skipped, not truncated.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// Hard cap on images per turn (mirrors the client's MAX_IMAGES) so a crafted
// request can't make us fetch an unbounded number of remote URLs.
const MAX_PROMPT_IMAGES = 10;

/** Collect image file-parts from the current (last) user message — the remote
 *  URLs plus declared media types. Fetching happens separately. */
export function extractCurrentUserImageParts(
  messages: UIMessage[],
): Array<{ url: string; mediaType: string }> {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return [];
  const out: Array<{ url: string; mediaType: string }> = [];
  for (const p of last.parts ?? []) {
    if (p.type !== "file") continue;
    const fp = p as { type: "file"; url?: unknown; mediaType?: unknown };
    if (typeof fp.url !== "string") continue;
    const mediaType = typeof fp.mediaType === "string" ? fp.mediaType : "";
    if (!mediaType.startsWith("image/")) continue; // ignore non-image files
    out.push({ url: fp.url, mediaType });
  }
  return out;
}

/**
 * Fetch each uploaded image and base64-encode it so the bridge can embed it as
 * a provider image content block. We resolve the bytes server-side (rather
 * than handing the sandbox a URL) so the payload is self-contained and doesn't
 * depend on the sandbox reaching the upload CDN. Individual failures are
 * skipped — one broken image shouldn't sink the whole turn.
 */
export async function fetchPromptImages(
  parts: Array<{ url: string; mediaType: string }>,
): Promise<PromptImage[]> {
  const limited = parts.slice(0, MAX_PROMPT_IMAGES);
  const settled = await Promise.all(
    limited.map(async ({ url, mediaType }): Promise<PromptImage | null> => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) return null;
        const bytes = Buffer.from(await res.arrayBuffer());
        if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return null;
        // Prefer the response's content-type when it's a supported image type;
        // otherwise fall back to the part's declared mediaType, then jpeg.
        const responseType = (res.headers.get("content-type") ?? "")
          .split(";")[0]
          .trim()
          .toLowerCase();
        const media_type = SUPPORTED_IMAGE_MEDIA_TYPES.has(responseType)
          ? responseType
          : SUPPORTED_IMAGE_MEDIA_TYPES.has(mediaType)
            ? mediaType
            : "image/jpeg";
        return { media_type, data: bytes.toString("base64") };
      } catch {
        return null; // timeout / network error / abort — skip this image.
      }
    }),
  );
  return settled.filter((img): img is PromptImage => img !== null);
}

/**
 * Build a text preamble summarizing prior conversation turns so a fresh
 * in-sandbox agent session has the context it needs to pick up coherently mid-
 * conversation (e.g., after the user switched backends).
 *
 * We include only user/assistant TEXT — no foreign tool_use blocks (the agent
 * would have no way to interpret them) and no thinking/reasoning parts. The
 * model can reconstruct anything else by reading the current filesystem.
 *
 * Returns null when there's no prior content worth preambling (just the
 * current user message, or empty history).
 */
export function buildPriorConversationPreamble(messages: UIMessage[]): string | null {
  // The LAST message is the user's current prompt — we exclude it.
  if (messages.length <= 1) return null;
  const prior = messages.slice(0, -1);
  const lines: string[] = [];
  for (const m of prior) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const parts = m.parts ?? [];
    const texts: string[] = [];
    for (const p of parts) {
      if (p.type === "text" && typeof p.text === "string" && p.text.trim()) {
        texts.push(p.text);
      }
    }
    if (texts.length === 0) continue;
    const role = m.role === "user" ? "User" : "Assistant";
    // Keep each prior turn's text capped so a long history doesn't blow
    // the preamble budget. Generous cap — 4k chars per turn.
    let combined = texts.join("\n").trim();
    if (combined.length > 4000) {
      combined = combined.slice(0, 4000) + "…[truncated]";
    }
    lines.push(`${role}: ${combined}`);
  }
  if (lines.length === 0) return null;
  return lines.join("\n\n");
}
