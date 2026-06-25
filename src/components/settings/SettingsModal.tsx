"use client";

import { useEffect, useState } from 'react';
import { SignedIn, SignedOut, SignInButton, PricingTable } from '@clerk/nextjs';
import { useToast } from '@/components/ui/toast';
import { X, ExternalLink, AlertTriangle, CheckCircle2, Loader2, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { UsageTab } from './UsageTab';
import { ANTHROPIC_OAUTH_ENABLED, CLAUDE_CODE_ENABLED } from '@/lib/feature-flags';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  defaultTab?: Tab;
  /** Pass true when rendering inside the workspace — COEP headers prevent Stripe iframes
   *  from loading, so the subscription tab opens /pricing in a new tab instead. */
  workspaceContext?: boolean;
}

type Tab = 'usage' | 'connections' | 'subscription';
type Provider = 'openai' | 'anthropic' | 'moonshot' | 'fireworks' | 'together' | 'google';
type OAuthStep = 'idle' | 'connecting' | 'exchanging' | 'success';

const PROVIDERS: Array<{
  provider: Provider;
  label: string;
  field: string;
  placeholder: string;
}> = [
  { provider: 'openai', label: 'OpenAI API Key', field: 'openaiApiKey', placeholder: 'sk-...' },
  { provider: 'anthropic', label: 'Anthropic API Key', field: 'anthropicApiKey', placeholder: 'sk-ant-...' },
  { provider: 'google', label: 'Google AI Studio API Key', field: 'googleApiKey', placeholder: 'AIza...' },
  { provider: 'moonshot', label: 'Moonshot API Key', field: 'moonshotApiKey', placeholder: 'moonshot-...' },
  { provider: 'fireworks', label: 'Fireworks AI API Key', field: 'fireworksApiKey', placeholder: 'fw-...' },
  // Only rendered when the USE_TOGETHER_KIMI flag is on (Kimi routed to Together AI).
  { provider: 'together', label: 'Together AI API Key', field: 'togetherApiKey', placeholder: 'together-...' },
];

export function SettingsModal({ open, onClose, defaultTab = 'usage', workspaceContext = false }: SettingsModalProps) {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<Tab>(defaultTab);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<Provider | null>(null);
  const [removingKey, setRemovingKey] = useState<Provider | null>(null);
  const [keys, setKeys] = useState<Record<Provider, string>>({
    openai: '', anthropic: '', moonshot: '', fireworks: '', together: '', google: '',
  });
  const [hasKey, setHasKey] = useState<Record<Provider, boolean>>({
    openai: false, anthropic: false, moonshot: false, fireworks: false, together: false, google: false,
  });
  // Server-controlled flag (USE_TOGETHER_KIMI): gates the Together AI key input.
  const [useTogetherKimi, setUseTogetherKimi] = useState(false);
  const [hasClaudeOAuth, setHasClaudeOAuth] = useState(false);
  const [hasCodexOAuth, setHasCodexOAuth] = useState(false);
  const [hasConvexOAuth, setHasConvexOAuth] = useState(false);
  const [convexConnecting, setConvexConnecting] = useState(false);

  // Apple Developer (App Store Connect API key) state
  const [appleConnected, setAppleConnected] = useState(false);
  const [appleKeyIdMasked, setAppleKeyIdMasked] = useState<string | null>(null);
  const [appleTeamId, setAppleTeamId] = useState<string | null>(null);
  const [appleP8, setAppleP8] = useState('');
  const [appleP8FileName, setAppleP8FileName] = useState('');
  const [appleKeyIdInput, setAppleKeyIdInput] = useState('');
  const [appleIssuerIdInput, setAppleIssuerIdInput] = useState('');
  const [appleTeamIdInput, setAppleTeamIdInput] = useState('');
  const [appleSaving, setAppleSaving] = useState(false);
  const [appleDisconnecting, setAppleDisconnecting] = useState(false);
  const [appleError, setAppleError] = useState('');
  // Per-user default agent backend for Anthropic models (BYOK choice only).
  // OAuth users are locked to claude-code regardless of this.
  const [preferredAnthropicBackend, setPreferredAnthropicBackend] = useState<'botflow' | 'claude-code'>('botflow');
  const [savingBackendPref, setSavingBackendPref] = useState(false);

  // Codex OAuth device flow state
  const [codexOAuthStep, setCodexOAuthStep] = useState<'idle' | 'polling' | 'success'>('idle');
  const [codexUserCode, setCodexUserCode] = useState('');
  const [codexVerificationUrl, setCodexVerificationUrl] = useState('');
  const [codexDeviceAuthId, setCodexDeviceAuthId] = useState('');
  const [codexPollInterval, setCodexPollInterval] = useState(5);

  // OAuth flow state
  const [oauthStep, setOauthStep] = useState<OAuthStep>('idle');
  const [oauthCode, setOauthCode] = useState('');
  const [authUrl, setAuthUrl] = useState('');
  const [pkceVerifier, setPkceVerifier] = useState('');
  const [oauthError, setOauthError] = useState('');

  useEffect(() => {
    if (!open) return;
    // On mobile, connections tab is hidden — fall back to usage
    const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;
    setActiveTab(defaultTab === 'connections' && isMobile ? 'usage' : defaultTab);
  }, [open, defaultTab]);

  // If screen resizes to mobile while connections is active, switch away
  useEffect(() => {
    if (activeTab !== 'connections') return;
    const check = () => {
      if (window.innerWidth < 640) setActiveTab('usage');
    };
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, [activeTab]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setKeys({ openai: '', anthropic: '', moonshot: '', fireworks: '', together: '', google: '' });
    setOauthStep('idle');
    setOauthCode('');
    setPkceVerifier('');
    setOauthError('');
    setCodexOAuthStep('idle');
    setCodexUserCode('');
    setCodexVerificationUrl('');
    setCodexDeviceAuthId('');
    (async () => {
      try {
        const res = await fetch('/api/user-settings');
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) {
            setHasKey({
              openai: Boolean(data?.hasOpenAIKey),
              anthropic: Boolean(data?.hasAnthropicKey),
              moonshot: Boolean(data?.hasMoonshotKey),
              fireworks: Boolean(data?.hasFireworksKey),
              together: Boolean(data?.hasTogetherKey),
              google: Boolean(data?.hasGoogleKey),
            });
            setUseTogetherKimi(Boolean(data?.useTogetherKimi));
            setHasClaudeOAuth(Boolean(data?.hasClaudeOAuth));
            setHasCodexOAuth(Boolean(data?.hasCodexOAuth));
            setHasConvexOAuth(Boolean(data?.hasConvexOAuth));
            const pref = data?.preferredAnthropicBackend;
            if (pref === 'botflow' || pref === 'claude-code') {
              setPreferredAnthropicBackend(pref);
            }
          }
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  // Apple Developer connection status (separate route — masked, never the .p8)
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setAppleP8('');
    setAppleP8FileName('');
    setAppleKeyIdInput('');
    setAppleIssuerIdInput('');
    setAppleTeamIdInput('');
    setAppleError('');
    (async () => {
      try {
        const res = await fetch('/api/user/apple-credentials');
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) {
            setAppleConnected(Boolean(data?.connected));
            setAppleKeyIdMasked(data?.keyId ?? null);
            setAppleTeamId(data?.teamId ?? null);
          }
        }
      } catch {
        // ignore
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  // handleClose is stable (defined inline on render, but deps are fine for this)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Codex device auth polling
  useEffect(() => {
    if (codexOAuthStep !== 'polling' || !codexDeviceAuthId || !codexUserCode) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/oauth/codex/poll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_auth_id: codexDeviceAuthId, user_code: codexUserCode }),
        });
        const data = await res.json();
        if (data.status === 'success') {
          setCodexOAuthStep('success');
          setHasCodexOAuth(true);
          toast({ title: 'ChatGPT Codex connected', description: 'OAuth token saved. GPT-5.3 Codex will use it automatically.' });
        } else if (data.status === 'failed') {
          setCodexOAuthStep('idle');
          toast({ title: 'Auth failed', description: 'Device authorization failed. Please try again.' });
        }
        // 'pending' — keep polling
      } catch {
        // ignore network errors, keep polling
      }
    }, codexPollInterval * 1000);
    return () => clearInterval(interval);
  }, [codexOAuthStep, codexDeviceAuthId, codexUserCode, codexPollInterval, toast]);

  const saveKey = async (provider: Provider) => {
    const config = PROVIDERS.find(p => p.provider === provider)!;
    const value = keys[provider].trim();
    if (!value) return;

    setSavingKey(provider);
    try {
      const res = await fetch('/api/user-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [config.field]: value }),
      });
      if (res.ok) {
        const data = await res.json();
        setHasKey({
          openai: Boolean(data?.hasOpenAIKey),
          anthropic: Boolean(data?.hasAnthropicKey),
          moonshot: Boolean(data?.hasMoonshotKey),
          fireworks: Boolean(data?.hasFireworksKey),
          together: Boolean(data?.hasTogetherKey),
          google: Boolean(data?.hasGoogleKey),
        });
        setKeys(prev => ({ ...prev, [provider]: '' }));
        toast({ title: 'Key saved', description: `${config.label} has been updated.` });
      } else {
        toast({ title: 'Save failed', description: 'Could not save key.' });
      }
    } catch {
      toast({ title: 'Save failed', description: 'Unexpected error.' });
    } finally {
      setSavingKey(null);
    }
  };

  const removeKey = async (provider: Provider) => {
    const config = PROVIDERS.find(p => p.provider === provider)!;
    setRemovingKey(provider);
    try {
      const res = await fetch('/api/user-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [config.field]: null }),
      });
      if (res.ok) {
        setHasKey(prev => ({ ...prev, [provider]: false }));
        setKeys(prev => ({ ...prev, [provider]: '' }));
        toast({ title: 'Key removed', description: `${config.label} has been removed.` });
      } else {
        toast({ title: 'Remove failed', description: 'Could not remove key.' });
      }
    } catch {
      toast({ title: 'Remove failed', description: 'Unexpected error.' });
    } finally {
      setRemovingKey(null);
    }
  };

  // ── Claude Code OAuth ────────────────────────────────────────────────────

  const startOAuthFlow = async () => {
    setOauthError('');
    try {
      const res = await fetch('/api/oauth/claude/start', { method: 'POST' });
      if (!res.ok) throw new Error('Failed to start OAuth flow');
      const { authUrl: url, verifier } = await res.json();
      setAuthUrl(url);
      setPkceVerifier(verifier);
      setOauthStep('connecting');
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      setOauthError(e instanceof Error ? e.message : 'Failed to start OAuth flow');
    }
  };

  function extractCode(input: string): string {
    const trimmed = input.trim();
    // Full callback URL — extract the `code` query param
    try {
      const url = new URL(trimmed);
      const code = url.searchParams.get('code');
      if (code) return code;
    } catch {
      // Not a URL — fall through
    }
    // Raw code possibly suffixed with #state — strip the fragment
    return trimmed.split('#')[0];
  }

  const exchangeCode = async () => {
    const code = extractCode(oauthCode);
    if (!code) return;
    setOauthError('');
    setOauthStep('exchanging');
    try {
      const res = await fetch('/api/oauth/claude/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, verifier: pkceVerifier }),
      });
      const data = await res.json();
      if (!res.ok) {
        setOauthError(data.error ?? 'Token exchange failed');
        setOauthStep('connecting');
        return;
      }
      setHasClaudeOAuth(true);
      setOauthStep('success');
      toast({ title: 'Claude Code connected', description: 'OAuth token saved. Anthropic models will use it automatically.' });
    } catch {
      setOauthError('Unexpected error exchanging token.');
      setOauthStep('connecting');
    }
  };

  const disconnectOAuth = async () => {
    try {
      await fetch('/api/oauth/claude/disconnect', { method: 'POST' });
      setHasClaudeOAuth(false);
      setOauthStep('idle');
      toast({ title: 'Disconnected', description: 'Claude Code OAuth token removed.' });
    } catch {
      toast({ title: 'Error', description: 'Failed to disconnect.' });
    }
  };

  // ── ChatGPT Codex OAuth (device flow) ──────────────────────────────────

  const startCodexOAuth = async () => {
    try {
      const res = await fetch('/api/oauth/codex/start', { method: 'POST' });
      if (!res.ok) throw new Error('Failed to start device auth');
      const data = await res.json();
      setCodexUserCode(data.user_code);
      setCodexVerificationUrl(data.verification_url);
      setCodexDeviceAuthId(data.device_auth_id);
      setCodexPollInterval(data.interval || 5);
      setCodexOAuthStep('polling');
      window.open(data.verification_url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : 'Failed to start Codex auth' });
    }
  };

  const disconnectCodexOAuth = async () => {
    try {
      await fetch('/api/oauth/codex/disconnect', { method: 'POST' });
      setHasCodexOAuth(false);
      setCodexOAuthStep('idle');
      toast({ title: 'Disconnected', description: 'ChatGPT Codex OAuth removed.' });
    } catch {
      toast({ title: 'Error', description: 'Failed to disconnect.' });
    }
  };

  // ── Convex OAuth ──────────────────────────────────────────────────────────

  const startConvexOAuth = async () => {
    setConvexConnecting(true);
    try {
      const res = await fetch('/api/oauth/convex/start?return_to=/');
      const data = await res.json();
      if (data.authUrl) window.location.href = data.authUrl;
    } catch {
      toast({ title: 'Error', description: 'Failed to start Convex authentication.' });
    } finally {
      setConvexConnecting(false);
    }
  };

  const disconnectConvexOAuth = async () => {
    try {
      await fetch('/api/oauth/convex/disconnect', { method: 'POST' });
      setHasConvexOAuth(false);
      toast({ title: 'Disconnected', description: 'Convex account disconnected.' });
    } catch {
      toast({ title: 'Error', description: 'Failed to disconnect.' });
    }
  };

  // ── Apple Developer (App Store Connect API key) ──────────────────────────

  const handleAppleP8File = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = await file.text();
      setAppleP8(text);
      setAppleP8FileName(file.name);
      setAppleError('');
    } catch {
      setAppleError('Could not read the .p8 file.');
    }
  };

  const saveAppleCredentials = async () => {
    if (!appleP8 || !appleKeyIdInput.trim() || !appleIssuerIdInput.trim()) return;
    setAppleSaving(true);
    setAppleError('');
    try {
      const res = await fetch('/api/user/apple-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          issuerId: appleIssuerIdInput.trim(),
          keyId: appleKeyIdInput.trim(),
          p8: appleP8,
          ...(appleTeamIdInput.trim() ? { teamId: appleTeamIdInput.trim() } : {}),
        }),
      });
      const data = await res.json();
      if (res.ok && data?.connected) {
        setAppleConnected(true);
        setAppleKeyIdMasked(data.keyId ?? null);
        setAppleTeamId(data.teamId ?? null);
        setAppleP8('');
        setAppleP8FileName('');
        setAppleKeyIdInput('');
        setAppleIssuerIdInput('');
        setAppleTeamIdInput('');
        toast({ title: 'Apple Developer connected', description: 'Your App Store Connect key was verified and saved.' });
      } else {
        setAppleError(data?.error ?? 'Could not save Apple credentials.');
      }
    } catch {
      setAppleError('Unexpected error saving Apple credentials.');
    } finally {
      setAppleSaving(false);
    }
  };

  const disconnectApple = async () => {
    setAppleDisconnecting(true);
    try {
      const res = await fetch('/api/user/apple-credentials', { method: 'DELETE' });
      if (res.ok) {
        setAppleConnected(false);
        setAppleKeyIdMasked(null);
        setAppleTeamId(null);
        toast({ title: 'Disconnected', description: 'Apple Developer key removed.' });
      } else {
        toast({ title: 'Error', description: 'Failed to disconnect.' });
      }
    } catch {
      toast({ title: 'Error', description: 'Failed to disconnect.' });
    } finally {
      setAppleDisconnecting(false);
    }
  };

  if (!open) return null;

  const handleClose = () => {
    onClose();
    // Notify listeners (AgentPanel, landing page) to refresh provider access
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('settings-closed'));
    }
  };

  const isSubscriptionTab = activeTab === 'subscription';

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center px-4">
      {/* Blur backdrop as a sibling — NOT an ancestor of the modal content.
          This prevents backdrop-filter from creating a containing block that
          traps Clerk's checkout panel (position:fixed) inside our modal. */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={handleClose}
      />
      <div
        className={cn(
          'relative w-full rounded-2xl border border-border bg-bg shadow-xl max-h-[90vh] flex flex-col overflow-hidden transition-all duration-200',
          isSubscriptionTab ? 'max-w-5xl' : activeTab === 'usage' ? 'max-w-xl' : 'max-w-lg'
        )}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 sm:px-6 py-3 sm:py-4 border-b border-border flex-shrink-0 gap-2">
          <div className="flex items-center gap-2 sm:gap-6 min-w-0">
            <h2 className="text-sm sm:text-lg font-semibold text-fg shrink-0">Settings</h2>
            <div className="flex items-center gap-0.5 sm:gap-1">
              <button
                onClick={() => setActiveTab('usage')}
                className={cn(
                  'px-2 sm:px-3 py-1 sm:py-1.5 rounded-lg text-xs sm:text-sm font-medium transition whitespace-nowrap',
                  activeTab === 'usage'
                    ? 'bg-elevated text-fg'
                    : 'text-muted hover:text-fg'
                )}
              >
                Usage
              </button>
              <button
                onClick={() => setActiveTab('connections')}
                className={cn(
                  'hidden sm:block px-2 sm:px-3 py-1 sm:py-1.5 rounded-lg text-xs sm:text-sm font-medium transition whitespace-nowrap',
                  activeTab === 'connections'
                    ? 'bg-elevated text-fg'
                    : 'text-muted hover:text-fg'
                )}
              >
                Connections
              </button>
              <button
                onClick={() => setActiveTab('subscription')}
                className={cn(
                  'px-2 sm:px-3 py-1 sm:py-1.5 rounded-lg text-xs sm:text-sm font-medium transition whitespace-nowrap',
                  activeTab === 'subscription'
                    ? 'bg-elevated text-fg'
                    : 'text-muted hover:text-fg'
                )}
              >
                Subscription
              </button>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="shrink-0 inline-flex items-center justify-center h-8 w-8 rounded-full hover:bg-elevated transition"
          >
            <X className="h-4 w-4 text-muted" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="px-3 sm:px-6 py-4 sm:py-5 overflow-y-auto flex-1">
          <SignedOut>
            <div className="rounded-xl border border-border p-6">
              <p className="mb-4 text-sm text-muted">You need to sign in to manage settings.</p>
              <SignInButton>
                <button className="inline-flex items-center rounded-lg border border-border bg-bg px-3.5 py-2 text-sm font-medium shadow-sm hover:bg-surface transition">
                  Sign in
                </button>
              </SignInButton>
            </div>
          </SignedOut>

          <SignedIn>
            {/* ── Usage tab ── */}
            {activeTab === 'usage' && <UsageTab />}

            {/* ── Subscription tab ── */}
            {activeTab === 'subscription' && (
              <div>
                <p className="text-xs text-muted mb-5">
                  Free is the default plan — no action needed to get started.
                  Upgrade anytime to unlock more capabilities.
                </p>
                {workspaceContext ? (
                  /* Stripe iframes can't run inside COEP-isolated workspace pages.
                     Open the pricing page in a new tab where there's no COEP restriction. */
                  <div className="flex flex-col items-start gap-3">
                    <p className="text-sm text-muted">
                      Subscription management opens in a new tab to ensure the payment form loads correctly.
                    </p>
                    <a
                      href="/pricing"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 rounded-xl bg-fg px-4 py-2.5 text-sm font-medium text-bg shadow hover:opacity-90 transition"
                    >
                      Manage subscription
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </div>
                ) : (
                  <PricingTable
                    newSubscriptionRedirectUrl="/projects"
                    ctaPosition="bottom"

                  
                    // appearance={

                    // }
                  />
                )}
              </div>
            )}

            {/* ── Connections tab ── */}
            {activeTab === 'connections' && (
              <>
                {loading ? (
                  <div className="py-8 text-center text-sm text-muted">Loading…</div>
                ) : (
                  <div className="space-y-8">

                    {/* ── Convex OAuth section ── */}
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <h3 className="text-sm font-semibold text-fg">Convex Account</h3>
                          <p className="text-xs text-muted mt-0.5">
                            Connect your Convex account to use your own backend projects.
                            Required for free-plan projects.
                          </p>
                        </div>
                        {hasConvexOAuth && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2.5 py-1 text-xs font-medium text-green-600 border border-green-500/30 whitespace-nowrap">
                            <CheckCircle2 className="h-3 w-3" /> Connected
                          </span>
                        )}
                      </div>

                      {!hasConvexOAuth ? (
                        <button
                          onClick={startConvexOAuth}
                          disabled={convexConnecting}
                          className="inline-flex items-center gap-2 rounded-lg border border-border bg-bg px-3.5 py-2 text-sm font-medium text-fg shadow-sm hover:bg-surface transition disabled:opacity-50"
                        >
                          {convexConnecting ? (
                            <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Connecting&hellip;</>
                          ) : 'Connect Convex Account'}
                        </button>
                      ) : (
                        <button
                          onClick={disconnectConvexOAuth}
                          className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/15 px-3.5 py-2 text-sm font-medium text-red-500 hover:bg-red-500/25 transition"
                        >
                          Disconnect
                        </button>
                      )}
                    </div>

                    {/* ── ChatGPT Codex OAuth section ── */}
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <h3 className="text-sm font-semibold text-fg">ChatGPT Codex</h3>
                          <p className="text-xs text-muted mt-0.5">
                            Use your ChatGPT subscription for GPT-5.3 Codex.
                            Takes priority over the OpenAI API key below.
                          </p>
                        </div>
                        {hasCodexOAuth && codexOAuthStep === 'idle' ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2.5 py-1 text-xs font-medium text-green-600 border border-green-500/30 whitespace-nowrap">
                            <CheckCircle2 className="h-3 w-3" /> Connected
                          </span>
                        ) : null}
                      </div>

                      {/* TODO: remove this warning once resolved */}
                      {/* <div className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2.5 mb-3">
                        <AlertTriangle className="h-3.5 w-3.5 text-amber-500 mt-0.5 flex-shrink-0" />
                        <p className="text-xs text-amber-700 dark:text-amber-300/80">
                          Currently facing issues when using models with OpenAI OAuth.
                        </p>
                      </div> */}

                      {!hasCodexOAuth && codexOAuthStep === 'idle' && (
                        <button
                          onClick={startCodexOAuth}
                          className="inline-flex items-center gap-2 rounded-lg border border-border bg-bg px-3.5 py-2 text-sm font-medium text-fg shadow-sm hover:bg-surface transition"
                        >
                          Sign in with ChatGPT Codex
                        </button>
                      )}

                      {hasCodexOAuth && codexOAuthStep === 'idle' && (
                        <button
                          onClick={disconnectCodexOAuth}
                          className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/15 px-3.5 py-2 text-sm font-medium text-red-500 hover:bg-red-500/25 transition"
                        >
                          Disconnect
                        </button>
                      )}

                      {codexOAuthStep === 'success' && (
                        <div className="flex items-center gap-2 text-sm text-green-700">
                          <CheckCircle2 className="h-4 w-4" />
                          Connected successfully!
                          <button
                            onClick={() => setCodexOAuthStep('idle')}
                            className="ml-auto text-muted hover:text-fg text-xs underline"
                          >
                            Done
                          </button>
                        </div>
                      )}

                      {codexOAuthStep === 'polling' && (
                        <div className="rounded-xl border border-border bg-surface p-4 space-y-3">
                          <p className="text-sm text-fg">
                            Go to{' '}
                            <a
                              href={codexVerificationUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-medium underline text-fg"
                            >
                              {codexVerificationUrl}
                            </a>{' '}
                            and enter this code:
                          </p>
                          <div className="flex items-center gap-3">
                            <code className="rounded-lg bg-bg border border-border px-4 py-2 text-lg font-mono font-bold tracking-widest text-fg select-all">
                              {codexUserCode}
                            </code>
                            <button
                              onClick={() => {
                                navigator.clipboard.writeText(codexUserCode);
                                toast({ title: 'Copied', description: 'Code copied to clipboard.' });
                              }}
                              className="text-xs text-muted hover:text-fg underline"
                            >
                              Copy
                            </button>
                          </div>
                          <div className="flex items-center gap-2 text-xs text-muted">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Waiting for authorization...
                          </div>
                          <div className="flex items-center gap-3">
                            <button
                              onClick={() => window.open(codexVerificationUrl, '_blank', 'noopener,noreferrer')}
                              className="text-xs text-muted underline"
                            >
                              Re-open verification page
                            </button>
                            <button
                              onClick={() => { setCodexOAuthStep('idle'); setCodexUserCode(''); setCodexDeviceAuthId(''); }}
                              className="text-xs text-muted underline"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* ── Claude Code OAuth section ── */}
                    {ANTHROPIC_OAUTH_ENABLED && <div>
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <h3 className="text-sm font-semibold text-fg">Claude Code OAuth</h3>
                          <p className="text-xs text-muted mt-0.5">
                            Use your Claude Pro/Max subscription instead of an API key.
                            Takes priority over the Anthropic API key below.
                          </p>
                        </div>
                        {hasClaudeOAuth && oauthStep !== 'idle' && oauthStep !== 'success' ? null : hasClaudeOAuth ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2.5 py-1 text-xs font-medium text-green-600 border border-green-500/30 whitespace-nowrap">
                            <CheckCircle2 className="h-3 w-3" /> Connected
                          </span>
                        ) : null}
                      </div>

                      {!hasClaudeOAuth && oauthStep === 'idle' && (
                        <button
                          onClick={startOAuthFlow}
                          className="inline-flex items-center gap-2 rounded-lg border border-border bg-bg px-3.5 py-2 text-sm font-medium text-fg shadow-sm hover:bg-surface transition"
                        >
                          Connect with Claude Code
                        </button>
                      )}

                      {hasClaudeOAuth && oauthStep === 'idle' && (
                        <button
                          onClick={disconnectOAuth}
                          className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/15 px-3.5 py-2 text-sm font-medium text-red-500 hover:bg-red-500/25 transition"
                        >
                          Disconnect
                        </button>
                      )}

                      {oauthStep === 'success' && (
                        <div className="flex items-center gap-2 text-sm text-green-700">
                          <CheckCircle2 className="h-4 w-4" />
                          Connected successfully!
                          <button
                            onClick={() => setOauthStep('idle')}
                            className="ml-auto text-muted hover:text-fg text-xs underline"
                          >
                            Done
                          </button>
                        </div>
                      )}

                      {(oauthStep === 'connecting' || oauthStep === 'exchanging') && (
                        <div className="rounded-xl border border-border bg-surface p-4 space-y-3">
                          <ol className="text-xs text-muted space-y-1 list-decimal list-inside">
                            <li>Complete authorization in the tab that opened.</li>
                            <li>After redirecting, copy the full URL from your browser&apos;s address bar.</li>
                            <li>Paste it below and click&nbsp;<strong>Connect</strong>.</li>
                          </ol>
                          <p className="text-xs text-muted">
                            You can paste the full URL or just the <code className="bg-soft px-1 rounded">code</code> value:{' '}
                            <code className="bg-soft px-1 rounded text-muted">
                              …/callback?code=<strong>THIS PART</strong>&amp;state=…
                            </code>
                          </p>
                          {oauthError && (
                            <p className="text-xs text-red-600 font-medium">{oauthError}</p>
                          )}
                          <div className="flex gap-2">
                            <input
                              type="text"
                              placeholder="Paste full callback URL or just the code…"
                              value={oauthCode}
                              onChange={e => setOauthCode(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') exchangeCode(); }}
                              className="flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:ring-2 focus:ring-border"
                              disabled={oauthStep === 'exchanging'}
                            />
                            <button
                              onClick={exchangeCode}
                              disabled={!oauthCode.trim() || oauthStep === 'exchanging'}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-fg px-3.5 py-2 text-sm font-medium text-bg shadow hover:opacity-90 disabled:opacity-40 transition"
                            >
                              {oauthStep === 'exchanging' ? (
                                <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Connecting…</>
                              ) : 'Connect'}
                            </button>
                          </div>
                          <div className="flex items-center gap-3">
                            <button
                              onClick={() => window.open(authUrl, '_blank', 'noopener,noreferrer')}
                              className="text-xs text-muted underline"
                            >
                              Re-open authorization page
                            </button>
                            <button
                              onClick={() => { setOauthStep('idle'); setOauthCode(''); setPkceVerifier(''); setOauthError(''); }}
                              className="text-xs text-muted underline"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </div>}

                    {/* ── Default Anthropic agent backend (BYOK choice) ── */}
                    {/* Only meaningful when:                                    */}
                    {/*   • Claude Code flag is on                               */}
                    {/*   • The user has an Anthropic API key (BYOK)             */}
                    {/*   • The user does NOT have Claude OAuth (which would    */}
                    {/*     force claude-code regardless)                        */}
                    {CLAUDE_CODE_ENABLED && hasKey.anthropic && !hasClaudeOAuth && (
                      <div>
                        <div className="mb-2">
                          <h3 className="text-sm font-semibold text-fg">Default agent for Anthropic models</h3>
                          <p className="text-xs text-muted mt-0.5">
                            Applies to new sandbox projects. You can still switch per-project from the agent panel.
                          </p>
                        </div>
                        <div className="space-y-2">
                          {([
                            {
                              value: 'botflow' as const,
                              label: 'Botflow',
                              desc: 'Our agent and tools, charged to your Anthropic key. Same flow as other models.',
                            },
                            {
                              value: 'claude-code' as const,
                              label: 'Claude Code',
                              desc: 'Anthropic’s official agent runs inside the project sandbox. More autonomous; same Anthropic billing.',
                            },
                          ]).map((opt) => {
                            const active = preferredAnthropicBackend === opt.value;
                            return (
                              <button
                                key={opt.value}
                                type="button"
                                disabled={savingBackendPref}
                                onClick={async () => {
                                  if (opt.value === preferredAnthropicBackend) return;
                                  setSavingBackendPref(true);
                                  const prev = preferredAnthropicBackend;
                                  setPreferredAnthropicBackend(opt.value);
                                  try {
                                    const res = await fetch('/api/user-settings', {
                                      method: 'POST',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({ preferredAnthropicBackend: opt.value }),
                                    });
                                    if (!res.ok) throw new Error('Failed to save preference');
                                    toast({ title: 'Default agent updated', description: `New Anthropic projects will use ${opt.label}.` });
                                  } catch {
                                    setPreferredAnthropicBackend(prev);
                                    toast({ title: 'Could not save preference' });
                                  } finally {
                                    setSavingBackendPref(false);
                                  }
                                }}
                                className={`w-full text-left rounded-xl border p-3 transition ${
                                  active
                                    ? 'border-accent bg-accent/10'
                                    : 'border-border bg-bg hover:bg-surface'
                                }`}
                              >
                                <div className="flex items-center gap-2">
                                  <span className={`size-3 rounded-full border-2 ${active ? 'border-accent bg-accent' : 'border-border'}`} />
                                  <span className="text-sm font-medium text-fg">{opt.label}</span>
                                </div>
                                <p className="text-xs text-muted mt-1.5 ml-5 leading-snug">{opt.desc}</p>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* ── BYOK API Keys ── */}
                    <div>
                      <h3 className="text-sm font-semibold text-fg mb-1">API Keys</h3>
                      <p className="text-xs text-muted mb-4">
                        Bring your own keys. Each key is saved independently — adding one won&apos;t affect the others.
                        {hasCodexOAuth && (
                          <span className="ml-1 text-green-700 font-medium">
                            Codex OAuth is active — OpenAI API key is used as fallback only.
                          </span>
                        )}
                        {ANTHROPIC_OAUTH_ENABLED && hasClaudeOAuth && (
                          <span className="ml-1 text-green-700 font-medium">
                            Claude Code OAuth is active — Anthropic API key is used as fallback only.
                          </span>
                        )}
                      </p>
                      <div className="space-y-4">
                        {PROVIDERS.filter(p => p.provider !== 'together' || useTogetherKimi).map(({ provider, label, placeholder }) => (
                          <div key={provider}>
                            <label className="flex items-center gap-2 text-sm font-medium text-fg mb-1.5">
                              {label}
                              {hasKey[provider] && (
                                <span className="inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-xs font-medium text-green-600 border border-green-500/30">
                                  Saved
                                </span>
                              )}
                              {provider === 'openai' && hasCodexOAuth && (
                                <span className="inline-flex items-center rounded-full bg-elevated px-2 py-0.5 text-xs text-muted">
                                  fallback
                                </span>
                              )}
                              {ANTHROPIC_OAUTH_ENABLED && provider === 'anthropic' && hasClaudeOAuth && (
                                <span className="inline-flex items-center rounded-full bg-elevated px-2 py-0.5 text-xs text-muted">
                                  fallback
                                </span>
                              )}
                            </label>
                            <div className="flex items-center gap-2">
                              <input
                                type="password"
                                placeholder={hasKey[provider] ? '●●●●●●●● (type to replace)' : placeholder}
                                value={keys[provider]}
                                onChange={e => setKeys(prev => ({ ...prev, [provider]: e.target.value }))}
                                onKeyDown={e => { if (e.key === 'Enter') saveKey(provider); }}
                                className="flex-1 rounded-lg border border-border bg-bg text-fg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-border"
                              />
                              {hasKey[provider] && (
                                <button
                                  onClick={() => removeKey(provider)}
                                  disabled={removingKey === provider || savingKey === provider}
                                  title="Remove key"
                                  className="inline-flex items-center justify-center h-9 w-9 rounded-lg border border-red-500/30 bg-red-500/15 text-red-500 hover:bg-red-500/25 disabled:opacity-40 transition"
                                >
                                  {removingKey === provider
                                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    : <Trash2 className="h-3.5 w-3.5" />}
                                </button>
                              )}
                              <button
                                onClick={() => saveKey(provider)}
                                disabled={!keys[provider].trim() || savingKey === provider || removingKey === provider}
                                className="inline-flex items-center rounded-lg bg-fg px-3.5 py-2 text-sm font-medium text-bg shadow hover:opacity-90 disabled:opacity-40 transition"
                              >
                                {savingKey === provider ? 'Saving…' : 'Save'}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* ── Apple Developer (App Store Connect) section ── */}
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <h3 className="text-sm font-semibold text-fg">Apple Developer</h3>
                          <p className="text-xs text-muted mt-0.5">
                            Connect an App Store Connect API key to publish Swift apps
                            to TestFlight and the App Store.
                          </p>
                        </div>
                        {appleConnected && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2.5 py-1 text-xs font-medium text-green-600 border border-green-500/30 whitespace-nowrap">
                            <CheckCircle2 className="h-3 w-3" /> Connected
                          </span>
                        )}
                      </div>

                      {appleConnected ? (
                        <div className="flex items-center gap-3">
                          <div className="text-xs text-muted">
                            <span className="font-medium text-fg">Key {appleKeyIdMasked}</span>
                            {appleTeamId && <span className="ml-2">Team {appleTeamId}</span>}
                          </div>
                          <button
                            onClick={disconnectApple}
                            disabled={appleDisconnecting}
                            className="ml-auto inline-flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/15 px-3.5 py-2 text-sm font-medium text-red-500 hover:bg-red-500/25 disabled:opacity-50 transition"
                          >
                            {appleDisconnecting ? (
                              <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Disconnecting&hellip;</>
                            ) : 'Disconnect'}
                          </button>
                        </div>
                      ) : (
                        <div className="rounded-xl border border-border bg-surface p-4 space-y-3">
                          {/* Free Apple IDs never see the Integrations page — lead
                              with the paid-membership requirement or the link below
                              dead-ends for anyone not enrolled. */}
                          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
                            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-400" />
                            <p className="text-xs leading-5 text-muted">
                              <span className="font-semibold text-fg">
                                Requires a paid Apple Developer account (US$99/year).
                              </span>{' '}
                              With a free Apple ID, the Integrations page where keys are
                              created won&apos;t exist in App Store Connect at all.
                              Activation can take up to 48 hours after enrolling.{' '}
                              <a
                                href="https://developer.apple.com/programs/enroll/"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 underline text-fg hover:text-fg"
                              >
                                Enroll <ExternalLink className="h-3 w-3" />
                              </a>
                            </p>
                          </div>
                          <p className="text-xs leading-5 text-muted">
                            Once enrolled, open{' '}
                            <a
                              href="https://appstoreconnect.apple.com/access/integrations/api"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 underline text-fg hover:text-fg"
                            >
                              App Store Connect → Users and Access → Integrations
                              <ExternalLink className="h-3 w-3" />
                            </a>
                            . First time, if it shows{' '}
                            <span className="font-medium text-fg">&ldquo;Request Access&rdquo;</span>{' '}
                            instead of a key list, click it and accept the terms (Account
                            Holder only). Then on the{' '}
                            <span className="font-medium text-fg">Team Keys</span> tab generate
                            a key with the <span className="font-medium text-fg">App Manager</span>{' '}
                            role and download the .p8 right away (offered once). Copy the{' '}
                            <span className="font-medium text-fg">Issuer ID</span> from the top
                            of the page (shared by all keys) and the key&apos;s{' '}
                            <span className="font-medium text-fg">Key ID</span> from its row. If
                            the .p8 download seems stuck or your browser warns, click{' '}
                            <span className="font-medium text-fg">Keep</span> — it&apos;s safe.
                          </p>
                          <div>
                            <label className="block text-xs font-medium text-fg mb-1.5">Private key (.p8)</label>
                            <label className="flex items-center gap-2 rounded-lg border border-dashed border-border bg-bg px-3 py-2 text-sm text-muted cursor-pointer hover:bg-elevated transition">
                              <input
                                type="file"
                                accept=".p8,application/x-pem-file,text/plain"
                                className="hidden"
                                onChange={e => handleAppleP8File(e.target.files?.[0])}
                              />
                              {appleP8FileName ? (
                                <span className="text-fg font-medium">{appleP8FileName}</span>
                              ) : (
                                <span>Choose your AuthKey_XXXXXXXXXX.p8 file…</span>
                              )}
                            </label>
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <div>
                              <label className="block text-xs font-medium text-fg mb-1.5">Key ID</label>
                              <input
                                type="text"
                                placeholder="e.g. 2X9R4HXF34"
                                value={appleKeyIdInput}
                                onChange={e => setAppleKeyIdInput(e.target.value)}
                                className="w-full rounded-lg border border-border bg-bg text-fg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-border"
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-fg mb-1.5">Issuer ID</label>
                              <input
                                type="text"
                                placeholder="69a6de7e-…"
                                value={appleIssuerIdInput}
                                onChange={e => setAppleIssuerIdInput(e.target.value)}
                                className="w-full rounded-lg border border-border bg-bg text-fg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-border"
                              />
                            </div>
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-fg mb-1.5">
                              Team ID <span className="font-normal text-muted">(optional — we auto-detect it if you leave this blank)</span>
                            </label>
                            <input
                              type="text"
                              placeholder="e.g. A1B2C3D4E5"
                              value={appleTeamIdInput}
                              onChange={e => setAppleTeamIdInput(e.target.value)}
                              className="w-full rounded-lg border border-border bg-bg text-fg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-border"
                            />
                            <p className="mt-1 text-[11px] leading-4 text-muted">
                              To set it manually:{' '}
                              <a
                                href="https://developer.apple.com/account"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="underline hover:text-fg"
                              >
                                developer.apple.com/account
                              </a>{' '}
                              → Membership details → Team ID — the 10-char code, not the number
                              in the License Agreement PDF&apos;s filename.
                            </p>
                          </div>
                          {appleError && (
                            <p className="text-xs text-red-600 font-medium">{appleError}</p>
                          )}
                          <button
                            onClick={saveAppleCredentials}
                            disabled={!appleP8 || !appleKeyIdInput.trim() || !appleIssuerIdInput.trim() || appleSaving}
                            className="inline-flex items-center gap-2 rounded-lg bg-fg px-3.5 py-2 text-sm font-medium text-bg shadow hover:opacity-90 disabled:opacity-40 transition"
                          >
                            {appleSaving ? (
                              <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Verifying&hellip;</>
                            ) : 'Save'}
                          </button>
                        </div>
                      )}
                    </div>

                  </div>
                )}
              </>
            )}
          </SignedIn>
        </div>
      </div>
    </div>
  );
}
