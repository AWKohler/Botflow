/**
 * OAuth provider registry — the single source of truth for which sign-in
 * providers a generated app can offer and the shape of each one's credentials.
 *
 * Isomorphic: safe to import from both the client (the credential modal renders
 * its fields from here) and the server (env-var mapping + agent guidance derive
 * from the same defs). Keep this file free of node-only imports (crypto, db) —
 * the server-only logic (secret signing, issuer derivation) lives in ./server.ts.
 */

export type OAuthFieldType = "text" | "password" | "file";

export interface OAuthProviderField {
  /** Key in the credential payload sent to oauth-provider-complete. */
  key: string;
  label: string;
  type: OAuthFieldType;
  placeholder?: string;
  help?: string;
  /**
   * Statically required. Conditionally-required fields (e.g. the Microsoft
   * tenant, only needed for single-tenant) are enforced in ./server.ts based on
   * the value of other fields.
   */
  required?: boolean;
  /** For file inputs — the accept attribute (e.g. ".p8"). */
  accept?: string;
  /** Lightweight client/server validation for text credentials. */
  validation?: {
    pattern: string;
    message: string;
    maxLength?: number;
  };
}

export interface OAuthConsoleLink {
  label: string;
  url: string;
}

export interface OAuthAudienceOption {
  value: string;
  label: string;
  description?: string;
  /** Whether choosing this audience requires the Tenant ID field. */
  requiresTenant?: boolean;
}

export interface OAuthProviderDef {
  /** Auth.js provider id — also the callback slug (/api/auth/callback/<id>). */
  id: string;
  displayName: string;
  /** One-line subtitle for the modal header. */
  blurb: string;
  /** Human name of the provider's developer console. */
  consoleName: string;
  /** Link to where the user creates the OAuth app. */
  consoleUrl: string;
  /** One-liner: where in the console to create credentials. */
  setupHint: string;
  /** Optional provider-specific checklist shown instead of setupHint alone. */
  setupSteps?: string[];
  /** Optional separate destinations when setup spans multiple console areas. */
  consoleLinks?: OAuthConsoleLink[];
  /** Fields the credential modal collects. */
  fields: OAuthProviderField[];
  /** Optional audience selector (Microsoft Entra). */
  audienceOptions?: OAuthAudienceOption[];
  /** Env vars this provider sets on the Convex deployment (for docs/guidance). */
  envVars: string[];
  /** Caveats surfaced in the modal and the agent guidance. */
  caveats: string[];
  /** Whether the platform persists the inputs at rest (Apple: secret rotation). */
  persists: boolean;
  /** How to import the Auth.js provider in the generated convex/auth.ts. */
  authImport: { symbol: string; from: string; default: boolean };
  /** Expression to add to the providers array (usually === authImport.symbol). */
  providerExpr: string;
  /**
   * Swift-specific providers-array expression, when it must differ from the
   * web one. Repeat sign-ins from the iOS in-app browser break when the
   * provider silently bounces straight back (an uninterrupted cross-site
   * redirect chain with no user gesture — WebKit drops the OAuth cookies and
   * the callback fails, landing on a dead end). Forcing an interaction
   * (prompt=select_account) makes every attempt behave like the first one.
   * Falls back to providerExpr when absent.
   */
  swiftProviderExpr?: string;
}

export const OAUTH_PROVIDERS: Record<string, OAuthProviderDef> = {
  google: {
    id: "google",
    displayName: "Google",
    blurb: "Enable “Sign in with Google”.",
    consoleName: "Google Cloud Console",
    consoleUrl: "https://console.cloud.google.com/apis/credentials",
    setupHint:
      "APIs & Services → Credentials → Create Credentials → OAuth client ID → Web application.",
    fields: [
      { key: "clientId", label: "Client ID", type: "text", required: true, placeholder: "123456789-abc….apps.googleusercontent.com" },
      { key: "clientSecret", label: "Client Secret", type: "password", required: true, placeholder: "GOCSPX-…" },
    ],
    envVars: ["AUTH_GOOGLE_ID", "AUTH_GOOGLE_SECRET"],
    caveats: [
      "Until you publish & verify the OAuth consent screen, Google limits sign-in to the test users you add in the console.",
    ],
    persists: false,
    authImport: { symbol: "Google", from: "@auth/core/providers/google", default: true },
    providerExpr: "Google",
    swiftProviderExpr:
      'Google({ authorization: { params: { prompt: "select_account" } } })',
  },
  github: {
    id: "github",
    displayName: "GitHub",
    blurb: "Enable “Sign in with GitHub”.",
    consoleName: "GitHub Developer Settings",
    consoleUrl: "https://github.com/settings/developers",
    setupHint:
      "Settings → Developer settings → OAuth Apps → New OAuth App (one app per project).",
    fields: [
      { key: "clientId", label: "Client ID", type: "text", required: true, placeholder: "Iv1.…" },
      { key: "clientSecret", label: "Client Secret", type: "password", required: true, placeholder: "client secret value" },
    ],
    envVars: ["AUTH_GITHUB_ID", "AUTH_GITHUB_SECRET"],
    caveats: [
      "A GitHub user's email may be private — the provider requests the user:email scope so it can still read their primary verified email.",
    ],
    persists: false,
    authImport: { symbol: "GitHub", from: "@auth/core/providers/github", default: true },
    providerExpr: "GitHub",
    swiftProviderExpr:
      'GitHub({ authorization: { params: { prompt: "select_account" } } })',
  },
  "microsoft-entra-id": {
    id: "microsoft-entra-id",
    displayName: "Microsoft",
    blurb: "Enable “Sign in with Microsoft” (Entra ID / Azure AD).",
    consoleName: "Azure Portal",
    consoleUrl:
      "https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
    setupHint:
      "Microsoft Entra ID → App registrations → New registration. Add a Web redirect URI, then create a client secret under Certificates & secrets.",
    fields: [
      { key: "clientId", label: "Application (client) ID", type: "text", required: true, placeholder: "00000000-0000-0000-0000-000000000000" },
      { key: "clientSecret", label: "Client secret value", type: "password", required: true, placeholder: "the secret VALUE (not the Secret ID)", help: "Copy the secret's Value column — the Secret ID will not work." },
      { key: "tenantId", label: "Directory (tenant) ID", type: "text", required: false, placeholder: "required for “My organization only”" },
    ],
    audienceOptions: [
      { value: "single", label: "My organization only", description: "Only accounts in your Entra tenant (most reliable).", requiresTenant: true },
      { value: "organizations", label: "Any organization", description: "Any work or school account." },
      { value: "common", label: "Any Microsoft account", description: "Work, school, or personal (Outlook, Xbox)." },
    ],
    envVars: ["AUTH_MICROSOFT_ENTRA_ID_ID", "AUTH_MICROSOFT_ENTRA_ID_SECRET", "AUTH_MICROSOFT_ENTRA_ID_ISSUER"],
    caveats: [
      "Paste the secret Value, not the Secret ID.",
      "Single-tenant is the most reliable; multi-tenant (“any organization / any account”) can hit issuer-validation issues.",
    ],
    persists: false,
    authImport: { symbol: "MicrosoftEntraID", from: "@auth/core/providers/microsoft-entra-id", default: true },
    providerExpr: "MicrosoftEntraID",
    swiftProviderExpr:
      'MicrosoftEntraID({ authorization: { params: { prompt: "select_account" } } })',
  },
  apple: {
    id: "apple",
    displayName: "Apple",
    blurb: "Enable “Sign in with Apple”.",
    consoleName: "Apple Developer",
    consoleUrl: "https://developer.apple.com/account/resources/identifiers/list/serviceId",
    setupHint:
      "Apple requires an App ID, a Services ID, and a private key for web sign-in.",
    setupSteps: [
      "Enable Sign in with Apple on a primary App ID (create one first if the project does not have one).",
      "Create a Services ID, enable Sign in with Apple, associate it with that primary App ID, and configure the domain and return URL shown below.",
      "Create a Key with Sign in with Apple enabled, associate it with the same primary App ID, and download the .p8 file. Apple lets you download it only once.",
    ],
    consoleLinks: [
      {
        label: "Open App IDs",
        url: "https://developer.apple.com/account/resources/identifiers/list/bundleId",
      },
      {
        label: "Open Services IDs",
        url: "https://developer.apple.com/account/resources/identifiers/list/serviceId",
      },
      {
        label: "Open Keys",
        url: "https://developer.apple.com/account/resources/authkeys/list",
      },
    ],
    fields: [
      {
        key: "servicesId",
        label: "Services ID",
        type: "text",
        required: true,
        placeholder: "com.yourapp.web",
        help: "Use the Identifier from Apple’s Services IDs page, not an App ID or bundle ID.",
        validation: {
          pattern: "[A-Za-z0-9][A-Za-z0-9.-]*",
          message: "Enter a valid Apple Services ID (for example, com.yourapp.web).",
          maxLength: 255,
        },
      },
      {
        key: "teamId",
        label: "Team ID",
        type: "text",
        required: true,
        placeholder: "ABCDE12345",
        help: "The 10-character Team ID shown in your Apple Developer membership details and account header.",
        validation: {
          pattern: "[A-Z0-9]{10}",
          message: "Team ID must be 10 uppercase letters or numbers.",
          maxLength: 10,
        },
      },
      {
        key: "keyId",
        label: "Key ID",
        type: "text",
        required: true,
        placeholder: "XYZ1234567",
        help: "The 10-character identifier shown for the Sign in with Apple key you created.",
        validation: {
          pattern: "[A-Z0-9]{10}",
          message: "Key ID must be 10 uppercase letters or numbers.",
          maxLength: 10,
        },
      },
      {
        key: "privateKeyP8",
        label: "Sign in with Apple key (.p8)",
        type: "file",
        required: true,
        accept: ".p8",
        help: "Upload the AuthKey_XXXXXXXXXX.p8 file. Botflow encrypts it at rest, never exposes it to the generated app or agent, and uses it only to rotate Apple’s client secret.",
      },
    ],
    envVars: ["AUTH_APPLE_ID", "AUTH_APPLE_SECRET"],
    caveats: [
      "Apple sends the user's name and email only on the FIRST sign-in — persist them then.",
      "Sign in with Apple cannot be tested on localhost; use a deployed preview (public HTTPS).",
      "Botflow signs the client secret from your encrypted .p8 and auto-rotates it before Apple's 6-month expiry.",
    ],
    persists: true,
    authImport: { symbol: "Apple", from: "@auth/core/providers/apple", default: true },
    // Auth.js 0.41.x maps Apple's missing avatar to `image: null`, while
    // Convex Auth's users table accepts only string | undefined. Override the
    // profile mapper so the absent image is omitted instead of written as null.
    providerExpr: `Apple({
        profile(profile) {
          const name = profile.user
            ? [profile.user.name.firstName, profile.user.name.lastName].filter(Boolean).join(" ")
            : profile.email;
          return { id: profile.sub, name, email: profile.email };
        },
      })`,
  },
};

export const OAUTH_PROVIDER_IDS = Object.keys(OAUTH_PROVIDERS);

export function getOAuthProvider(id: string): OAuthProviderDef | undefined {
  return OAUTH_PROVIDERS[id];
}

export function isSupportedOAuthProvider(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(OAUTH_PROVIDERS, id);
}

/** The stable callback URL to register with the provider. */
export function oauthCallbackUrl(convexSiteUrl: string, providerId: string): string {
  return `${convexSiteUrl}/api/auth/callback/${providerId}`;
}

/** Human-readable provider list for prose, e.g. "Google, GitHub, Microsoft, or Apple". */
export function oauthProviderNameList(): string {
  const names = OAUTH_PROVIDER_IDS.map((id) => OAUTH_PROVIDERS[id].displayName);
  if (names.length <= 1) return names.join("");
  if (names.length === 2) return `${names[0]} or ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`;
}

/** Pipe-separated provider ids, e.g. "google | github | microsoft-entra-id | apple". */
export function oauthProviderIdList(): string {
  return OAUTH_PROVIDER_IDS.join(" | ");
}
