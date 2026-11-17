"use client";

import { Input } from "@/components/ui/input";
import { useEffect, useState } from 'react';
import { SignedIn, SignedOut, SignInButton } from '@/components/auth';
import { useToast } from '@/components/ui/toast';
import { X, ExternalLink, AlertTriangle, CheckCircle2, Loader2, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { buttonClass } from '@/components/ui/button';
import { UsageTab } from './UsageTab';
import { ANTHROPIC_OAUTH_ENABLED } from '@/lib/feature-flags';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  defaultTab?: Tab;
  /** Pass true when rendering inside the workspace, where leaving the page
   *  would interrupt work: links out of the dialog then open in a new tab. */
  workspaceContext?: boolean;
  /** 'section' renders just the content of `defaultTab`, with no dialog
   *  around it, so the Settings page and the dialog are one implementation. */
  variant?: 'modal' | 'section';
}

type Tab = 'usage' | 'connections';
type Provider = 'openai' | 'anthropic' | 'moonshot' | 'fireworks' | 'together' | 'google' | 'xai';
type OAuthStep = 'idle' | 'connecting' | 'exchanging' | 'success';

const PROVIDERS: Array<{
  provider: Provider;
  label: string;
  field: string;
  placeholder: string;
}> = [
  { provider: 'openai', label: 'OpenAI', field: 'openaiApiKey', placeholder: 'sk-...' },
  { provider: 'anthropic', label: 'Anthropic', field: 'anthropicApiKey', placeholder: 'sk-ant-...' },
  { provider: 'google', label: 'Google AI Studio', field: 'googleApiKey', placeholder: 'AIza...' },
  { provider: 'xai', label: 'xAI (Grok)', field: 'xaiApiKey', placeholder: 'xai-...' },
  { provider: 'moonshot', label: 'Moonshot', field: 'moonshotApiKey', placeholder: 'moonshot-...' },
  { provider: 'fireworks', label: 'Fireworks AI', field: 'fireworksApiKey', placeholder: 'fw-...' },
  // Only rendered when the USE_TOGETHER_KIMI flag is on (Kimi routed to Together AI).
  { provider: 'together', label: 'Together AI', field: 'togetherApiKey', placeholder: 'together-...' },
];

const connectionButtonClass =
  'inline-flex h-8 items-center gap-2 whitespace-nowrap rounded-lg border border-border bg-bg px-3 text-[13px] font-medium text-fg shadow-xs transition-colors hover:border-border-strong hover:bg-elevated disabled:opacity-50';

/**
 * One connection row: what it is on the left, its state and its single action
 * on the right, so every connection reads the same way at a glance.
 */
function ConnectionHeader({
  title,
  description,
  connected,
  children,
}: {
  title: string;
  description: React.ReactNode;
  connected: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
        <p className="mt-0.5 max-w-prose text-xs leading-5 text-muted">{description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2.5">
        {connected && (
          <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-success">
            <CheckCircle2 className="h-3.5 w-3.5" /> Connected
          </span>
        )}
        {children}
      </div>
    </div>
  );
}

export function SettingsModal({ open, onClose, defaultTab = 'usage', workspaceContext = false, variant = 'modal' }: SettingsModalProps) {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<Tab>(defaultTab);
  const [loading, setLoading] = useState(true);
  // A failed load must never read as "nothing is connected".
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [savingKey, setSavingKey] = useState<Provider | null>(null);
  const [removingKey, setRemovingKey] = useState<Provider | null>(null);
  const [keys, setKeys] = useState<Record<Provider, string>>({
    openai: '', anthropic: '', moonshot: '', fireworks: '', together: '', google: '', xai: '',
  });
  const [hasKey, setHasKey] = useState<Record<Provider, boolean>>({
    openai: false, anthropic: false, moonshot: false, fireworks: false, together: false, google: false, xai: false,
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
    // Connections stays a larger-screen task (its sign-in flows need a second
    // window), so on a phone the dialog falls back to Usage.
    const isMobile = variant === 'modal' && typeof window !== 'undefined' && window.innerWidth < 640;
    setActiveTab(defaultTab === 'connections' && isMobile ? 'usage' : defaultTab);
  }, [open, defaultTab, variant]);

  // If screen resizes to mobile while connections is active, switch away
  useEffect(() => {
    if (activeTab !== 'connections' || variant !== 'modal') return;
    const check = () => {
      if (window.innerWidth < 640) setActiveTab('usage');
    };
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, [activeTab, variant]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    setKeys({ openai: '', anthropic: '', moonshot: '', fireworks: '', together: '', google: '', xai: '' });
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
              xai: Boolean(data?.hasXaiKey),
            });
            setUseTogetherKimi(Boolean(data?.useTogetherKimi));
            setHasClaudeOAuth(Boolean(data?.hasClaudeOAuth));
            setHasCodexOAuth(Boolean(data?.hasCodexOAuth));
            setHasConvexOAuth(Boolean(data?.hasConvexOAuth));
          }
        } else if (!cancelled) {
          setLoadFailed(true);
        }
      } catch {
        if (!cancelled) setLoadFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, reloadKey]);

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
          toast({ title: 'ChatGPT connected', description: 'GPT-5.3 Codex will now use your ChatGPT subscription.' });
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
          xai: Boolean(data?.hasXaiKey),
        });
        setKeys(prev => ({ ...prev, [provider]: '' }));
        toast({ title: 'Key saved', description: `Your ${config.label} key has been updated.` });
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
        toast({ title: 'Key removed', description: `Your ${config.label} key has been removed.` });
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
      toast({ title: 'Claude connected', description: 'Claude models will now use your Claude subscription.' });
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
      toast({ title: 'Disconnected', description: 'Your Claude subscription is no longer connected.' });
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
      toast({ title: 'Disconnected', description: 'Your ChatGPT subscription is no longer connected.' });
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

  const body = (
    <>
      <SignedOut>
        <div className="rounded-xl border border-border p-6">
          <p className="mb-4 text-sm text-muted">You need to sign in to manage settings.</p>
          <SignInButton>
            <button className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-bg px-3.5 text-sm font-medium text-fg shadow-xs transition-colors hover:border-border-strong hover:bg-elevated disabled:opacity-50">
              Sign in
            </button>
          </SignInButton>
        </div>
      </SignedOut>

      <SignedIn>
            {/* ── Usage tab ── */}
            {activeTab === 'usage' && <UsageTab />}

            {/* ── Connections tab ── */}
            {activeTab === 'connections' && (
              <>
                {loading ? (
                  <div className="flex items-center justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted" /></div>
                ) : loadFailed ? (
                  <div className="flex flex-col items-center gap-3 py-10 text-center">
                    <p className="text-sm text-muted">Your connections couldn&apos;t be loaded.</p>
                    <button onClick={() => setReloadKey((k) => k + 1)} className={connectionButtonClass}>
                      Try again
                    </button>
                  </div>
                ) : (
                  <div className="divide-y divide-border [&>div]:py-5 [&>div:first-child]:pt-0 [&>div:last-child]:pb-0">

                    {/* ── Convex OAuth section ── */}
                    <div>
                      <ConnectionHeader
                        title="Convex account"
                        description="Use your own Convex account for your projects' backends. Required on the Free plan."
                        connected={hasConvexOAuth}
                      >
                        {!hasConvexOAuth ? (
                          <button onClick={startConvexOAuth} disabled={convexConnecting} className={connectionButtonClass}>
                            {convexConnecting ? (
                              <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Connecting&hellip;</>
                            ) : 'Connect'}
                          </button>
                        ) : (
                          <button onClick={disconnectConvexOAuth} className={connectionButtonClass}>
                            Disconnect
                          </button>
                        )}
                      </ConnectionHeader>
                    </div>

                    {/* ── ChatGPT Codex OAuth section ── */}
                    <div>
                      <ConnectionHeader
                        title="ChatGPT subscription"
                        description="Use your ChatGPT plan for GPT-5.3 Codex. Takes priority over the OpenAI API key below."
                        connected={hasCodexOAuth && codexOAuthStep === 'idle'}
                      >
                        {!hasCodexOAuth && codexOAuthStep === 'idle' && (
                          <button onClick={startCodexOAuth} className={connectionButtonClass}>
                            Connect
                          </button>
                        )}
                        {hasCodexOAuth && codexOAuthStep === 'idle' && (
                          <button onClick={disconnectCodexOAuth} className={connectionButtonClass}>
                            Disconnect
                          </button>
                        )}
                      </ConnectionHeader>

                      {codexOAuthStep === 'success' && (
                        <div className="mt-3 flex items-center gap-2 text-sm text-success">
                          <CheckCircle2 className="h-4 w-4" />
                          Connected.
                          <button
                            onClick={() => setCodexOAuthStep('idle')}
                            className="ml-auto text-muted hover:text-fg text-xs underline"
                          >
                            Done
                          </button>
                        </div>
                      )}

                      {codexOAuthStep === 'polling' && (
                        <div className="mt-3 rounded-xl border border-border bg-surface p-4 space-y-3">
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
                      <ConnectionHeader
                        title="Claude subscription"
                        description="Use your Claude Pro or Max plan instead of an API key. Takes priority over the Anthropic API key below."
                        connected={hasClaudeOAuth && (oauthStep === 'idle' || oauthStep === 'success')}
                      >
                        {!hasClaudeOAuth && oauthStep === 'idle' && (
                          <button onClick={startOAuthFlow} className={connectionButtonClass}>
                            Connect
                          </button>
                        )}
                        {hasClaudeOAuth && oauthStep === 'idle' && (
                          <button onClick={disconnectOAuth} className={connectionButtonClass}>
                            Disconnect
                          </button>
                        )}
                      </ConnectionHeader>

                      {oauthStep === 'success' && (
                        <div className="mt-3 flex items-center gap-2 text-sm text-success">
                          <CheckCircle2 className="h-4 w-4" />
                          Connected.
                          <button
                            onClick={() => setOauthStep('idle')}
                            className="ml-auto text-muted hover:text-fg text-xs underline"
                          >
                            Done
                          </button>
                        </div>
                      )}

                      {(oauthStep === 'connecting' || oauthStep === 'exchanging') && (
                        <div className="mt-3 rounded-xl border border-border bg-surface p-4 space-y-3">
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
                            <p className="text-xs text-danger font-medium">{oauthError}</p>
                          )}
                          <div className="flex gap-2">
                            <Input
                              type="text"
                              placeholder="Paste full callback URL or just the code…"
                              value={oauthCode}
                              onChange={e => setOauthCode(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') exchangeCode(); }}
                              className="flex-1 rounded-lg border border-control bg-bg px-3 h-9 text-sm text-fg shadow-xs outline-none placeholder:text-subtle transition-[border-color,box-shadow] hover:border-subtle focus:border-accent focus:ring-3 focus:ring-accent/15"
                              disabled={oauthStep === 'exchanging'}
                            />
                            <button
                              onClick={exchangeCode}
                              disabled={!oauthCode.trim() || oauthStep === 'exchanging'}
                              className="inline-flex h-9 items-center gap-2 rounded-lg bg-fg px-3.5 text-sm font-medium text-bg shadow-xs transition-colors hover:bg-fg/88 disabled:opacity-50"
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

                    {/* ── BYOK API Keys ── */}
                    <div>
                      <h3 className="text-sm font-semibold text-fg mb-1">API keys</h3>
                      <p className="text-xs text-muted mb-4">
                        Use your own model keys. Each one is saved separately.
                        {(hasCodexOAuth || (ANTHROPIC_OAUTH_ENABLED && hasClaudeOAuth)) && (
                          <> A key marked Fallback is only used if its subscription above is unavailable.</>
                        )}
                      </p>
                      <div className="space-y-4">
                        {PROVIDERS.filter(p => p.provider !== 'together' || useTogetherKimi).map(({ provider, label, placeholder }) => (
                          <div key={provider}>
                            <label className="flex items-center gap-2 text-sm font-medium text-fg mb-1.5">
                              {label}
                              {hasKey[provider] && (
                                <span className="inline-flex items-center gap-1 rounded-full border border-success-border bg-success-soft px-2 py-0.5 text-[11px] font-medium text-success">
                                  Saved
                                </span>
                              )}
                              {provider === 'openai' && hasCodexOAuth && (
                                <span className="inline-flex items-center rounded-full border border-border bg-elevated px-2 py-0.5 text-[11px] font-medium text-muted">
                                  Fallback
                                </span>
                              )}
                              {ANTHROPIC_OAUTH_ENABLED && provider === 'anthropic' && hasClaudeOAuth && (
                                <span className="inline-flex items-center rounded-full border border-border bg-elevated px-2 py-0.5 text-[11px] font-medium text-muted">
                                  Fallback
                                </span>
                              )}
                            </label>
                            <div className="flex items-center gap-2">
                              <Input
                                type="password"
                                placeholder={hasKey[provider] ? '●●●●●●●● (type to replace)' : placeholder}
                                value={keys[provider]}
                                onChange={e => setKeys(prev => ({ ...prev, [provider]: e.target.value }))}
                                onKeyDown={e => { if (e.key === 'Enter') saveKey(provider); }}
                                className="flex-1 rounded-lg border border-control bg-bg px-3 h-9 text-sm text-fg shadow-xs outline-none placeholder:text-subtle transition-[border-color,box-shadow] hover:border-subtle focus:border-accent focus:ring-3 focus:ring-accent/15"
                              />
                              {hasKey[provider] && (
                                <button
                                  onClick={() => removeKey(provider)}
                                  disabled={removingKey === provider || savingKey === provider}
                                  title="Remove key"
                                  className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border text-muted transition-colors hover:border-danger-border hover:bg-danger-soft hover:text-danger disabled:opacity-40"
                                >
                                  {removingKey === provider
                                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    : <Trash2 className="h-3.5 w-3.5" />}
                                </button>
                              )}
                              {/* Save appears with the first character, so a page of empty
                                  fields is not a page of greyed-out buttons. */}
                              {keys[provider].trim() && (
                                <button
                                  onClick={() => saveKey(provider)}
                                  disabled={savingKey === provider || removingKey === provider}
                                  className={buttonClass({ variant: 'primary' })}
                                >
                                  {savingKey === provider ? 'Saving…' : 'Save'}
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* ── Apple Developer (App Store Connect) section ── */}
                    <div>
                      <ConnectionHeader
                        title="Apple Developer"
                        description={
                          appleConnected
                            ? <>Key {appleKeyIdMasked}{appleTeamId ? <> · Team {appleTeamId}</> : null}. Used to publish Swift apps to TestFlight and the App Store.</>
                            : 'Add an App Store Connect API key to publish Swift apps to TestFlight and the App Store.'
                        }
                        connected={appleConnected}
                      >
                        {appleConnected && (
                          <button onClick={disconnectApple} disabled={appleDisconnecting} className={connectionButtonClass}>
                            {appleDisconnecting ? (
                              <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Disconnecting&hellip;</>
                            ) : 'Disconnect'}
                          </button>
                        )}
                      </ConnectionHeader>

                      {appleConnected ? null : (
                        <div className="mt-3 rounded-xl border border-border bg-surface p-4 space-y-3">
                          {/* Free Apple IDs never see the Integrations page — lead
                              with the paid-membership requirement or the link below
                              dead-ends for anyone not enrolled. */}
                          <div className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-soft px-3 py-2.5">
                            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-warning" />
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
                              <Input
                                type="text"
                                placeholder="e.g. 2X9R4HXF34"
                                value={appleKeyIdInput}
                                onChange={e => setAppleKeyIdInput(e.target.value)}
                                className="w-full rounded-lg border border-control bg-bg px-3 h-9 text-sm text-fg shadow-xs outline-none placeholder:text-subtle transition-[border-color,box-shadow] hover:border-subtle focus:border-accent focus:ring-3 focus:ring-accent/15"
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-fg mb-1.5">Issuer ID</label>
                              <Input
                                type="text"
                                placeholder="69a6de7e-…"
                                value={appleIssuerIdInput}
                                onChange={e => setAppleIssuerIdInput(e.target.value)}
                                className="w-full rounded-lg border border-control bg-bg px-3 h-9 text-sm text-fg shadow-xs outline-none placeholder:text-subtle transition-[border-color,box-shadow] hover:border-subtle focus:border-accent focus:ring-3 focus:ring-accent/15"
                              />
                            </div>
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-fg mb-1.5">
                              Team ID <span className="font-normal text-muted">(optional — we auto-detect it if you leave this blank)</span>
                            </label>
                            <Input
                              type="text"
                              placeholder="e.g. A1B2C3D4E5"
                              value={appleTeamIdInput}
                              onChange={e => setAppleTeamIdInput(e.target.value)}
                              className="w-full rounded-lg border border-control bg-bg px-3 h-9 text-sm text-fg shadow-xs outline-none placeholder:text-subtle transition-[border-color,box-shadow] hover:border-subtle focus:border-accent focus:ring-3 focus:ring-accent/15"
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
                            <p className="text-xs text-danger font-medium">{appleError}</p>
                          )}
                          <button
                            onClick={saveAppleCredentials}
                            disabled={!appleP8 || !appleKeyIdInput.trim() || !appleIssuerIdInput.trim() || appleSaving}
                            className={buttonClass({
                              variant: appleP8 && appleKeyIdInput.trim() && appleIssuerIdInput.trim() ? 'primary' : 'secondary',
                            })}
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
    </>
  );

  if (variant === 'section') return body;

  return (
    // Anchored to the top, so the header and tabs stay exactly where they are
    // when you switch tabs; the dialog only grows downward, up to a limit.
    <div className="fixed inset-0 z-[200] flex items-start justify-center px-4 pt-[max(1rem,8vh)]">
      {/* Blur backdrop as a sibling — NOT an ancestor of the dialog content, so
          backdrop-filter never becomes the containing block for fixed children. */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={handleClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="relative flex max-h-[min(42rem,calc(100dvh-2rem-8vh))] min-h-[min(30rem,calc(100dvh-2rem-8vh))] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-bg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3 sm:gap-5">
            <h2 className="shrink-0 text-base font-semibold text-fg">Settings</h2>
            <div role="tablist" className="flex items-center gap-0.5 rounded-lg border border-border bg-elevated p-0.5 dark:bg-bg">
              {(
                [
                  ['usage', 'Usage'],
                  ['connections', 'Connections'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={activeTab === id}
                  onClick={() => setActiveTab(id)}
                  className={cn(
                    'h-7 whitespace-nowrap rounded-md px-2.5 text-[13px] font-medium transition-[background-color,color,box-shadow] sm:px-3',
                    id === 'connections' && 'hidden sm:block',
                    activeTab === id ? 'bg-bg text-fg shadow-sm ring-1 ring-border-strong/50 dark:bg-soft dark:ring-border-strong' : 'text-muted hover:text-fg',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {/* The plan has one home: the Settings page. */}
            <a
              href="/account?tab=billing"
              {...(workspaceContext ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              className="hidden h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-muted transition-colors hover:bg-elevated hover:text-fg sm:inline-flex"
            >
              Plan and billing
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <button
              onClick={handleClose}
              aria-label="Close settings"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-fg"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-5 sm:px-6">
          {body}
          {/* A soft fade at the bottom edge signals that the list continues. */}
          <div aria-hidden="true" className="pointer-events-none sticky -bottom-5 -mb-5 h-10 bg-gradient-to-t from-bg to-transparent" />
        </div>
      </div>
    </div>
  );
}
