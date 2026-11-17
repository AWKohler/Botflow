"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Circle, Download, Loader2, Monitor } from "lucide-react";
import { COMPANION_MAC_DOWNLOAD, inspectLocalSimulator, resetLocalConnection,
  type LocalSimulatorHealth } from "./local-simulator-client";

export function LocalSimulatorSetup({ onReady }: { onReady: () => void }) {
  const [health, setHealth] = useState<LocalSimulatorHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [isMac, setIsMac] = useState<boolean | null>(null);
  useEffect(() => {
    setIsMac(/Mac/i.test(navigator.platform) && navigator.maxTouchPoints <= 1);
  }, []);

  async function check() {
    setChecking(true);
    setError(null);
    resetLocalConnection();
    try { setHealth(await inspectLocalSimulator()); }
    catch (error) { setHealth(null); setError((error as Error).message); }
    finally { setChecking(false); }
  }

  return <div className="flex h-full min-h-0 items-center justify-center overflow-auto p-5">
    <div className="w-full max-w-lg space-y-5 rounded-xl border border-border bg-panel p-6">
      <Monitor className="text-accent" size={26} />
      <div className="space-y-2">
        <h3 className="text-base font-semibold text-fg">Live preview on your Mac</h3>
        <p className="text-sm text-muted">Botflow’s Mac cloud is <span className="font-medium text-fg">currently at capacity</span>. Link a local simulator with Botflow Companion to preview your app here.</p>
      </div>
      {isMac === false ? <p className="text-sm text-muted">Local simulator preview requires a Mac with an Apple M-series chip. You can continue editing your project from this device.</p> : <>
        <ol className="space-y-2 text-sm text-muted">
          <li>1. Install and open the latest Botflow Companion.</li>
          <li>2. Install <a className="text-accent underline" href="https://apps.apple.com/app/xcode/id497799835" target="_blank" rel="noreferrer">Xcode</a>, open it once, and install an iOS simulator runtime in Settings → Components or Platforms.</li>
          <li>3. Check setup below and allow your browser to connect to Companion.</li>
        </ol>
        <p className="text-xs text-muted">Apple Silicon only. Compatible older Xcode versions are welcome. Your app builds and runs on this Mac; Apple sign-in in Companion is not required.</p>
        <a href={COMPANION_MAC_DOWNLOAD} className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-fg"><Download size={15} /> Download Companion for Mac</a>
        {health && <div className="space-y-3" aria-live="polite">
          {health.xcodeVersion && <p className="text-xs text-muted">Detected {health.xcodeVersion}</p>}
          {health.checks.map((item) => <div key={item.code} className="flex items-start gap-2 text-sm">
            {item.ready ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-success" /> : <Circle size={16} className="mt-0.5 shrink-0 text-warning" />}
            <div><p className="text-fg">{item.title}</p>{!item.ready && <p className="mt-1 break-words text-xs text-muted">{item.hint} {item.url && <a href={item.url} target="_blank" rel="noreferrer" className="text-accent underline">Instructions</a>}</p>}</div>
          </div>)}
        </div>}
        {error && <p role="alert" className="text-sm text-warning">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <button onClick={check} disabled={checking} className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-fg disabled:opacity-50">{checking && <Loader2 size={14} className="animate-spin" />}{checking ? "Checking this Mac…" : "Check setup"}</button>
          {health?.ready && <button onClick={onReady} disabled={checking} className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-fg px-3 text-[13px] font-medium text-bg shadow-xs transition-colors hover:bg-fg/88 disabled:opacity-50">Start local preview</button>}
        </div>
      </>}
    </div>
  </div>;
}
