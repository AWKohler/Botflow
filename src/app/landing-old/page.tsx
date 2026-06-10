"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  SignedIn,
  SignedOut,
  SignInButton,
  UserButton,
  useUser,
} from "@clerk/nextjs";
import { cn } from "@/lib/utils";
import { ArrowUp, Plus, Smartphone, Laptop, Cog, ImagePlus, X as IconX, Monitor, KeyRound, ChevronDown, Database, ArrowRight, Check } from "lucide-react";
import { SettingsModal } from "@/components/settings/SettingsModal";
import { useToast } from "@/components/ui/toast";
import { ModelSelector } from "@/components/ui/ModelSelector";
import type { ModelId } from "@/lib/agent/models";
import { modelSupportsImages } from "@/lib/agent/models";
import { processImageForUpload } from "@/lib/image-processing";
import { checkDeviceSupport } from "@/lib/device";
import { Anthropic } from "@/components/icons/anthropic";
import { OpenAI } from "@/components/icons/openai";
import { Convex } from "@/components/icons/convex";
import {
  getNextProjectPlatform,
  getProjectPlatformLabel,
  getProjectPlatformShortLabel,
  isMobilePlatformsEnabled,
  isSwiftPlatformEnabled,
  isSandboxedWebPlatformEnabled,
  normalizeProjectPlatform,
  type ProjectPlatform,
} from "@/lib/project-platform";

interface LandingPendingImage {
  id: string;
  file: File;
  localUrl: string;
}

export default function Home() {
  const router = useRouter();
  const { isSignedIn } = useUser();
  const [prompt, setPrompt] = useState("");
  const [platform, setPlatform] = useState<ProjectPlatform>("web");
  const [model, setModel] = useState<ModelId>("fireworks-minimax-m2p7");
  const { toast } = useToast();
  const [hasOpenAIKey, setHasOpenAIKey] = useState<boolean | null>(null);
  const [hasAnthropicKey, setHasAnthropicKey] = useState<boolean | null>(null);
  const [hasClaudeOAuth, setHasClaudeOAuth] = useState<boolean | null>(null);
  const [hasMoonshotKey, setHasMoonshotKey] = useState<boolean | null>(null);
  const [hasCodexOAuth, setHasCodexOAuth] = useState<boolean | null>(null);
  const [hasFireworksKey, setHasFireworksKey] = useState<boolean | null>(null);
  const [hasGoogleKey, setHasGoogleKey] = useState<boolean | null>(null);
  const [userTier, setUserTier] = useState<'free' | 'pro' | 'max'>('free');
  const [hasConvexOAuth, setHasConvexOAuth] = useState<boolean | null>(null);
  const [convexBackendType, setConvexBackendType] = useState<'platform' | 'user'>('platform');
  const [showConvexSelector, setShowConvexSelector] = useState(false);
  const [convexConnecting, setConvexConnecting] = useState(false);
  const convexSelectorRef = useRef<HTMLDivElement>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsDefaultTab, setSettingsDefaultTab] = useState<'usage' | 'connections' | 'subscription'>('usage');
  const [showAuthDialog, setShowAuthDialog] = useState(false);
  // Stepped project-creation modal: null = hidden, 'convex' = connect step, 'name' = naming step
  const [projectStep, setProjectStep] = useState<null | 'convex' | 'name'>(null);
  const [projectQuotaLeft, setProjectQuotaLeft] = useState<number | null>(null);
  const [pendingImages, setPendingImages] = useState<LandingPendingImage[]>([]);
  const [showPlusPopover, setShowPlusPopover] = useState(false);
  const plusButtonRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [projectName, setProjectName] = useState("");
  const [pendingParams, setPendingParams] = useState<URLSearchParams | null>(
    null,
  );
  const PENDING_PARAMS_KEY = "huggable_pending_start_params";
  const PENDING_NAME_KEY = "huggable_pending_project_name";
  const allowedModels = new Set([
    "gpt-5.3-codex",
    "gpt-5.4",
    "gpt-5.2", // legacy compat
    "claude-sonnet-4-6",
    "claude-opus-4-8",
    "claude-opus-4-7", // legacy compat
    "claude-sonnet-4.6", // legacy compat
    "claude-opus-4.7", // legacy compat
    "claude-opus-4.6", // legacy compat
    "fireworks-minimax-m2p7",
    "fireworks-glm-5p1",
    "fireworks-glm-5", // legacy compat
    "fireworks-kimi-k2p6",
    "gemini-3.1-pro-preview",
  ]);

  // Models served via platform keys — don't require BYOK at project start
  const serverKeyModels = new Set([
    "fireworks-minimax-m2p7",
    "fireworks-glm-5p1",
    "fireworks-kimi-k2p6",
    "gpt-5.3-codex",
    "gpt-5.4",
    "claude-sonnet-4-6",
    "claude-opus-4-8",
    "claude-opus-4-7", // legacy compat
    "gemini-3.1-pro-preview",
  ]);
  const landingSignInModalAppearance = {
    elements: {
      modalContent: "!max-h-[90vh] !overflow-hidden",
      cardBox:
        "!max-h-[90vh] !overflow-y-auto !rounded-2xl !border !border-[var(--sand-border)] !bg-[var(--color-surface)] !shadow-xl",
      card: "!h-auto !max-h-none !overflow-visible !bg-transparent !border-0 !shadow-none !pb-4",
      footer: "!mt-2 !pt-2 !bg-transparent",
    },
  } as const;

  const canSend = useMemo(() => prompt.trim().length > 0 || pendingImages.length > 0, [prompt, pendingImages.length]);

  const providerAccess = useMemo(() => ({
    openai: hasCodexOAuth || hasOpenAIKey || null,
    // For server-key models BYOK isn't required —
    // treat provider as null (unknown/not checked) rather than false (blocked).
    // The tier gate handles access control for those models.
    anthropic: hasClaudeOAuth || hasAnthropicKey || null,
    fireworks: hasFireworksKey === true ? true : null,
    google: hasGoogleKey === true ? true : null,
  }), [hasCodexOAuth, hasOpenAIKey, hasClaudeOAuth, hasAnthropicKey, hasFireworksKey, hasGoogleKey]);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;
    const newImages = await Promise.all(files.map(async (file) => {
      const processed = await processImageForUpload(file);
      return { id: crypto.randomUUID(), file: processed, localUrl: URL.createObjectURL(processed) };
    }));
    setPendingImages(prev => [...prev, ...newImages]);
  }, []);

  const handleRemoveImage = useCallback((id: string) => {
    setPendingImages(prev => {
      const img = prev.find(i => i.id === id);
      if (img) URL.revokeObjectURL(img.localUrl);
      return prev.filter(i => i.id !== id);
    });
  }, []);

  // Auto-grow textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 300) + 'px';
  }, [prompt]);

  // Close plus popover on outside click
  useEffect(() => {
    if (!showPlusPopover) return;
    const handler = (e: MouseEvent) => {
      if (plusButtonRef.current && !plusButtonRef.current.contains(e.target as Node)) {
        setShowPlusPopover(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showPlusPopover]);

  const ensureModelKeyPresent = () => {
    // Server-key models don't require BYOK — platform provides them
    if (serverKeyModels.has(model)) return true;

    const hasAnthropicCreds = hasAnthropicKey || hasClaudeOAuth;
    const hasOpenAICreds = hasCodexOAuth || hasOpenAIKey;
    const keyChecks: Record<string, { hasKey: boolean | null; provider: string }> = {
      "gpt-5.3-codex": { hasKey: hasOpenAICreds, provider: "OpenAI" },
    };
    const check = keyChecks[model];
    if (check?.hasKey === false) {
      toast({
        title: "Missing API key",
        description: `Please add your ${check.provider} API key in Settings.`,
      });
      return false;
    }
    return true;
  };

  const start = (authed: boolean) => {
    const device = checkDeviceSupport();
    if (!device.supported) {
      toast({
        title: "Device not supported",
        description: device.reason ?? "Botflow is a desktop-only platform. Please use a desktop browser.",
      });
      return;
    }

    const params = new URLSearchParams();
    if (prompt.trim()) params.set("prompt", prompt.trim());
    params.set("visibility", "public");
    params.set("platform", platform);
    params.set("model", model);
    const defaultName = prompt.trim()
      ? prompt.trim().slice(0, 48)
      : "New Project";
    params.set("name", defaultName);

    setPendingParams(params);
    setProjectName(defaultName);
    if (typeof window !== "undefined") {
      localStorage.setItem(PENDING_PARAMS_KEY, params.toString());
      localStorage.setItem(PENDING_NAME_KEY, defaultName);
    }

    if (!authed) {
      setShowAuthDialog(true);
      return;
    }

    // Determine the first step in the project-creation modal
    const cloudForAll = process.env.NEXT_PUBLIC_ALLOW_CLOUD_CONVEX_FOR_ALL === 'true';
    const needsConvexStep = ((!cloudForAll && userTier === 'free') || convexBackendType === 'user') && !hasConvexOAuth;
    setProjectStep(needsConvexStep ? 'convex' : 'name');
  };

  const handleCreateProject = async () => {
    if (!pendingParams) return;
    if (!ensureModelKeyPresent()) return;
    const params = new URLSearchParams(pendingParams);
    const chosenName = projectName.trim()
      ? projectName.trim().slice(0, 48)
      : "New Project";
    params.set("name", chosenName);
    setProjectStep(null);
    setPendingParams(null);
    if (typeof window !== "undefined") {
      localStorage.removeItem(PENDING_PARAMS_KEY);
      localStorage.removeItem(PENDING_NAME_KEY);
    }
    if (convexBackendType === 'user' || params.get('backendType') === 'user') params.set('backendType', 'user');
    // Serialize pending images to sessionStorage for AgentPanel to pick up
    if (pendingImages.length > 0) {
      try {
        const imageParts = await Promise.all(
          pendingImages.map((img) =>
            new Promise<{ type: 'file'; mediaType: string; url: string; filename: string }>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve({
                type: 'file',
                mediaType: img.file.type || 'image/jpeg',
                url: reader.result as string,
                filename: img.file.name,
              });
              reader.onerror = reject;
              reader.readAsDataURL(img.file);
            })
          )
        );
        sessionStorage.setItem('botflow_pending_images', JSON.stringify(imageParts));
      } catch (err) {
        console.error('Failed to serialize images for workspace:', err);
      }
      pendingImages.forEach(img => URL.revokeObjectURL(img.localUrl));
      setPendingImages([]);
    }
    router.push(`/start?${params.toString()}`);
  };

  const closeAuthDialog = () => {
    setShowAuthDialog(false);
    setPendingParams(null);
    if (typeof window !== "undefined") {
      localStorage.removeItem(PENDING_PARAMS_KEY);
      localStorage.removeItem(PENDING_NAME_KEY);
    }
  };

  const closeProjectModal = () => {
    setProjectStep(null);
    setPendingParams(null);
    if (typeof window !== "undefined") {
      localStorage.removeItem(PENDING_PARAMS_KEY);
      localStorage.removeItem(PENDING_NAME_KEY);
    }
  };

  const saveBackendPreference = useCallback(async (pref: 'platform' | 'user') => {
    setConvexBackendType(pref);
    try {
      await fetch('/api/user-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ convexBackendPreference: pref }),
      });
    } catch {}
  }, []);

  const fetchUserSettings = useCallback(async () => {
    try {
      const [settingsRes, budgetRes] = await Promise.all([
        fetch("/api/user-settings"),
        fetch("/api/usage/budget"),
      ]);
      if (settingsRes.ok) {
        const data = await settingsRes.json();
        setHasOpenAIKey(Boolean(data?.hasOpenAIKey));
        setHasAnthropicKey(Boolean(data?.hasAnthropicKey));
        setHasClaudeOAuth(Boolean(data?.hasClaudeOAuth));
        setHasCodexOAuth(Boolean(data?.hasCodexOAuth));
        setHasMoonshotKey(Boolean(data?.hasMoonshotKey));
        setHasFireworksKey(Boolean(data?.hasFireworksKey));
        setHasGoogleKey(Boolean(data?.hasGoogleKey));
        setHasConvexOAuth(Boolean(data?.hasConvexOAuth));
        // Server-authoritative backend type preference
        if (data?.convexBackendPreference === 'user' && data?.hasConvexOAuth) {
          setConvexBackendType('user');
        } else if (data?.convexBackendPreference === 'platform') {
          setConvexBackendType('platform');
        } else if (!data?.hasConvexOAuth) {
          setConvexBackendType('platform');
        }
      }
      if (budgetRes.ok) {
        const data = await budgetRes.json();
        if (data?.tier === 'pro' || data?.tier === 'max') {
          setUserTier(data.tier as 'pro' | 'max');
        }
        // Track remaining managed-convex quota for the selector
        if (typeof data?.convexProjectsLeft === 'number') {
          setProjectQuotaLeft(data.convexProjectsLeft);
        }
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (!isSignedIn) {
      setHasOpenAIKey(null);
      setHasAnthropicKey(null);
      setHasMoonshotKey(null);
      setHasFireworksKey(null);
      setHasConvexOAuth(null);
      return;
    }
    void fetchUserSettings();
  }, [isSignedIn, fetchUserSettings]);

  // Refresh provider access when settings modal closes
  useEffect(() => {
    const handler = () => { if (isSignedIn) void fetchUserSettings(); };
    window.addEventListener('settings-closed', handler);
    return () => window.removeEventListener('settings-closed', handler);
  }, [isSignedIn, fetchUserSettings]);

  // Handle convex_connected URL param (redirect back from Convex OAuth)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    // Handle error redirects from /start
    const errorParam = params.get('error');
    if (errorParam) {
      params.delete('error');
      const newSearch = params.toString();
      window.history.replaceState({}, '', newSearch ? `/?${newSearch}` : '/');
      const errorMessages: Record<string, { title: string; description: string }> = {
        convex_not_connected: { title: 'Convex not connected', description: 'Please connect your Convex account before creating a BYOC project.' },
        convex_provision_failed: { title: 'Convex provisioning failed', description: 'Failed to create a Convex backend in your account. Please try again or check your Convex dashboard.' },
        convex_quota: { title: 'Convex project limit reached', description: 'Your Convex account has reached its project quota. Delete unused projects at dashboard.convex.dev or upgrade your Convex plan.' },
      };
      const errMsg = errorMessages[errorParam] ?? { title: 'Error', description: 'Something went wrong creating your project.' };
      toast(errMsg);
    }

    if (params.get('convex_connected') === '1') {
      setHasConvexOAuth(true);
      // Clean URL
      params.delete('convex_connected');
      const newSearch = params.toString();
      window.history.replaceState({}, '', newSearch ? `/?${newSearch}` : '/');
      // User came back from Convex OAuth — they chose BYOC
      void saveBackendPreference('user');
      // If there are pending params (user was mid-flow), go straight to name step.
      // Bake backendType=user into the stored params so handleCreateProject picks it
      // up regardless of React state timing.
      const stored = localStorage.getItem(PENDING_PARAMS_KEY);
      if (stored) {
        const restoredParams = new URLSearchParams(stored);
        restoredParams.set('backendType', 'user');
        localStorage.setItem(PENDING_PARAMS_KEY, restoredParams.toString());
        const storedName = localStorage.getItem(PENDING_NAME_KEY) ?? 'New Project';
        setPendingParams(restoredParams);
        setProjectName(storedName);
        setProjectStep('name');
      }
    }
  }, []); // run once on mount

  // Close Convex selector on outside click
  useEffect(() => {
    if (!showConvexSelector) return;
    const handler = (e: MouseEvent) => {
      if (convexSelectorRef.current && !convexSelectorRef.current.contains(e.target as Node)) {
        setShowConvexSelector(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showConvexSelector]);

  const handleConnectConvex = async () => {
    setConvexConnecting(true);
    try {
      const res = await fetch('/api/oauth/convex/start?return_to=/');
      const data = await res.json();
      if (data.authUrl) {
        window.location.href = data.authUrl;
      }
    } catch {
      toast({ title: 'Error', description: 'Failed to start Convex authentication.' });
    } finally {
      setConvexConnecting(false);
    }
  };

  useEffect(() => {
    if (!pendingParams && typeof window !== "undefined") {
      const storedParams = localStorage.getItem(PENDING_PARAMS_KEY);
      const storedName = localStorage.getItem(PENDING_NAME_KEY);
      if (storedParams) {
        setPendingParams(new URLSearchParams(storedParams));
        const storedParamsObj = new URLSearchParams(storedParams);
        const storedModel = storedParamsObj.get("model");
        const storedPlatform = storedParamsObj.get("platform");
        if (storedModel && allowedModels.has(storedModel)) {
          // Map legacy model IDs
          const resolved = storedModel === 'gpt-5.2' ? 'gpt-5.3-codex' : storedModel;
          setModel(resolved as ModelId);
        }
        if (
          storedPlatform === "web" ||
          (storedPlatform === "swift" && isSwiftPlatformEnabled()) ||
          (storedPlatform === "sandboxed-web" && isSandboxedWebPlatformEnabled()) ||
          ((storedPlatform === "mobile" || storedPlatform === "multiplatform") &&
            isMobilePlatformsEnabled())
        ) {
          setPlatform(normalizeProjectPlatform(storedPlatform));
        }
        if (storedName) setProjectName(storedName);
      }
    }
    if (isSignedIn && pendingParams) {
      setShowAuthDialog(false);
      // Determine if Convex step is needed before jumping to name step
      // Note: userTier/hasConvexOAuth may not be loaded yet — the name step
      // is a safe default; the user can always go back if Convex is needed.
      const cloudForAll = process.env.NEXT_PUBLIC_ALLOW_CLOUD_CONVEX_FOR_ALL === 'true';
      const needsConvex = ((!cloudForAll && userTier === 'free') || convexBackendType === 'user') && !hasConvexOAuth;
      setProjectStep(needsConvex ? 'convex' : 'name');
    }
  }, [isSignedIn, pendingParams, userTier, convexBackendType, hasConvexOAuth]);

  return (
    <>
      <div className="antialiased text-[var(--sand-text)] bg-[var(--sand-bg)] min-h-screen flex flex-col">
        {/* Background gradient */}
        <div className="relative isolate overflow-hidden flex flex-1 flex-col">
          <div className="pointer-events-none absolute inset-0 -z-10 landing-gradient" />

          {/* Nav */}
          <header className="relative">
            <div className="mx-auto max-w-7xl px-4 sm:px-6 py-4 sm:py-5">
              <div className="flex items-center justify-between md:grid md:grid-cols-3">
                <a className="flex items-center gap-2.5" href="#">
                  <img
                    src="/brand/botflow-glyph.svg"
                    alt=""
                    className="h-9 w-9"
                  />
                  <img
                    src="/brand/botflow-wordmark.svg"
                    alt="Botflow"
                    className="h-6 w-auto botflow-wordmark-invert"
                  />
                </a>

                <nav className="hidden md:flex items-center justify-center gap-7 text-sm text-[var(--sand-text)]">
                  <SignedIn>
                    <a
                      className="font-medium hover:text-[var(--sand-text)] transition"
                      href="/projects"
                    >
                      My Projects
                    </a>
                  </SignedIn>
                  <a
                    className="font-semibold hover:text-[var(--sand-text)] transition"
                    href="/pricing"
                  >
                    Pricing
                  </a>
                </nav>

                <div className="flex items-center justify-end gap-2">
                  <SignedOut>
                    <Link
                      href="/sign-in"
                      className="hidden sm:inline-flex items-center rounded-xl border border-border bg-elevated px-3.5 py-2 text-sm font-medium text-[var(--sand-text)] shadow-sm hover:bg-[var(--sand-surface)] transition"
                    >
                      Log in
                    </Link>
                    <Link
                      href="/sign-up"
                      className="inline-flex items-center rounded-xl bg-black px-4 py-2 text-sm font-medium text-white shadow-[0_1px_0_rgba(255,255,255,0.2)_inset,0_8px_20px_-8px_rgba(0,0,0,0.5)] hover:opacity-95 transition"
                    >
                      Get started
                    </Link>
                  </SignedOut>
                  <SignedIn>
                    <button
                      onClick={() => { setSettingsDefaultTab('usage'); setShowSettings(true); }}
                      className="inline-flex items-center justify-center rounded-xl border border-border bg-elevated px-2.5 py-2 text-sm text-[var(--sand-text)] shadow-sm hover:bg-[var(--sand-surface)] transition"
                      title="Settings"
                      aria-label="Settings"
                    >
                      <Cog className="h-4 w-4" />
                    </button>
                    <UserButton afterSignOutUrl="/" />
                  </SignedIn>
                </div>
              </div>
            </div>
          </header>

          {/* Hero */}
          <section className="relative flex flex-1 items-center justify-center">
            <div className="relative flex w-full flex-col items-center justify-center overflow-hidden px-6 py-[20vh] pb-[24vh] 2xl:py-48 2xl:pb-52">
              <div className="w-full max-w-3xl flex flex-col items-center">

              <h1 className="text-3xl sm:text-5xl md:text-6xl lg:text-7xl font-semibold tracking-tight text-[var(--sand-text)] text-center leading-tight">
                Build something
                <span className="inline-flex mx-1 sm:mx-2 translate-y-0.5 sm:translate-y-1 align-middle">
                  <img
                    src="/brand/botflow-glyph.svg"
                    alt=""
                    className="h-8 w-8 sm:h-12 sm:w-12"
                  />
                </span>
              </h1>
              <p className="text-center text-[var(--sand-text)] text-sm sm:text-lg leading-none">
                Create apps and websites by chatting with AI.
              </p>
              {/* <p className="text-center text-[var(--sand-text)] text-sm sm:text-lg leading-none -mt-2">
                Backend by{" "}
                <span className="inline-flex items-center align-middle -ml-3" style={{ height: "2.8em" }}>
                  <Convex className="h-full w-auto" />
                </span>
              </p> */}

              {/* Prompt box */}
              <div className="w-full mt-4 sm:mt-5">
                <div className="flex flex-col rounded-2xl sm:rounded-3xl border border-border bg-elevated backdrop-blur-sm shadow-[0_2px_0_rgba(0,0,0,0.02),0_20px_60px_-20px_rgba(0,0,0,0.2)]">

                  {/* Textarea — grows but never overlaps the footer */}
                  <textarea
                    ref={textareaRef}
                    placeholder="Ask Botflow to create a web app that..."
                    className="w-full bg-transparent px-4 sm:px-5 pt-3 sm:pt-4 pb-2 text-sm sm:text-lg text-[var(--sand-text)] placeholder-neutral-400 outline-none resize-none overflow-y-auto modern-scrollbar"
                    aria-label="Generation prompt"
                    style={{ minHeight: 96, maxHeight: 300 }}
                    maxLength={30000}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                  />

                  {/* Hidden file input */}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,.jpg,.jpeg,image/png,.png,image/webp,.webp"
                    multiple
                    className="hidden"
                    onChange={handleFileSelect}
                  />

                  {/* Footer bar */}
                  <div className="flex flex-col gap-1 px-2.5 sm:px-3 pb-2.5 sm:pb-3 pt-1">
                    {/* Thumbnail strip */}
                    {pendingImages.length > 0 && (
                      <div className="flex gap-2 overflow-x-auto modern-scrollbar pb-1">
                        {pendingImages.map(img => (
                          <div key={img.id} className="relative group shrink-0">
                            <div className="w-10 h-10 rounded-lg border border-border overflow-hidden">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={img.localUrl} alt={img.file.name} className="w-full h-full object-cover" />
                            </div>
                            <button
                              type="button"
                              onClick={() => handleRemoveImage(img.id)}
                              className="absolute -top-1.5 -right-1.5 flex items-center justify-center size-4 rounded-full bg-elevated border border-border text-neutral-500 hover:text-neutral-900 opacity-0 group-hover:opacity-100 transition-opacity"
                              aria-label="Remove image"
                            >
                              <IconX size={10} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Controls + send row */}
                    <div className="flex items-center justify-between gap-1.5 sm:gap-2">
                      {/* Left controls */}
                      <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
                        {/* + button with popover */}
                        <div ref={plusButtonRef} className="relative shrink-0">
                          <button
                            type="button"
                            onClick={() => setShowPlusPopover(v => !v)}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border bg-elevated shadow-sm shadow-soft hover:border-transparent hover:bg-accent/15 transition"
                            aria-label="Attach"
                          >
                            <Plus className="h-4 w-4 text-[var(--sand-text)]" />
                          </button>
                          {showPlusPopover && (
                            <div className="absolute bottom-full mb-2 left-0 w-44 rounded-xl border border-border bg-surface shadow-lg overflow-hidden z-20">
                              <button
                                type="button"
                                onClick={() => { setShowPlusPopover(false); fileInputRef.current?.click(); }}
                                disabled={!modelSupportsImages(model)}
                                className={cn(
                                  "flex w-full items-center gap-2.5 px-3 py-2 text-sm transition",
                                  modelSupportsImages(model)
                                    ? "text-[var(--sand-text)] hover:bg-elevated cursor-pointer"
                                    : "text-neutral-400 cursor-not-allowed"
                                )}
                              >
                                <ImagePlus size={15} className="shrink-0" />
                                <span>Attach image</span>
                              </button>
                            </div>
                          )}
                        </div>
                        {(isSwiftPlatformEnabled() || isSandboxedWebPlatformEnabled() || isMobilePlatformsEnabled()) && (
                          <button
                            type="button"
                            onClick={() => setPlatform(getNextProjectPlatform(platform))}
                            className="shrink-0 inline-flex items-center gap-1.5 sm:gap-2 rounded-full border border-border bg-elevated px-2.5 sm:px-3 py-1.5 text-xs sm:text-sm font-medium text-[var(--sand-text)] shadow-sm shadow-soft hover:border-transparent hover:bg-accent/15 transition"
                            title="Toggle platform"
                          >
                            {platform === "mobile" ? (
                              <Smartphone className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                            ) : platform === "multiplatform" ? (
                              <Monitor className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                            ) : (
                              <Laptop className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                            )}
                            <span className="hidden sm:inline">
                              {platform === "mobile"
                                ? "Mobile App (Experimental)"
                                : getProjectPlatformLabel(platform)}
                            </span>
                            <span className="sm:hidden">
                              {getProjectPlatformShortLabel(platform)}
                            </span>
                          </button>
                        )}
                        <ModelSelector
                          value={model}
                          onChange={setModel}
                          providerAccess={providerAccess}
                          userTier={userTier}
                          size="md"
                          onTierLocked={() => {
                            toast({
                              title: "Plan required",
                              description: "This model requires a Pro or Max plan. Upgrade or add your own API key in Settings.",
                            });
                          }}
                        />
                        {isSignedIn && (userTier === 'pro' || userTier === 'max' || process.env.NEXT_PUBLIC_ALLOW_CLOUD_CONVEX_FOR_ALL === 'true') && (
                          <div ref={convexSelectorRef} className="relative shrink-0">
                            <button
                              type="button"
                              onClick={() => setShowConvexSelector(v => !v)}
                              className="shrink-0 inline-flex items-center gap-1.5 sm:gap-2 rounded-full border border-border bg-elevated px-2.5 sm:px-3 py-1.5 text-xs sm:text-sm font-medium text-[var(--sand-text)] shadow-sm shadow-soft hover:border-transparent hover:bg-accent/15 transition"
                              title="Backend type"
                            >
                              {convexBackendType === 'platform' ? (
                                <img src="/convex-color.svg" className="h-3.5 w-3.5" alt="" />
                              ) : (
                                <KeyRound className="h-3.5 w-3.5" />
                              )}
                              <span className="hidden sm:inline">{convexBackendType === 'platform' ? 'Managed' : 'Your Convex'}</span>
                              <ChevronDown className="h-3 w-3 opacity-60" />
                            </button>
                            {showConvexSelector && (
                              <div className="absolute bottom-full mb-2 left-0 w-60 rounded-xl border border-border bg-surface shadow-lg overflow-hidden z-20">
                                <button
                                  type="button"
                                  onClick={() => { void saveBackendPreference('platform'); setShowConvexSelector(false); }}
                                  className={cn(
                                    "flex w-full items-start gap-2.5 px-3 py-2.5 text-sm transition text-left",
                                    convexBackendType === 'platform' ? "bg-elevated" : "hover:bg-elevated"
                                  )}
                                >
                                  <img src="/convex-color.svg" className="h-4 w-4 mt-0.5 shrink-0" alt="" />
                                  <div>
                                    <div className="font-medium text-[var(--sand-text)]">Botflow Managed</div>
                                    <div className="text-xs text-neutral-400 mt-0.5">We handle infrastructure &amp; scaling</div>
                                  </div>
                                  {convexBackendType === 'platform' && <Check className="h-4 w-4 text-neutral-900 ml-auto mt-0.5 shrink-0" />}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => { void saveBackendPreference('user'); setShowConvexSelector(false); }}
                                  className={cn(
                                    "flex w-full items-start gap-2.5 px-3 py-2.5 text-sm transition text-left border-t border-border",
                                    convexBackendType === 'user' ? "bg-elevated" : "hover:bg-elevated"
                                  )}
                                >
                                  <KeyRound className="h-4 w-4 mt-0.5 shrink-0 text-[var(--sand-text)]" />
                                  <div>
                                    <div className="font-medium text-[var(--sand-text)]">Bring Your Own Convex</div>
                                    <div className="text-xs text-neutral-400 mt-0.5">Will require authentication</div>
                                  </div>
                                  {convexBackendType === 'user' && <Check className="h-4 w-4 text-neutral-900 ml-auto mt-0.5 shrink-0" />}
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Send button */}
                      <SignedIn>
                        <button
                          onClick={() => start(true)}
                          disabled={!canSend}
                          className={cn(
                            "shrink-0 inline-flex h-9 w-9 items-center justify-center rounded-full bg-neutral-900 text-white shadow-md transition",
                            !canSend ? "opacity-50 cursor-not-allowed" : "hover:opacity-90",
                          )}
                        >
                          <ArrowUp className="h-5 w-5" />
                        </button>
                      </SignedIn>
                      <SignedOut>
                        <button
                          onClick={() => start(false)}
                          className="shrink-0 inline-flex h-9 w-9 items-center justify-center rounded-full bg-neutral-900 text-white shadow-md hover:opacity-90 transition"
                        >
                          <ArrowUp className="h-5 w-5" />
                        </button>
                      </SignedOut>
                    </div>
                  </div>
                </div>
              </div>

              {/* Suggestion pills */}
              {/* <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                {[
                  "A SaaS dashboard with auth",
                  "A real-time chat app",
                  "A portfolio website",
                  "A todo app with a backend",
                ].map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => setPrompt(suggestion)}
                    className="rounded-full border border-border bg-elevated px-3.5 py-1.5 text-xs sm:text-sm text-[var(--sand-text)] shadow-sm hover:bg-[var(--sand-surface)] transition"
                  >
                    {suggestion}
                  </button>
                ))}
              </div> */}

              {/* OAuth provider pills */}
              <div className="mt-1 sm:mt-2 flex flex-col items-center gap-2">
                {/* <p className="text-xs text-neutral-400">
                  Use Botflow with your Claude or ChatGPT plan
                </p> */}
                <div className="flex items-center justify-center gap-1.5 sm:gap-2 mt-2">
                  <SignedOut>
                    {process.env.NEXT_PUBLIC_ANTHROPIC_OAUTH_ENABLED === 'true' && (
                      <Link
                        href="/sign-up"
                        className="whitespace-nowrap inline-flex items-center gap-1.5 sm:gap-2 rounded-full border border-border bg-elevated px-2.5 sm:px-3.5 py-1.5 text-xs sm:text-sm font-medium text-[var(--sand-text)] shadow-sm hover:bg-[var(--sand-surface)] transition"
                      >
                        <Anthropic className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0" />
                        Sign in with Claude
                      </Link>
                    )}
                    <Link
                      href="/sign-up"
                      className="whitespace-nowrap inline-flex items-center gap-1.5 sm:gap-2 rounded-full border border-border bg-elevated px-2.5 sm:px-3.5 py-1.5 text-xs sm:text-sm font-medium text-[var(--sand-text)] shadow-sm hover:bg-[var(--sand-surface)] transition"
                    >
                      <OpenAI className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0" />
                      Sign in with ChatGPT
                    </Link>
                  </SignedOut>
                  <SignedIn>
                    {process.env.NEXT_PUBLIC_ANTHROPIC_OAUTH_ENABLED === 'true' && (
                      <button
                        type="button"
                        onClick={() => { setSettingsDefaultTab('connections'); setShowSettings(true); }}
                        className="whitespace-nowrap inline-flex items-center gap-1.5 sm:gap-2 rounded-full border border-border bg-elevated px-2.5 sm:px-3.5 py-1.5 text-xs sm:text-sm font-medium text-[var(--sand-text)] shadow-sm hover:bg-[var(--sand-surface)] transition"
                      >
                        <Anthropic className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0" />
                        Sign in with Claude
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => { setSettingsDefaultTab('connections'); setShowSettings(true); }}
                      className="whitespace-nowrap inline-flex items-center gap-1.5 sm:gap-2 rounded-full border border-border bg-elevated px-2.5 sm:px-3.5 py-1.5 text-xs sm:text-sm font-medium text-[var(--sand-text)] shadow-sm hover:bg-[var(--sand-surface)] transition"
                    >
                      <OpenAI className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0" />
                      Sign in with ChatGPT
                    </button>
                  </SignedIn>
                </div>
              </div>

              <p className="text-center text-[var(--sand-text)] text-sm sm:text-lg leading-none mt-2 opacity-75">
                Backend by{" "}
                <span className="inline-flex items-center align-middle -ml-3" style={{ height: "2.8em" }}>
                  <Convex className="h-full w-auto opacity-75" />
                </span>
              </p>


              </div>{/* end max-w-3xl */}
            </div>{/* end hero inner */}
          </section>

          {/* Footer */}
          <footer className="relative mt-auto">
            <div className="mx-auto max-w-7xl px-6 py-4 text-sm text-[var(--sand-text)]">
              <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
                <p>© 2026 Botflow</p>
                <div className="flex items-center gap-6">
                  <a className="hover:text-[var(--sand-text)]" href="#">
                    Privacy
                  </a>
                  <a className="hover:text-[var(--sand-text)]" href="#">
                    Terms
                  </a>
                  <a className="hover:text-[var(--sand-text)]" href="#">
                    Contact
                  </a>
                </div>
              </div>
            </div>
          </footer>
        </div>
      </div>

      <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} defaultTab={settingsDefaultTab} />

      {showAuthDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4">
          <div className="w-full max-w-md rounded-2xl border border-border bg-bg p-6 shadow-xl">
            <h2 className="text-xl font-semibold text-foreground">
              Sign in to start building
            </h2>
            <p className="mt-2 text-sm text-muted">
              Sign in or sign up to create your project workspace. You&apos;ll
              be able to name it on the next step.
            </p>
            <div className="mt-6 flex flex-col sm:flex-row gap-3">
              <SignInButton
                mode="modal"
                appearance={landingSignInModalAppearance}
              >
                <button className="inline-flex flex-1 items-center justify-center rounded-xl bg-foreground px-4 py-2.5 text-sm font-medium text-bg shadow hover:opacity-90 transition">
                  Sign in / Sign up
                </button>
              </SignInButton>
              <button
                onClick={closeAuthDialog}
                className="inline-flex flex-1 items-center justify-center rounded-xl border border-border bg-elevated px-4 py-2.5 text-sm font-medium text-muted shadow-sm hover:bg-surface transition"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Stepped project-creation modal (Convex → Name) ── */}
      {projectStep !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4">
          <div className="w-full max-w-md rounded-2xl border border-border bg-bg shadow-xl overflow-hidden">

            {/* ── Step: Convex backend ── */}
            {projectStep === 'convex' && (() => {
              const cloudForAll = process.env.NEXT_PUBLIC_ALLOW_CLOUD_CONVEX_FOR_ALL === 'true';
              const isPaid = userTier === 'pro' || userTier === 'max' || cloudForAll;
              const managedQuotaHit = isPaid && projectQuotaLeft !== null && projectQuotaLeft <= 0;
              return (
                <>
                  <div className="px-6 pt-6 pb-3">
                    <h2 className="text-xl font-semibold text-foreground">Connect your backend</h2>
                    <p className="mt-1.5 text-sm text-muted">
                      {isPaid
                        ? 'Choose how to host the Convex backend for this project.'
                        : 'Botflow uses Convex for your backend. Connect your free Convex account to continue.'}
                    </p>
                  </div>

                  <div className="px-6 pb-6 space-y-3">
                    {/* BYO option */}
                    <div className={cn(
                      "relative rounded-xl border-2 p-4 transition-all",
                      hasConvexOAuth ? "border-green-500/60 bg-green-500/5" : "border-foreground/20 bg-soft"
                    )}>
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-foreground">
                          <KeyRound className="h-4 w-4 text-bg" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-foreground">Your Convex Account</span>
                            {hasConvexOAuth && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-xs font-medium text-green-700 border border-green-500/30">
                                <Check className="h-3 w-3" /> Connected
                              </span>
                            )}
                          </div>
                          <p className="mt-0.5 text-xs text-muted">
                            Connect your free Convex account — projects live in your dashboard, no lock-in.
                          </p>
                          {!hasConvexOAuth && (
                            <a
                              href="https://dashboard.convex.dev"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-xs text-muted hover:text-foreground mt-1"
                            >
                              Don&apos;t have an account? Sign up free at convex.dev
                              <ArrowRight className="h-3 w-3" />
                            </a>
                          )}
                        </div>
                      </div>

                      {!hasConvexOAuth && (
                        <button
                          onClick={handleConnectConvex}
                          disabled={convexConnecting}
                          className="mt-3 w-full inline-flex items-center justify-center gap-2 rounded-lg bg-foreground px-4 py-2.5 text-sm font-medium text-bg shadow hover:opacity-90 disabled:opacity-60 transition"
                        >
                          {convexConnecting ? (
                            <><div className="h-4 w-4 animate-spin rounded-full border-2 border-bg/30 border-t-bg" /> Connecting&hellip;</>
                          ) : (
                            'Sign in with Convex'
                          )}
                        </button>
                      )}
                    </div>

                    {/* Platform-managed option */}
                    {isPaid ? (
                      /* Paid users: selectable option (greyed only if quota hit) */
                      <button
                        type="button"
                        disabled={managedQuotaHit}
                        onClick={() => {
                          void saveBackendPreference('platform');
                          setProjectStep('name');
                        }}
                        className={cn(
                          "relative w-full rounded-xl border p-4 text-left transition-all",
                          managedQuotaHit
                            ? "border-border bg-soft opacity-50 cursor-not-allowed"
                            : "border-border bg-soft hover:border-foreground/30 hover:bg-elevated cursor-pointer"
                        )}
                      >
                        <div className="flex items-start gap-3">
                          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-elevated">
                            <img src="/convex-color.svg" className="h-4 w-4" alt="" />
                          </div>
                          <div>
                            <span className="text-sm font-semibold text-foreground">Botflow Managed</span>
                            <span className="ml-1.5 text-xs text-muted font-normal">(Recommended)</span>
                            <p className="mt-0.5 text-xs text-muted">
                              We handle the infrastructure, backups, and scaling. Instant setup.
                            </p>
                            {managedQuotaHit && (
                              <p className="mt-1 text-xs text-amber-600 font-medium">
                                You&apos;ve reached your managed project limit. Delete a project or upgrade your plan.
                              </p>
                            )}
                          </div>
                        </div>
                      </button>
                    ) : (
                      /* Free users: greyed out with Upgrade badge */
                      <div className="relative rounded-xl border border-border bg-soft p-4 opacity-50 cursor-not-allowed">
                        <div className="absolute -top-2.5 right-3">
                          <span className="inline-flex items-center rounded-full bg-foreground px-2.5 py-0.5 text-xs font-semibold text-bg">
                            Upgrade to Pro
                          </span>
                        </div>
                        <div className="flex items-start gap-3">
                          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-elevated">
                            <Database className="h-4 w-4 text-muted" />
                          </div>
                          <div>
                            <span className="text-sm font-semibold text-muted">Botflow Managed (Recommended)</span>
                            <p className="mt-0.5 text-xs text-muted">
                              We handle the infrastructure, backups, and scaling. Instant setup.
                            </p>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Footer buttons */}
                    <div className="flex gap-3 pt-1">
                      {hasConvexOAuth && (
                        <button
                          onClick={() => {
                            void saveBackendPreference('user');
                            setProjectStep('name');
                          }}
                          className="flex-1 inline-flex items-center justify-center rounded-xl bg-foreground px-4 py-2.5 text-sm font-medium text-bg shadow hover:opacity-90 transition"
                        >
                          Continue
                          <ArrowRight className="ml-1.5 h-4 w-4" />
                        </button>
                      )}
                      <button
                        onClick={closeProjectModal}
                        className={cn(
                          "inline-flex items-center justify-center rounded-xl border border-border bg-elevated px-4 py-2.5 text-sm font-medium text-muted shadow-sm hover:bg-surface transition",
                          hasConvexOAuth ? "" : "flex-1"
                        )}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </>
              );
            })()}

            {/* ── Step: Project name ── */}
            {projectStep === 'name' && (
              <div className="p-6">
                <h2 className="text-xl font-semibold text-foreground">
                  Name your project
                </h2>
                <p className="mt-2 text-sm text-muted">
                  Give your project a short name so it&apos;s easy to find later.
                </p>
                <div className="mt-4">
                  <input
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleCreateProject();
                    }}
                    placeholder="My new project"
                    className="w-full rounded-xl border border-border bg-bg px-3.5 py-2.5 text-sm text-foreground shadow-sm outline-none focus:ring-2 focus:ring-foreground/10"
                    autoFocus
                  />
                </div>
                <div className="mt-6 flex gap-3">
                  <button
                    onClick={handleCreateProject}
                    className="flex-1 inline-flex items-center justify-center rounded-xl bg-foreground px-4 py-2.5 text-sm font-medium text-bg shadow hover:opacity-90 transition"
                  >
                    Continue to workspace
                  </button>
                  <button
                    onClick={closeProjectModal}
                    className="inline-flex items-center justify-center rounded-xl border border-border bg-elevated px-4 py-2.5 text-sm font-medium text-muted shadow-sm hover:bg-surface transition"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
