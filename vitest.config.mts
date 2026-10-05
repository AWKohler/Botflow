import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Test runner config. Every test runs in-process against fakes — no Neon, no
 * Upstash, no Stripe, no Vercel Sandbox, no LLM, no network (msw fails any unmocked
 * request). See docs/testing/test-plan.md for layers and the backlog.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // `server-only` throws outside the react-server condition; tests run
      // server modules directly.
      'server-only': path.resolve(__dirname, 'src/test/empty-module.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['src/test/setup.ts'],
    globalSetup: ['src/test/global-setup.ts'],
    // Route modules pull in large dependency graphs on first import.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // `npm test` already scrubs the environment (scripts/test.mjs); this is the
    // backstop for running vitest directly from a shell with real creds loaded.
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: '',
      UPSTASH_REDIS_REST_URL: '',
      UPSTASH_REDIS_REST_TOKEN: '',
      // Test-only key (32 zero-ish bytes) so identity metadata encrypts/decrypts.
      IDENTITY_ENCRYPTION_KEY: Buffer.from('botflow-test-identity-key-32-byt').toString('base64'),
    },
  },
});
