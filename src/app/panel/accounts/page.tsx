"use client";
import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth/client";
import { fieldClass, primaryClass } from "@/components/auth/sign-in";
interface Row {
  id: string;
  name: string;
  email: string;
  banned: boolean;
  plan: string | null;
  createdAt: string;
  emailVerified: boolean;
}
interface Details {
  user: {
    id: string;
    fullName: string;
    publicMetadata: Record<string, unknown>;
    unsafeMetadata: Record<string, unknown>;
  };
  privateFields: { key: string; configured: boolean }[];
  accounts: { id: string; providerId: string; accountId: string }[];
  sessions: {
    id: string;
    createdAt: string;
    expiresAt: string;
    ipAddress: string;
    userAgent: string;
  }[];
  audit: { action: string; created_at: string; details: unknown }[];
  isOwner: boolean;
}
export default function AccountsPage() {
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [users, setUsers] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<Row | null>(null);
  const selectedId = selected?.id;
  const [details, setDetails] = useState<Details | null>(null);
  const [metadata, setMetadata] = useState("");
  const [privatePatch, setPrivatePatch] = useState("{}");
  const [message, setMessage] = useState("");
  const [revealed, setRevealed] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const c = new AbortController();
    fetch(
      `/api/panel/identity?q=${encodeURIComponent(query)}&offset=${offset}`,
      { signal: c.signal },
    )
      .then((r) => r.json())
      .then((data) => {
        setUsers(data.users ?? []);
        setTotal(data.total ?? 0);
      })
      .catch(() => {});
    return () => c.abort();
  }, [query, offset]);
  useEffect(() => {
    setDetails(null);
    setRevealed({});
    setMessage("");
    setPrivatePatch("{}");
    if (!selectedId) return;
    const c = new AbortController();
    fetch(`/api/panel/identity/${selectedId}`, { signal: c.signal })
      .then((r) => r.json())
      .then((data) => {
        setDetails(data);
        setMetadata(JSON.stringify(data.user.publicMetadata, null, 2));
      })
      .catch(() => {});
    return () => c.abort();
  }, [selectedId]);
  async function action(
    fn: () => Promise<{ error?: { message?: string } | null }>,
    success = "Saved",
  ) {
    setBusy(true);
    setMessage("");
    try {
      const result = await fn();
      if (!result.error && selectedId) {
        const [detailResponse, listResponse] = await Promise.all([
          fetch(`/api/panel/identity/${selectedId}`),
          fetch(
            `/api/panel/identity?q=${encodeURIComponent(query)}&offset=${offset}`,
          ),
        ]);
        if (detailResponse.ok) setDetails(await detailResponse.json());
        if (listResponse.ok) {
          const list = await listResponse.json();
          setUsers(list.users);
          setTotal(list.total);
          const updated = list.users.find((row: Row) => row.id === selectedId);
          if (updated) setSelected(updated);
        }
      }
      setMessage(result.error?.message ?? success);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!selected) return;
    await action(async () => {
      const r = await fetch(`/api/panel/identity/${selected.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publicMetadata: JSON.parse(metadata),
          privateMetadata: JSON.parse(privatePatch),
        }),
      });
      const data = await r.json();
      if (r.ok) setPrivatePatch("{}");
      return r.ok ? {} : { error: { message: data.error } };
    });
  }
  return (
    <div className="text-fg">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Accounts</h1>
        <p className="mt-1 text-sm text-muted">
          {total} users · Profiles, metadata, connected accounts, and sessions
        </p>
      </div>
      <label className="block max-w-lg text-sm">
        Search users
        <input
          className={fieldClass}
          value={query}
          placeholder="Name, email, or user ID"
          onChange={(e) => {
            setQuery(e.target.value);
            setOffset(0);
          }}
        />
      </label>
      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="overflow-hidden rounded-xl border border-border">
          <div className="divide-y divide-border">
            {users.map((user) => (
              <button
                key={user.id}
                onClick={() => setSelected(user)}
                className={`flex w-full items-center justify-between gap-3 p-4 text-left hover:bg-elevated ${selected?.id === user.id ? "bg-elevated" : ""}`}
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{user.name}</p>
                  <p className="truncate text-sm text-muted">{user.email}</p>
                  <p className="mt-1 text-xs text-muted">{user.id}</p>
                </div>
                <span className="rounded-md border border-border px-2 py-1 text-xs">
                  {user.banned ? "Banned" : (user.plan ?? "free")}
                </span>
              </button>
            ))}
          </div>
          <div className="flex justify-between border-t border-border p-3 text-sm">
            <button
              disabled={!offset}
              onClick={() => setOffset(Math.max(0, offset - 50))}
            >
              Previous
            </button>
            <span>
              {Math.min(offset + 1, total)}–{Math.min(offset + 50, total)} of{" "}
              {total}
            </span>
            <button
              disabled={offset + 50 >= total}
              onClick={() => setOffset(offset + 50)}
            >
              Next
            </button>
          </div>
        </div>
        <div>
          {!details || !selected ? (
            <p className="p-8 text-sm text-muted">
              Select a user to manage their account.
            </p>
          ) : (
            <div className="space-y-6 rounded-xl border border-border p-6">
              <div>
                <h2 className="text-xl font-semibold">{selected.name}</h2>
                <p className="text-sm text-muted">{selected.email}</p>
              </div>
              <div className="flex flex-wrap gap-3 text-sm">
                <button
                  disabled={busy || details.isOwner}
                  className="rounded-lg border border-border px-3 py-2"
                  onClick={() =>
                    action(async () => {
                      const r = await authClient.admin.impersonateUser({
                        userId: selected.id,
                      });
                      if (!r.error) location.assign("/projects");
                      return r;
                    })
                  }
                >
                  Impersonate user
                </button>
                <button
                  disabled={busy || details.isOwner}
                  className="rounded-lg border border-border px-3 py-2"
                  onClick={() =>
                    action(() =>
                      selected.banned
                        ? authClient.admin.unbanUser({ userId: selected.id })
                        : authClient.admin.banUser({
                            userId: selected.id,
                            banReason: "Suspended by account owner",
                          }),
                    )
                  }
                >
                  {selected.banned ? "Unban user" : "Ban user"}
                </button>
                <button
                  disabled={busy}
                  className="rounded-lg border border-border px-3 py-2"
                  onClick={() =>
                    action(() =>
                      authClient.admin.revokeUserSessions({
                        userId: selected.id,
                      }),
                    )
                  }
                >
                  Revoke all sessions
                </button>
              </div>
              {message && (
                <p role="status" className="rounded-lg bg-elevated p-3 text-sm">
                  {message}
                </p>
              )}
              <label className="block text-sm font-medium">
                Public metadata
                <textarea
                  rows={8}
                  className={`${fieldClass} font-mono text-xs`}
                  value={metadata}
                  onChange={(e) => setMetadata(e.target.value)}
                />
              </label>
              <div>
                <h3 className="text-sm font-medium">
                  Private metadata and keys
                </h3>
                <p className="mt-1 text-xs text-muted">
                  Values are encrypted. Revealing a key is recorded in the audit
                  log.
                </p>
                <div className="mt-3 space-y-2">
                  {details.privateFields.map((field) => (
                    <div
                      key={field.key}
                      className="rounded-lg border border-border p-3"
                    >
                      <div className="flex justify-between gap-3 text-xs">
                        <span className="break-all font-mono">{field.key}</span>
                        <button
                          disabled={busy || !field.configured}
                          className="underline"
                          onClick={() =>
                            action(async () => {
                              const r = await fetch(
                                `/api/panel/identity/${selected.id}/secret`,
                                {
                                  method: "POST",
                                  headers: {
                                    "Content-Type": "application/json",
                                  },
                                  body: JSON.stringify({ key: field.key }),
                                },
                              );
                              const data = await r.json();
                              if (!r.ok)
                                return { error: { message: data.error } };
                              setRevealed({
                                ...revealed,
                                [field.key]: data.value,
                              });
                              return {};
                            }, "Secret revealed; access recorded")
                          }
                        >
                          Reveal
                        </button>
                      </div>
                      <p className="mt-2 break-all font-mono text-xs text-muted">
                        {field.key in revealed
                          ? JSON.stringify(revealed[field.key])
                          : field.configured
                            ? "••••••••"
                            : "Not configured"}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
              <label className="block text-sm font-medium">
                Update private metadata
                <p className="font-normal text-xs text-muted">
                  Enter only fields to change as JSON. Set a field to null to
                  clear it.
                </p>
                <textarea
                  rows={4}
                  className={`${fieldClass} font-mono text-xs`}
                  value={privatePatch}
                  onChange={(e) => setPrivatePatch(e.target.value)}
                />
              </label>
              <button disabled={busy} className={primaryClass} onClick={save}>
                Save metadata
              </button>
              <div>
                <h3 className="font-medium">Connected accounts</h3>
                {details.accounts.map((a) => (
                  <p key={a.id} className="mt-2 break-all text-sm text-muted">
                    {a.providerId} · {a.accountId}
                  </p>
                ))}
              </div>
              <div>
                <h3 className="font-medium">Active sessions</h3>
                {details.sessions.map((s) => (
                  <div
                    key={s.id}
                    className="mt-2 border-t border-border pt-2 text-xs text-muted"
                  >
                    <p>{s.userAgent}</p>
                    <p>
                      {s.ipAddress} · Expires{" "}
                      {new Date(s.expiresAt).toLocaleString()}
                    </p>
                  </div>
                ))}
                {!details.sessions.length && (
                  <p className="text-sm text-muted">No active sessions</p>
                )}
              </div>
              <div>
                <h3 className="font-medium">Audit log</h3>
                {details.audit.map((a, i) => (
                  <p key={i} className="mt-2 text-xs text-muted">
                    {new Date(a.created_at).toLocaleString()} · {a.action}
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
