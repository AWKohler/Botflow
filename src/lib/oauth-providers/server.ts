/**
 * Server-only OAuth provider logic: maps the credential fields collected in the
 * modal to the env vars Convex Auth reads, deriving values where needed
 * (Microsoft issuer from tenant/audience, Apple client-secret JWT from a .p8).
 *
 * Imports node:crypto (via asc-jwt) — never import this from client code; the
 * isomorphic metadata lives in ./registry.ts.
 */
import { signEs256Jwt } from "@/lib/asc-jwt";
import { getOAuthProvider } from "./registry";

/** Apple caps the client secret at 6 months (15777000s). Stay safely under it. */
const APPLE_SECRET_TTL_SECONDS = 180 * 24 * 60 * 60; // ~6 months

export interface OAuthApplyResult {
  /** Env vars to set on the Convex deployment. */
  env: Record<string, string>;
  /** Inputs to persist (Apple secret rotation). Plaintext — the caller encrypts. */
  persist?: {
    appleTeamId: string;
    appleKeyId: string;
    appleServicesId: string;
    applePrivateKeyP8: string;
    secretExpiresAt: number;
  };
}

function req(fields: Record<string, string>, keys: string[]): void {
  for (const k of keys) {
    if (!fields[k] || !String(fields[k]).trim()) {
      throw new Error(`Missing required field: ${k}`);
    }
  }
}

/** Build the Microsoft Entra issuer URL from the chosen audience + tenant. */
export function microsoftIssuer(audience: string, tenantId?: string): string {
  const segment = audience === "single" ? (tenantId ?? "").trim() : audience;
  if (!segment) {
    throw new Error("A Directory (tenant) ID is required for single-tenant Microsoft sign-in.");
  }
  return `https://login.microsoftonline.com/${segment}/v2.0`;
}

/** Sign the Sign in with Apple client secret (ES256 JWT) from the user's .p8. */
export function signAppleClientSecret(opts: {
  teamId: string;
  keyId: string;
  servicesId: string;
  p8: string;
}): { secret: string; expiresAt: number } {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + APPLE_SECRET_TTL_SECONDS;
  const secret = signEs256Jwt({
    p8: opts.p8,
    keyId: opts.keyId,
    payload: {
      iss: opts.teamId,
      iat: now,
      exp: expiresAt,
      aud: "https://appleid.apple.com",
      sub: opts.servicesId,
    },
  });
  return { secret, expiresAt };
}

/**
 * Map collected credential fields → Convex Auth env vars (+ any inputs to
 * persist). Throws a clear Error on missing/invalid fields or unknown provider.
 */
export function buildOAuthEnvVars(
  provider: string,
  fields: Record<string, string>,
): OAuthApplyResult {
  const def = getOAuthProvider(provider);
  if (!def) {
    throw new Error(`Unknown OAuth provider: ${provider}`);
  }

  req(fields, def.fields.filter((field) => field.required).map((field) => field.key));
  for (const field of def.fields) {
    const value = fields[field.key]?.trim();
    if (!value || !field.validation) continue;
    if (field.validation.maxLength && value.length > field.validation.maxLength) {
      throw new Error(field.validation.message);
    }
    const pattern = new RegExp(`^(?:${field.validation.pattern})$`);
    if (!pattern.test(value)) throw new Error(field.validation.message);
  }

  switch (provider) {
    case "google":
      req(fields, ["clientId", "clientSecret"]);
      return {
        env: {
          AUTH_GOOGLE_ID: fields.clientId.trim(),
          AUTH_GOOGLE_SECRET: fields.clientSecret.trim(),
        },
      };

    case "github":
      req(fields, ["clientId", "clientSecret"]);
      return {
        env: {
          AUTH_GITHUB_ID: fields.clientId.trim(),
          AUTH_GITHUB_SECRET: fields.clientSecret.trim(),
        },
      };

    case "microsoft-entra-id": {
      req(fields, ["clientId", "clientSecret"]);
      const audience = (fields.audience || "single").trim();
      if (!["single", "organizations", "common"].includes(audience)) {
        throw new Error(`Invalid Microsoft audience: ${audience}`);
      }
      const issuer = microsoftIssuer(audience, fields.tenantId);
      return {
        env: {
          AUTH_MICROSOFT_ENTRA_ID_ID: fields.clientId.trim(),
          AUTH_MICROSOFT_ENTRA_ID_SECRET: fields.clientSecret.trim(),
          AUTH_MICROSOFT_ENTRA_ID_ISSUER: issuer,
        },
      };
    }

    case "apple": {
      const p8 = fields.privateKeyP8.trim();
      if (
        !p8.includes("-----BEGIN PRIVATE KEY-----") ||
        !p8.includes("-----END PRIVATE KEY-----")
      ) {
        throw new Error("The uploaded file is not a valid Apple .p8 private key.");
      }
      const { secret, expiresAt } = signAppleClientSecret({
        teamId: fields.teamId.trim(),
        keyId: fields.keyId.trim(),
        servicesId: fields.servicesId.trim(),
        p8,
      });
      return {
        env: {
          AUTH_APPLE_ID: fields.servicesId.trim(),
          AUTH_APPLE_SECRET: secret,
        },
        persist: {
          appleTeamId: fields.teamId.trim(),
          appleKeyId: fields.keyId.trim(),
          appleServicesId: fields.servicesId.trim(),
          applePrivateKeyP8: p8,
          secretExpiresAt: expiresAt,
        },
      };
    }

    default:
      throw new Error(`Unsupported OAuth provider: ${provider}`);
  }
}
