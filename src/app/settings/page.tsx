"use client";

import { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { SignedIn, SignedOut, SignInButton } from '@/components/auth';
import { AppShell } from '@/components/site/AppShell';
import { Badge } from '@/components/ui/badge';
import { Button, buttonClass } from '@/components/ui/button';
import { Card, PageHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { TextInput } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';

export default function SettingsPage() {
  const { toast } = useToast();
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
        // Only send the keys the user typed. An omitted field keeps its saved
        // value on the server; sending null would clear it.
        body: JSON.stringify({
          openaiApiKey: openaiKey.trim() || undefined,
          anthropicApiKey: anthropicKey.trim() || undefined,
          moonshotApiKey: moonshotKey.trim() || undefined,
          fireworksApiKey: fireworksKey.trim() || undefined,
          xaiApiKey: xaiKey.trim() || undefined,
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
        toast({ title: 'Keys saved', description: 'Your API keys have been updated.' });
      } else {
        toast({ title: 'Save failed', description: 'Could not save settings.' });
      }
    } catch {
      toast({ title: 'Save failed', description: 'Unexpected error saving settings.' });
    } finally {
      setSaving(false);
    }
  };

  const keys = [
    { id: 'openai', label: 'OpenAI', placeholder: 'sk-…', saved: hasOpenai, value: openaiKey, set: setOpenaiKey },
    { id: 'anthropic', label: 'Anthropic', placeholder: 'sk-ant-…', saved: hasAnthropic, value: anthropicKey, set: setAnthropicKey },
    { id: 'moonshot', label: 'Moonshot', placeholder: 'sk-…', saved: hasMoonshot, value: moonshotKey, set: setMoonshotKey },
    { id: 'fireworks', label: 'Fireworks AI', placeholder: 'fw_…', saved: hasFireworks, value: fireworksKey, set: setFireworksKey },
    { id: 'xai', label: 'xAI (Grok)', placeholder: 'xai-…', saved: hasXai, value: xaiKey, set: setXaiKey },
  ];
  const dirty = keys.some((k) => k.value.trim());

  return (
    <AppShell width="narrow">
      <PageHeader
        title="API keys"
        description="Bring your own model keys. Add as many providers as you like — keys are stored on the server and never shown again."
      />

      <div className="mt-8">
        <SignedOut>
          <EmptyState
            className="rounded-xl border border-dashed border-border-strong bg-surface"
            icon={KeyRound}
            title="Sign in to manage your keys"
            action={
              <SignInButton>
                <button className={buttonClass({ variant: 'primary' })}>Sign in</button>
              </SignInButton>
            }
          />
        </SignedOut>

        <SignedIn>
          <Card>
            <div className="divide-y divide-border">
              {keys.map((k) => (
                <div key={k.id} className="grid gap-2 px-6 py-5 sm:grid-cols-[180px_1fr] sm:items-center sm:gap-6">
                  <label htmlFor={`key-${k.id}`} className="flex items-center gap-2 text-sm font-medium text-fg">
                    {k.label}
                    {k.saved && <Badge tone="success">Saved</Badge>}
                  </label>
                  <TextInput
                    id={`key-${k.id}`}
                    type="password"
                    placeholder={k.saved ? 'Enter a new key to replace the saved one' : k.placeholder}
                    value={k.value}
                    onChange={(e) => k.set(e.target.value)}
                    className="font-mono text-[13px] placeholder:font-sans"
                  />
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between gap-4 border-t border-border bg-elevated/50 px-6 py-3.5">
              <p className="text-xs text-muted">Leave a field empty to keep its current key.</p>
              <Button variant="primary" onClick={save} disabled={saving || !dirty}>
                {saving ? 'Saving…' : 'Save keys'}
              </Button>
            </div>
          </Card>
        </SignedIn>
      </div>
    </AppShell>
  );
}
