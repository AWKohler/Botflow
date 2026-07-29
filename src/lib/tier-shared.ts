/**
 * Client-safe tier primitives — the type, the model→tier requirement map,
 * and the rank comparison. Extracted from tier.ts (which imports
 * @clerk/nextjs/server and therefore can't be pulled into client bundles)
 * so the agent-backend derivation — shared verbatim by AgentPanel and the
 * server routes — can gate platform-mode models by tier. tier.ts re-exports
 * everything here, so existing server imports are untouched.
 */

export type Tier = 'free' | 'pro' | 'max';

/** Which tier is required to use a model on server-side keys */
export const MODEL_TIER_REQUIREMENT: Record<string, Tier> = {
  'fireworks-minimax-m3': 'free',
  'fireworks-kimi-k2p7': 'free',
  'fireworks-kimi-k3': 'pro',        // Pro+ for server key ($3/$15 — Terra-class pricing); free requires BYOK (Fireworks)
  'gpt-5.6-sol': 'pro',              // Pro+ for server key; free requires BYOK/OAuth
  'gpt-5.6-terra': 'pro',            // Pro+ for server key
  'gpt-5.6-luna': 'free',            // free — platform-served within the free credit allowance (default model)
  'gpt-5.5': 'pro',                  // Pro+ for server key
  'claude-sonnet-5': 'pro',          // Pro+ for server key
  'claude-opus-5': 'pro',            // Pro+ for server key
  'claude-fable-5': 'max',           // Max-only on server key; free/pro require BYOK/OAuth
  'gemini-3.1-pro-preview': 'pro',   // Pro+ for server key; free requires BYOK
  'grok-4.5': 'pro',                 // Pro+ for server key; free requires BYOK (xAI)
};

const TIER_RANK: Record<Tier, number> = { free: 0, pro: 1, max: 2 };

export function tierMeetsRequirement(userTier: Tier, required: Tier): boolean {
  return TIER_RANK[userTier] >= TIER_RANK[required];
}
