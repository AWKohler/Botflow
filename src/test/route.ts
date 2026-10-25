import { NextRequest } from 'next/server';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

type DefaultParams = Record<string, string | string[]>;

/** Any App Router handler; `P` is its dynamic-segment params shape. */
export type RouteHandler<P = DefaultParams> = (
  req: NextRequest,
  ctx: { params: Promise<P> },
) => Response | Promise<Response>;

export type CallRouteOptions<P = DefaultParams> = {
  method?: HttpMethod;
  /** Path for the request URL, e.g. `/api/projects/123`. */
  path?: string;
  params?: P;
  /** Objects are sent as JSON; strings/Buffers raw. */
  body?: unknown;
  headers?: Record<string, string>;
  search?: Record<string, string>;
};

/**
 * Invoke a Next.js App Router handler directly — no server, no build.
 *
 *   const res = await callRoute(POST, { path: '/api/projects', body: { name: 'x' } });
 */
export async function callRoute<P = DefaultParams>(
  handler: RouteHandler<P>,
  opts: CallRouteOptions<P> = {},
): Promise<Response> {
  const method = opts.method ?? 'GET';
  const url = new URL(opts.path ?? '/api/test', 'http://localhost:3000');
  for (const [k, v] of Object.entries(opts.search ?? {})) url.searchParams.set(k, v);

  const headers = new Headers(opts.headers);
  let body: BodyInit | undefined;
  if (opts.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    if (typeof opts.body === 'string' || opts.body instanceof Uint8Array) {
      body = opts.body as BodyInit;
    } else {
      body = JSON.stringify(opts.body);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    }
  }

  const req = new NextRequest(url, { method, headers, body });
  return handler(req, { params: Promise.resolve((opts.params ?? {}) as P) });
}

export async function readJson<T = Record<string, unknown>>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON (status ${res.status}), got: ${text.slice(0, 300)}`);
  }
}
