/**
 * Client-safe tier primitives — the type, the model→tier requirement map,
 * and the rank comparison. Extracted from tier.ts (which imports
 * @/lib/auth/server and therefore can't be pulled into client bundles)
 * so the agent-backend derivation — shared verbatim by AgentPanel and the
 * server routes — can gate platform-mode models by tier. tier.ts re-exports
 * everything here, so existing server imports are untouched.
 */

export type Tier = 'free' | 'pro' | 'max';

/** Which tier is required to use a model on server-side keys */
export const MODEL_TIER_REQUIREMENT: Record<string, Tier> = {
  'fireworks-deepseek-v4p1-flash': 'free',
  'fireworks-kimi-k3p1-pro': 'pro',  // Pro+ for server key; free requires BYOK (Fireworks)
  'gpt-6.2-astra': 'max',            // Max-only on server key (Fable-class $8/$40); free/pro require BYOK/OAuth
  'gpt-6.2-sol': 'pro',              // Pro+ for server key; free requires BYOK/OAuth
  'gpt-6-luna': 'free',              // free — platform-served within the free credit allowance (default model)
  'claude-sonnet-5-5': 'pro',        // Pro+ for server key
  'claude-opus-5-5': 'pro',          // Pro+ for server key
  'claude-fable-5-2': 'max',         // Max-only on server key; free/pro require BYOK/OAuth
  'gemini-4-neon': 'pro',            // Pro+ for server key; free requires BYOK
  'grok-4.7': 'pro',                 // Pro+ for server key; free requires BYOK (xAI)
};

const TIER_RANK: Record<Tier, number> = { free: 0, pro: 1, max: 2 };

export function tierMeetsRequirement(userTier: Tier, required: Tier): boolean {
  return TIER_RANK[userTier] >= TIER_RANK[required];
}
