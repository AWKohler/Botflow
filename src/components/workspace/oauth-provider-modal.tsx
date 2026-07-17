"use client";

import { Input } from "@/components/ui/input";
import { useId, useMemo, useState } from "react";
import { Check, Copy, ExternalLink, X, Loader2, KeyRound, FileUp } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getOAuthProvider,
  oauthCallbackUrl,
  type OAuthProviderField,
} from "@/lib/oauth-providers/registry";

interface OAuthProviderModalProps {
  requestId: string;
  /** Auth.js provider id (google | github | microsoft-entra-id | apple). */
  provider: string;
  convexSiteUrl: string | null;
  projectId: string;
  /** Called after a successful save OR a dismiss — clears the modal. */
  onClose: () => void;
}

/**
 * Registry-driven credential modal. Renders whatever fields the selected
 * provider declares (text / password / .p8 file upload), an optional audience
 * picker (Microsoft), the stable redirect URI to register, and the provider's
 * caveats. Posts the collected fields to oauth-provider-complete, which maps
 * them to env vars server-side — secrets never round-trip back to the client.
 */
export function OAuthProviderModal({
  requestId,
  provider,
  convexSiteUrl,
  projectId,
  onClose,
}: OAuthProviderModalProps) {
  const def = getOAuthProvider(provider);

  const callbackUrl = convexSiteUrl
    ? oauthCallbackUrl(convexSiteUrl, provider)
    : "Convex site URL not available — deploy your Convex functions first";

  const [values, setValues] = useState<Record<string, string>>({});
  const [fileNames, setFileNames] = useState<Record<string, string>>({});
  const [fileErrors, setFileErrors] = useState<Record<string, string>>({});
  const [audience, setAudience] = useState<string>(
    def?.audienceOptions?.[0]?.value ?? "",
  );
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idPrefix = useId().replace(/:/g, "");
  const titleId = `${idPrefix}-title`;
  const descriptionId = `${idPrefix}-description`;
  const errorId = `${idPrefix}-error`;

  const appleDomain = useMemo(() => {
    if (provider !== "apple" || !convexSiteUrl) return null;
    try {
      return new URL(convexSiteUrl).hostname;
    } catch {
      return null;
    }
  }, [convexSiteUrl, provider]);

  // Which fields are required right now (some are conditional, e.g. the
  // Microsoft tenant is only required for the single-tenant audience).
  const requiredKeys = useMemo(() => {
    if (!def) return new Set<string>();
    const keys = new Set(def.fields.filter((f) => f.required).map((f) => f.key));
    const aud = def.audienceOptions?.find((o) => o.value === audience);
    if (aud?.requiresTenant) keys.add("tenantId");
    else keys.delete("tenantId");
    return keys;
  }, [def, audience]);

  const missing = useMemo(
    () => [...requiredKeys].some((k) => !values[k]?.trim()),
    [requiredKeys, values],
  );

  const validationErrors = useMemo(() => {
    if (!def) return fileErrors;
    const next = { ...fileErrors };
    for (const field of def.fields) {
      const value = values[field.key]?.trim();
      if (!value || !field.validation) continue;
      const regex = new RegExp(`^(?:${field.validation.pattern})$`);
      if (!regex.test(value)) next[field.key] = field.validation.message;
    }
    return next;
  }, [def, fileErrors, values]);

  const hasValidationErrors = Object.keys(validationErrors).length > 0;

  if (!def) {
    // Unknown provider — render nothing rather than a broken modal.
    return null;
  }

  const setField = (key: string, value: string) => {
    setValues((v) => ({ ...v, [key]: value }));
    setFileErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
    setError(null);
  };

  const handleFile = async (field: OAuthProviderField, file: File | null) => {
    if (!file) return;
    if (field.accept === ".p8" && !file.name.toLowerCase().endsWith(".p8")) {
      setFileErrors((current) => ({ ...current, [field.key]: "Choose an Apple .p8 private-key file." }));
      return;
    }
    if (file.size > 64 * 1024) {
      setFileErrors((current) => ({ ...current, [field.key]: "This key file is unexpectedly large. Choose the original .p8 downloaded from Apple." }));
      return;
    }
    try {
      const text = await file.text();
      if (
        field.accept === ".p8" &&
        (!text.includes("-----BEGIN PRIVATE KEY-----") || !text.includes("-----END PRIVATE KEY-----"))
      ) {
        setFileErrors((current) => ({ ...current, [field.key]: "This does not look like a valid Apple .p8 private key." }));
        return;
      }
      setField(field.key, text);
      setFileNames((n) => ({ ...n, [field.key]: file.name }));
    } catch {
      setError(`Could not read ${file.name}. Please try again.`);
    }
  };

  const handleCopy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedValue(key);
      setTimeout(() => setCopiedValue((current) => (current === key ? null : current)), 2000);
    } catch {
      setError("Could not copy automatically. Select the value and copy it manually.");
    }
  };

  const handleDismiss = () => {
    // Fire-and-forget the dismiss; close immediately so the user isn't blocked.
    fetch(`/api/projects/${projectId}/convex/oauth-provider-complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, dismissed: true }),
    }).catch(() => {});
    onClose();
  };

  const handleSave = async () => {
    if (missing || hasValidationErrors || !convexSiteUrl) {
      setError(
        !convexSiteUrl
          ? "Deploy your Convex functions before configuring OAuth."
          : hasValidationErrors
            ? "Fix the highlighted credential fields before saving."
            : "Please fill in all required fields.",
      );
      return;
    }
    setSaving(true);
    setError(null);

    // Collect the declared fields (+ audience for providers that use it).
    const fields: Record<string, string> = {};
    for (const f of def.fields) {
      const val = values[f.key];
      if (val !== undefined && val !== "") fields[f.key] = val;
    }
    if (def.audienceOptions) fields.audience = audience;

    try {
      const res = await fetch(
        `/api/projects/${projectId}/convex/oauth-provider-complete`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId, fields }),
        },
      );
      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        provider?: string;
        agentWaiting?: boolean;
      };
      if (!data.ok) {
        setError(data.error ?? "Failed to save credentials. Please try again.");
        return;
      }
      // If no agent poller is actively waiting on this request (the agent
      // gave up and moved on), tell the AgentPanel so it can send a
      // system-note — otherwise the agent never learns the credentials
      // arrived and keeps reporting them missing.
      if (data.agentWaiting === false) {
        window.dispatchEvent(
          new CustomEvent("agent-modal-completed", {
            detail: {
              projectId,
              kind: "oauth-provider",
              subject: def.displayName,
            },
          }),
        );
      }
      onClose();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const renderCopyValue = (key: string, label: string, value: string, enabled = true) => (
    <div className="space-y-1.5">
      <p className="text-xs text-muted leading-relaxed">{label}</p>
      <div className={cn(
        "flex items-center gap-2 rounded-lg border px-3 py-2",
        enabled ? "bg-elevated border-border" : "bg-elevated border-border/50 opacity-60",
      )}>
        <code className="flex-1 text-xs text-fg font-mono break-all leading-relaxed">
          {value}
        </code>
        <button
          type="button"
          onClick={() => void handleCopy(key, value)}
          disabled={!enabled}
          className="inline-flex shrink-0 items-center gap-1 text-muted hover:text-fg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label={copiedValue === key ? `${label} copied` : `Copy ${label.toLowerCase()}`}
        >
          {copiedValue === key ? (
            <>
              <Check size={14} className="text-green-400" />
              <span className="text-[11px] text-green-400">Copied</span>
            </>
          ) : (
            <Copy size={14} />
          )}
        </button>
      </div>
    </div>
  );

  return (
    /* Full-screen overlay */
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      {/* Modal card */}
      <div
        className="relative w-full max-w-lg bg-surface border border-border rounded-2xl shadow-2xl mx-4 overflow-hidden max-h-[90vh] flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >

        {/* Header */}
        <div className="flex items-center gap-3 px-6 pt-6 pb-4 border-b border-border">
          <span className="flex items-center justify-center w-9 h-9 shrink-0 rounded-lg bg-accent/15 text-accent">
            <KeyRound size={18} />
          </span>
          <div className="flex-1 min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-fg">Connect {def.displayName} Sign-In</h2>
            <p id={descriptionId} className="text-xs text-muted mt-0.5">{def.blurb}</p>
          </div>
          <button
            type="button"
            onClick={handleDismiss}
            className="shrink-0 text-muted hover:text-fg hover:bg-elevated rounded-lg p-1.5 transition-colors"
            aria-label="Cancel"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body (scrolls if tall — Apple has the most fields) */}
        <div className="px-6 py-5 space-y-5 overflow-y-auto modern-scrollbar">

          {/* Step 1 — register the app */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="flex items-center justify-center w-5 h-5 rounded-full bg-accent/20 text-accent text-xs font-bold">1</span>
              <span className="text-sm font-medium text-fg">Register your app in {def.consoleName}</span>
            </div>
            <div className="pl-7 space-y-2">
              <p className="text-xs text-muted leading-relaxed">{def.setupHint}</p>
              {def.setupSteps && (
                <ol className="space-y-1.5 pl-4 list-decimal marker:text-muted/70">
                  {def.setupSteps.map((step) => (
                    <li key={step} className="text-xs text-muted leading-relaxed pl-0.5">{step}</li>
                  ))}
                </ol>
              )}
              {appleDomain && renderCopyValue("domain", "Domain (without https:// or a path)", appleDomain)}
              {renderCopyValue("redirect", "Return URL / redirect URI", callbackUrl, Boolean(convexSiteUrl))}
              <div className="flex flex-wrap gap-x-3 gap-y-1.5 pt-0.5">
                {(def.consoleLinks ?? [{ label: `Open ${def.consoleName}`, url: def.consoleUrl }]).map((link) => (
                  <a
                    key={link.url}
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs text-accent hover:underline"
                  >
                    {link.label}
                    <ExternalLink size={11} aria-hidden="true" />
                  </a>
                ))}
              </div>
            </div>
          </div>

          {/* Step 2 — credentials */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="flex items-center justify-center w-5 h-5 rounded-full bg-accent/20 text-accent text-xs font-bold">2</span>
              <span className="text-sm font-medium text-fg">Enter your credentials</span>
            </div>
            <div className="pl-7 space-y-3">

              {/* Audience picker (Microsoft) */}
              {def.audienceOptions && (
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-muted">Who can sign in?</label>
                  <div className="space-y-1.5">
                    {def.audienceOptions.map((opt) => (
                      <label
                        key={opt.value}
                        className={cn(
                          "flex items-start gap-2 rounded-lg border px-3 py-2 cursor-pointer transition-colors",
                          audience === opt.value ? "border-accent/60 bg-accent/5" : "border-border hover:bg-elevated",
                        )}
                      >
                        <input
                          type="radio"
                          name="audience"
                          value={opt.value}
                          checked={audience === opt.value}
                          onChange={() => { setAudience(opt.value); setError(null); }}
                          className="mt-0.5 accent-[var(--accent,#6d5efc)]"
                        />
                        <span className="min-w-0">
                          <span className="block text-sm text-fg">{opt.label}</span>
                          {opt.description && <span className="block text-xs text-muted">{opt.description}</span>}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* Declared fields */}
              {def.fields.map((field) => {
                const isRequired = requiredKeys.has(field.key);
                const inputId = `${idPrefix}-${field.key}`;
                const helpId = field.help ? `${inputId}-help` : undefined;
                const fieldError = validationErrors[field.key];
                const fieldErrorId = fieldError ? `${inputId}-error` : undefined;
                const describedBy = [helpId, fieldErrorId].filter(Boolean).join(" ") || undefined;
                if (field.type === "file") {
                  return (
                    <div key={field.key} className="space-y-1.5">
                      <label htmlFor={inputId} className="block text-xs font-medium text-muted">
                        {field.label}{isRequired && <span className="text-accent"> *</span>}
                      </label>
                      <label
                        htmlFor={inputId}
                        className={cn(
                          "flex items-center gap-2 rounded-lg border bg-elevated px-3 py-2 text-sm cursor-pointer transition-colors",
                          fieldError ? "border-red-400/60" : "border-border hover:border-accent/50",
                        )}
                      >
                        <FileUp size={14} className="text-muted shrink-0" />
                        <span className={cn("truncate", fileNames[field.key] ? "text-fg" : "text-muted")}>
                          {fileNames[field.key] ?? `Choose ${field.accept ?? "file"}…`}
                        </span>
                        <input
                          id={inputId}
                          type="file"
                          accept={field.accept}
                          required={isRequired}
                          aria-invalid={Boolean(fieldError)}
                          aria-describedby={describedBy}
                          className="hidden"
                          onChange={(e) => void handleFile(field, e.target.files?.[0] ?? null)}
                        />
                      </label>
                      {field.help && <p id={helpId} className="text-[11px] text-muted leading-relaxed">{field.help}</p>}
                      {fieldError && <p id={fieldErrorId} className="text-[11px] text-red-400 leading-relaxed">{fieldError}</p>}
                    </div>
                  );
                }
                return (
                  <div key={field.key} className="space-y-1.5">
                    <label htmlFor={inputId} className="block text-xs font-medium text-muted">
                      {field.label}{isRequired && <span className="text-accent"> *</span>}
                    </label>
                    <Input
                      id={inputId}
                      type={field.type === "password" ? "password" : "text"}
                      value={values[field.key] ?? ""}
                      onChange={(e) => setField(field.key, e.target.value)}
                      placeholder={field.placeholder}
                      required={isRequired}
                      pattern={field.validation?.pattern}
                      maxLength={field.validation?.maxLength}
                      aria-invalid={Boolean(fieldError)}
                      aria-describedby={describedBy}
                      className={cn(
                        "w-full bg-elevated border rounded-lg px-3 py-2 text-sm text-fg placeholder:text-muted outline-none focus:ring-1 focus:ring-accent/50 focus:border-accent/50 transition-colors",
                        fieldError ? "border-red-400/60" : "border-border",
                      )}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    {field.help && <p id={helpId} className="text-[11px] text-muted leading-relaxed">{field.help}</p>}
                    {fieldError && <p id={fieldErrorId} className="text-[11px] text-red-400 leading-relaxed">{fieldError}</p>}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Caveats */}
          {def.caveats.length > 0 && (
            <ul className="pl-7 space-y-1">
              {def.caveats.map((c, i) => (
                <li key={i} className="text-[11px] text-muted leading-relaxed flex gap-1.5">
                  <span className="text-muted/60">•</span>
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          )}

          {/* Error banner */}
          {error && (
            <p id={errorId} role="alert" className="text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
              {error}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-border">
          <button
            type="button"
            onClick={handleDismiss}
            className="text-sm text-muted hover:text-fg transition-colors"
          >
            Cancel — do this later
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || missing || hasValidationErrors || !convexSiteUrl}
            aria-describedby={error ? errorId : undefined}
            className="flex items-center gap-2 bg-accent text-accent-foreground text-sm font-medium rounded-lg px-4 py-2 hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Saving…
              </>
            ) : (
              "Save Credentials"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
