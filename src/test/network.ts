import { setupServer } from 'msw/node';

/**
 * Network guard for every test. Any fetch without a matching handler fails
 * the request AND is recorded, so a test also fails if the code under test
 * swallowed the error. Add handlers per test:
 *
 *   server.use(http.post('https://api.stripe.com/v1/products', () => HttpResponse.json({...})))
 */
export const server = setupServer();

const unhandledRequests: string[] = [];

/** Drain the recorded unmocked requests (setup.ts fails the test on any). */
export function takeUnhandledRequests(): string[] {
  return unhandledRequests.splice(0);
}

export function startNetworkGuard() {
  server.events.on('request:unhandled', ({ request }) => {
    unhandledRequests.push(`${request.method} ${request.url}`);
  });
  server.listen({ onUnhandledFrame: 'error' });
}
