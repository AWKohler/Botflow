"use client";

import { createContext, useCallback, useContext, useMemo, useState } from 'react';

type Toast = { id: number; title?: string; description?: string };

const ToastCtx = createContext<{ toast: (t: Omit<Toast, 'id'>) => void } | null>(null);

const ERROR_RE = /fail|error|denied|conflict|unable|couldn't|could not/i;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    try {
      const label = `[toast] ${t.title ?? ''}${t.description ? ` — ${t.description}` : ''}`;
      const isError = ERROR_RE.test(`${t.title ?? ''} ${t.description ?? ''}`);
      if (isError) console.error(label); else console.log(label);
    } catch {}
    setToasts((prev) => [...prev, { id, ...t }]);
    // auto dismiss
    setTimeout(() => {
      setToasts((prev) => prev.filter((x) => x.id !== id));
    }, 3500);
  }, []);

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-[100] flex flex-col gap-2"
      >
        {toasts.map((t) => {
          const isError = ERROR_RE.test(`${t.title ?? ''} ${t.description ?? ''}`);
          return (
            <div
              key={t.id}
              role="status"
              className="bolt-fade-in pointer-events-auto flex min-w-[260px] max-w-[380px] items-start gap-2.5 rounded-xl border border-border bg-bg px-3.5 py-3 shadow-lg"
            >
              <span
                aria-hidden="true"
                className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${isError ? 'bg-danger-solid' : 'bg-success-solid'}`}
              />
              <div className="min-w-0">
                {t.title && <div className="text-[13px] font-medium leading-5 text-fg">{t.title}</div>}
                {t.description && <div className="mt-0.5 text-xs leading-relaxed text-muted">{t.description}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
