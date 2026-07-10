"use client";

import { Input } from "@/components/ui/input";
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { SignedIn, SignedOut, SignInButton } from '@clerk/nextjs';
import { useToast } from '@/components/ui/toast';

export default function SettingsPage() {
  const { toast } = useToast();
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [openaiKey, setOpenaiKey] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [moonshotKey, setMoonshotKey] = useState('');
  const [fireworksKey, setFireworksKey] = useState('');
  const [xaiKey, setXaiKey] = useState('');
  const [hasOpenai, setHasOpenai] = useState(false);
  const [hasAnthropic, setHasAnthropic] = useState(false);
  const [hasMoonshot, setHasMoonshot] = useState(false);
  const [hasFireworks, setHasFireworks] = useState(false);
  const [hasXai, setHasXai] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/user-settings');
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) {
            setHasOpenai(Boolean(data?.hasOpenAIKey));
            setHasAnthropic(Boolean(data?.hasAnthropicKey));
            setHasMoonshot(Boolean(data?.hasMoonshotKey));
            setHasFireworks(Boolean(data?.hasFireworksKey));
            setHasXai(Boolean(data?.hasXaiKey));
          }
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/user-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          openaiApiKey: openaiKey.trim() || null,
          anthropicApiKey: anthropicKey.trim() || null,
          moonshotApiKey: moonshotKey.trim() || null,
          fireworksApiKey: fireworksKey.trim() || null,
          xaiApiKey: xaiKey.trim() || null,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setHasOpenai(Boolean(data?.hasOpenAIKey));
        setHasAnthropic(Boolean(data?.hasAnthropicKey));
        setHasMoonshot(Boolean(data?.hasMoonshotKey));
        setHasFireworks(Boolean(data?.hasFireworksKey));
        setHasXai(Boolean(data?.hasXaiKey));
        setOpenaiKey('');
        setAnthropicKey('');
        setMoonshotKey('');
        setFireworksKey('');
        setXaiKey('');
        toast({ title: 'Settings saved', description: 'Your API keys have been updated.' });
      } else {
        toast({ title: 'Save failed', description: 'Could not save settings.' });
      }
    } catch {
      toast({ title: 'Save failed', description: 'Unexpected error saving settings.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-white text-neutral-900">
      <div className="max-w-2xl mx-auto px-6 py-10">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold">Settings</h1>
          <button
            className="text-sm text-neutral-600 hover:text-neutral-900 underline"
            onClick={() => router.back()}
          >
            Back
          </button>
        </div>

        <SignedOut>
          <div className="rounded-xl border border-black/10 p-6 bg-white">
            <p className="mb-4">You need to sign in to manage settings.</p>
            <SignInButton>
              <button className="inline-flex items-center rounded-lg border border-black/10 bg-white px-3.5 py-2 text-sm font-medium shadow-sm hover:bg-neutral-50 transition">
                Sign in
              </button>
            </SignInButton>
          </div>
        </SignedOut>

        <SignedIn>
          <div className="rounded-2xl border border-black/10 bg-white p-6 shadow-sm">
            <p className="text-sm text-neutral-600 mb-6">
              Bring your own keys. Add one or both providers. Keys are stored server-side.
            </p>

            <div className="space-y-6">
              <div>
                <label className="block text-sm font-medium mb-2">OpenAI API Key</label>
                <div className="flex items-center gap-2">
                  <Input
                    type="password"
                    placeholder={hasOpenai ? '●●●●●●●● saved' : 'sk-...'}
                    value={openaiKey}
                    onChange={(e) => setOpenaiKey(e.target.value)}
                    className="flex-1 rounded-lg border border-black/10 px-3 py-2 outline-none focus:ring-2 focus:ring-neutral-200"
                  />
                  <button
                    onClick={save}
                    disabled={saving}
                    className="inline-flex items-center rounded-lg bg-black px-3.5 py-2 text-sm font-medium text-white shadow hover:opacity-90 disabled:opacity-50"
                  >
                    Save
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">Anthropic API Key</label>
                <div className="flex items-center gap-2">
                  <Input
                    type="password"
                    placeholder={hasAnthropic ? '●●●●●●●● saved' : 'anthropic-...'}
                    value={anthropicKey}
                    onChange={(e) => setAnthropicKey(e.target.value)}
                    className="flex-1 rounded-lg border border-black/10 px-3 py-2 outline-none focus:ring-2 focus:ring-neutral-200"
                  />
                  <button
                    onClick={save}
                    disabled={saving}
                    className="inline-flex items-center rounded-lg bg-black px-3.5 py-2 text-sm font-medium text-white shadow hover:opacity-90 disabled:opacity-50"
                  >
                    Save
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">Moonshot API Key</label>
                <div className="flex items-center gap-2">
                  <Input
                    type="password"
                    placeholder={hasMoonshot ? '●●●●●●●● saved' : 'moonshot-...'}
                    value={moonshotKey}
                    onChange={(e) => setMoonshotKey(e.target.value)}
                    className="flex-1 rounded-lg border border-black/10 px-3 py-2 outline-none focus:ring-2 focus:ring-neutral-200"
                  />
                  <button
                    onClick={save}
                    disabled={saving}
                    className="inline-flex items-center rounded-lg bg-black px-3.5 py-2 text-sm font-medium text-white shadow hover:opacity-90 disabled:opacity-50"
                  >
                    Save
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">Fireworks AI API Key</label>
                <div className="flex items-center gap-2">
                  <Input
                    type="password"
                    placeholder={hasFireworks ? '●●●●●●●● saved' : 'fw-...'}
                    value={fireworksKey}
                    onChange={(e) => setFireworksKey(e.target.value)}
                    className="flex-1 rounded-lg border border-black/10 px-3 py-2 outline-none focus:ring-2 focus:ring-neutral-200"
                  />
                  <button
                    onClick={save}
                    disabled={saving}
                    className="inline-flex items-center rounded-lg bg-black px-3.5 py-2 text-sm font-medium text-white shadow hover:opacity-90 disabled:opacity-50"
                  >
                    Save
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">xAI (Grok) API Key</label>
                <div className="flex items-center gap-2">
                  <Input
                    type="password"
                    placeholder={hasXai ? '●●●●●●●● saved' : 'xai-...'}
                    value={xaiKey}
                    onChange={(e) => setXaiKey(e.target.value)}
                    className="flex-1 rounded-lg border border-black/10 px-3 py-2 outline-none focus:ring-2 focus:ring-neutral-200"
                  />
                  <button
                    onClick={save}
                    disabled={saving}
                    className="inline-flex items-center rounded-lg bg-black px-3.5 py-2 text-sm font-medium text-white shadow hover:opacity-90 disabled:opacity-50"
                  >
                    Save
                  </button>
                </div>
              </div>
            </div>
          </div>
        </SignedIn>
      </div>
    </div>
  );
}

