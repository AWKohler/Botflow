/**
 * In-memory stand-in for the Upstash client (`@/lib/redis`), installed for
 * every test by src/test/setup.ts.
 *
 * Mirrors Upstash's automatic (de)serialization: values are stored as JSON
 * text and parsed on read, so `set(k, {a:1})` → `get(k)` returns an object and
 * numeric strings come back as numbers. TTLs use Date.now(), so
 * vi.useFakeTimers() + vi.advanceTimersByTime() expires keys.
 *
 * eval/evalsha are deliberately unsupported: @upstash/ratelimit relies on
 * them, so the limiter takes its documented fail-open path under test.
 */

type Entry = { value: string | string[]; expiresAt: number | null };

type SetOpts = {
  ex?: number;
  px?: number;
  nx?: boolean;
  xx?: boolean;
  get?: boolean;
  keepTtl?: boolean;
};

function serialize(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function deserialize(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

export class FakeRedis {
  private store = new Map<string, Entry>();

  reset() {
    this.store.clear();
  }

  /** Raw view for assertions: key → deserialized value (expired keys dropped). */
  dump(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const k of [...this.store.keys()]) {
      const e = this.live(k);
      if (!e) continue;
      out[k] = Array.isArray(e.value) ? e.value.map(deserialize) : deserialize(e.value);
    }
    return out;
  }

  private live(key: string): Entry | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== null && e.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return e;
  }

  private scalar(key: string): string | undefined {
    const e = this.live(key);
    if (!e) return undefined;
    if (Array.isArray(e.value)) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
    return e.value;
  }

  private list(key: string): string[] {
    const e = this.live(key);
    if (!e) return [];
    if (!Array.isArray(e.value)) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
    return e.value;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const v = this.scalar(key);
    return v === undefined ? null : (deserialize(v) as T);
  }

  async mget<T = unknown>(...keys: (string | string[])[]): Promise<(T | null)[]> {
    return Promise.all(keys.flat().map((k) => this.get<T>(k)));
  }

  async set(key: string, value: unknown, opts: SetOpts = {}): Promise<unknown> {
    const prev = this.live(key);
    if (opts.nx && prev) return null;
    if (opts.xx && !prev) return null;
    let expiresAt: number | null = null;
    if (opts.ex !== undefined) expiresAt = Date.now() + opts.ex * 1000;
    else if (opts.px !== undefined) expiresAt = Date.now() + opts.px;
    else if (opts.keepTtl && prev) expiresAt = prev.expiresAt;
    this.store.set(key, { value: serialize(value), expiresAt });
    if (opts.get) return prev && !Array.isArray(prev.value) ? deserialize(prev.value) : null;
    return 'OK';
  }

  async setex(key: string, seconds: number, value: unknown) {
    return this.set(key, value, { ex: seconds });
  }

  async setnx(key: string, value: unknown) {
    return (await this.set(key, value, { nx: true })) === 'OK' ? 1 : 0;
  }

  async getdel<T = unknown>(key: string): Promise<T | null> {
    const v = await this.get<T>(key);
    this.store.delete(key);
    return v;
  }

  async del(...keys: (string | string[])[]) {
    let n = 0;
    for (const k of keys.flat()) if (this.live(k) && this.store.delete(k)) n++;
    return n;
  }

  async exists(...keys: (string | string[])[]) {
    return keys.flat().filter((k) => this.live(k)).length;
  }

  async incrby(key: string, by: number) {
    const cur = this.scalar(key);
    const n = cur === undefined ? 0 : Number(deserialize(cur));
    if (!Number.isFinite(n)) throw new Error('ERR value is not an integer or out of range');
    const next = n + by;
    const e = this.live(key);
    this.store.set(key, { value: String(next), expiresAt: e?.expiresAt ?? null });
    return next;
  }

  async incr(key: string) {
    return this.incrby(key, 1);
  }

  async decrby(key: string, by: number) {
    return this.incrby(key, -by);
  }

  async decr(key: string) {
    return this.incrby(key, -1);
  }

  async expire(key: string, seconds: number) {
    const e = this.live(key);
    if (!e) return 0;
    e.expiresAt = Date.now() + seconds * 1000;
    return 1;
  }

  async pexpire(key: string, ms: number) {
    const e = this.live(key);
    if (!e) return 0;
    e.expiresAt = Date.now() + ms;
    return 1;
  }

  async ttl(key: string) {
    const e = this.live(key);
    if (!e) return -2;
    if (e.expiresAt === null) return -1;
    return Math.ceil((e.expiresAt - Date.now()) / 1000);
  }

  async keys(pattern: string) {
    const re = globToRegExp(pattern);
    return [...this.store.keys()].filter((k) => this.live(k) && re.test(k));
  }

  async lpush(key: string, ...values: unknown[]) {
    const list = this.list(key);
    const next = [...values.map(serialize).reverse(), ...list];
    this.store.set(key, { value: next, expiresAt: this.live(key)?.expiresAt ?? null });
    return next.length;
  }

  async rpush(key: string, ...values: unknown[]) {
    const list = this.list(key);
    const next = [...list, ...values.map(serialize)];
    this.store.set(key, { value: next, expiresAt: this.live(key)?.expiresAt ?? null });
    return next.length;
  }

  private range(len: number, start: number, stop: number): [number, number] {
    const s = start < 0 ? Math.max(len + start, 0) : start;
    const e = stop < 0 ? len + stop : Math.min(stop, len - 1);
    return [s, e];
  }

  async lrange<T = unknown>(key: string, start: number, stop: number): Promise<T[]> {
    const list = this.list(key);
    const [s, e] = this.range(list.length, start, stop);
    return list.slice(s, e + 1).map((v) => deserialize(v) as T);
  }

  async ltrim(key: string, start: number, stop: number) {
    const e = this.live(key);
    if (!e) return 'OK';
    const list = this.list(key);
    const [s, end] = this.range(list.length, start, stop);
    e.value = list.slice(s, end + 1);
    return 'OK';
  }

  async llen(key: string) {
    return this.list(key).length;
  }

  async eval(): Promise<never> {
    throw new Error('FakeRedis: eval is not supported (rate limiter fails open under test)');
  }

  async evalsha(): Promise<never> {
    throw new Error('FakeRedis: evalsha is not supported (rate limiter fails open under test)');
  }
}

export const fakeRedis = new FakeRedis();
