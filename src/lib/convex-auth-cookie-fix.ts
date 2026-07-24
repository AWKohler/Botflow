/**
 * Mobile-Safari OAuth cookie fix for @convex-dev/auth.
 *
 * @convex-dev/auth (≤0.0.94) sets its OAuth PKCE/state/nonce cookies with
 * `sameSite: "none"; secure; partitioned` (CHIPS). Mobile Safari/WebKit drops
 * partitioned cookies when the top-level origin flips across the OAuth
 * round-trip (convex.site → provider → convex.site), so the callback sends a
 * decoy code_verifier and the provider rejects the token exchange with
 * invalid_grant — sign-in works on desktop and fails on phones, for EVERY
 * OAuth provider. See https://github.com/get-convex/convex-auth/pull/322.
 *
 * The fix is to strip `partitioned: true` from the package's cookie options
 * (keeping sameSite:"none" so Apple's form_post callback still gets cookies).
 * It has to be applied to node_modules AT BUNDLE TIME — including inside the
 * platform's Convex deploy job, which copies only package.json + lockfile +
 * convex/ into a scratch dir and runs `pnpm install` there. A postinstall
 * script referencing a repo file would not survive that copy, so the fix
 * ships as a fully self-contained `node -e` one-liner in package.json —
 * battle-tested in production (it is exactly the shape that fixed the
 * original mobile-auth incident).
 *
 * The one-liner is idempotent (no-ops once patched or if the package is
 * absent/fixed upstream) and patches every installed instance: the direct
 * node_modules path plus pnpm's hashed .pnpm layouts, deduped through
 * realpath so a symlinked instance isn't double-processed.
 */

// The embedded program. Single-quoted strings ONLY (the shell wrapper uses
// double quotes); `\\s` renders as the regex escape \s in the emitted code.
// Distinct terminal messages so "nothing happened" can never read as success:
//   skip    — package not installed yet (expected before deps are added)
//   patched — the fix was applied to N files
//   ok      — nothing to patch (already applied, or fixed upstream)
//   WARNING — the package is installed but the fix could not land (cookies.js
//             moved, or partitioned survived the rewrite) — the mobile-Safari
//             bug is live; the message names what to patch manually
const FIX_AUTH_COOKIES_JS =
  "const fs=require('fs'),p=require('path'),r=process.cwd();" +
  "const t=[];let pkgSeen=false;" +
  "const pkgDir=p.join(r,'node_modules/@convex-dev/auth');" +
  "if(fs.existsSync(pkgDir))pkgSeen=true;" +
  "const d=p.join(pkgDir,'dist/server/cookies.js');" +
  "if(fs.existsSync(d))t.push(d);" +
  "const pn=p.join(r,'node_modules/.pnpm');" +
  "if(fs.existsSync(pn))for(const e of fs.readdirSync(pn)){" +
  "if(e.startsWith('@convex-dev+auth@')){pkgSeen=true;" +
  "const c=p.join(pn,e,'node_modules/@convex-dev/auth/dist/server/cookies.js');" +
  "if(fs.existsSync(c))t.push(c);}}" +
  "const files=[...new Set(t.map(x=>{try{return fs.realpathSync(x);}catch{return x;}}))];" +
  "let n=0;" +
  "for(const f of files){" +
  "const s=fs.readFileSync(f,'utf8');" +
  "if(!/partitioned:\\s*true/.test(s))continue;" +
  "fs.writeFileSync(f,s.replace(/\\s*partitioned:\\s*true,?/g,''));n++;}" +
  "const bad=files.filter(f=>/partitioned:\\s*true/.test(fs.readFileSync(f,'utf8')));" +
  "if(!pkgSeen)console.log('[fix-auth-cookies] skip: @convex-dev/auth not installed yet');" +
  "else if(!files.length)console.log('[fix-auth-cookies] WARNING: @convex-dev/auth is installed but dist/server/cookies.js was not found - the package layout changed; locate its OAuth cookie options and remove partitioned:true manually or mobile Safari OAuth will fail');" +
  "else if(bad.length)console.log('[fix-auth-cookies] WARNING: partitioned still present after patching in: '+bad.join(', ')+' - remove partitioned:true there manually or mobile Safari OAuth will fail');" +
  "else if(n)console.log('[fix-auth-cookies] patched '+n+' file(s)');" +
  "else console.log('[fix-auth-cookies] ok (already patched)')";

/** The full shell command for package.json's postinstall script. */
export const FIX_AUTH_COOKIES_POSTINSTALL = `node -e "${FIX_AUTH_COOKIES_JS}"`;

/**
 * The exact line to add inside package.json's "scripts" object (JSON-escaped
 * and ready to paste — the agent must copy it verbatim).
 */
export function fixAuthCookiesPackageJsonLine(): string {
  return `"postinstall": ${JSON.stringify(FIX_AUTH_COOKIES_POSTINSTALL)}`;
}

/**
 * Agent-facing guidance block. Shown by setup_auth (so every new auth project
 * gets the fix from day one) and echoed from the OAuth-provider success
 * context (so projects that predate the scaffold pick it up the first time
 * they add a provider).
 */
export function buildCookieFixGuidance(): string {
  return `MOBILE SAFARI OAUTH COOKIE FIX (REQUIRED — do this once per project):

  @convex-dev/auth ships its OAuth cookies with \`partitioned: true\` (CHIPS).
  Mobile Safari drops those cookies across the OAuth redirect round-trip, so
  Google/Apple/GitHub sign-in fails on phones with "invalid_grant" /
  "server responded with an error in the response body" while desktop works.

  Add this entry to the "scripts" object of package.json EXACTLY as written
  (it is one long line — do not reformat, split, or re-quote it):

    ${fixAuthCookiesPackageJsonLine()}

  Then run \`pnpm install\` once and READ the "[fix-auth-cookies]" line it
  prints. Interpreting it:
    - "patched N file(s)" or "ok (already patched)" — the fix is in place.
    - "skip: not installed yet" — fine before @convex-dev/auth is added; if
      it still says this AFTER the auth packages are installed, something is
      wrong with the install itself.
    - "WARNING: …" — the fix could NOT land (package layout changed); the
      mobile-Safari bug is live. Follow the message: it names the file(s) to
      patch manually. Tell the user.
    - NO [fix-auth-cookies] line at all — the postinstall entry was
      mis-pasted; re-check package.json.
  The script is idempotent and self-contained; it also runs automatically
  inside every Convex deploy, which is what makes the fix reach the deployed
  auth code. If package.json already has a postinstall script, chain them
  with " && ". Do NOT remove this entry later.`;
}
