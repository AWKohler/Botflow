import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { previewCanonicalRedirect } from "./base-url";

const saved = { env: process.env.VERCEL_ENV, branch: process.env.VERCEL_BRANCH_URL };
afterEach(() => {
  process.env.VERCEL_ENV = saved.env;
  process.env.VERCEL_BRANCH_URL = saved.branch;
  if (saved.env === undefined) delete process.env.VERCEL_ENV;
  if (saved.branch === undefined) delete process.env.VERCEL_BRANCH_URL;
});

test("preview page loads on a deployment URL go to the branch URL", () => {
  process.env.VERCEL_ENV = "preview";
  process.env.VERCEL_BRANCH_URL = "app-git-feature-team.vercel.app";
  const to = previewCanonicalRedirect("GET", new URL("https://app-abc123-team.vercel.app/sign-in?redirect_url=%2Fworkspace"));
  assert.equal(to?.href, "https://app-git-feature-team.vercel.app/sign-in?redirect_url=%2Fworkspace");
});

test("no redirect on the branch URL, for non-GET requests, or outside previews", () => {
  process.env.VERCEL_ENV = "preview";
  process.env.VERCEL_BRANCH_URL = "app-git-feature-team.vercel.app";
  assert.equal(previewCanonicalRedirect("GET", new URL("https://app-git-feature-team.vercel.app/")), null);
  assert.equal(previewCanonicalRedirect("POST", new URL("https://app-abc123-team.vercel.app/api/auth/sign-in/social")), null);
  process.env.VERCEL_ENV = "production";
  assert.equal(previewCanonicalRedirect("GET", new URL("https://botflow.io/")), null);
});
