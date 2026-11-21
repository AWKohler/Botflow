"use client";
import { useCallback, useEffect, useRef, useState } from "react";

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

type Turnstile = {
  render(
    element: HTMLElement,
    options: {
      sitekey: string;
      appearance: "interaction-only";
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => boolean;
    },
  ): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
};
declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

let script: Promise<Turnstile> | undefined;
function loadTurnstile() {
  return (script ??= new Promise((resolve, reject) => {
    const element = document.createElement("script");
    element.src = SCRIPT_SRC;
    element.async = true;
    element.onload = () =>
      window.turnstile
        ? resolve(window.turnstile)
        : reject(new Error("Turnstile did not initialize"));
    element.onerror = () => {
      script = undefined;
      reject(new Error("Turnstile failed to load"));
    };
    document.head.appendChild(element);
  }));
}

/**
 * Runs a Turnstile widget while `active`. Render `widget`, wait for `ready`,
 * then pass `take()` as `fetchOptions` on the request the server gates.
 * With no site key this is inert: always ready and sends no header.
 */
export function useCaptcha(active: boolean) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | undefined>(undefined);
  const [token, setToken] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!SITE_KEY || !active) return;
    let cancelled = false;
    loadTurnstile()
      .then((turnstile) => {
        if (cancelled || !container.current) return;
        widgetId.current = turnstile.render(container.current, {
          sitekey: SITE_KEY,
          appearance: "interaction-only",
          callback: (value) => {
            setFailed(false);
            setToken(value);
          },
          "expired-callback": () => setToken(null),
          "error-callback": () => {
            setToken(null);
            setFailed(true);
            return true;
          },
        });
      })
      .catch((error) => {
        console.error("Failed to load the security check:", error);
        setFailed(true);
      });
    return () => {
      cancelled = true;
      if (widgetId.current) window.turnstile?.remove(widgetId.current);
      widgetId.current = undefined;
      setToken(null);
      setFailed(false);
    };
  }, [active]);

  // Tokens are single-use, so each one is replaced as soon as it is spent.
  const take = useCallback(() => {
    if (!token) return undefined;
    setToken(null);
    if (widgetId.current) window.turnstile?.reset(widgetId.current);
    return { headers: { "x-captcha-response": token } };
  }, [token]);

  return {
    ready: !SITE_KEY || token !== null,
    failed,
    take,
    widget: SITE_KEY ? (
      <div>
        <div ref={container} />
        {failed && (
          <p role="alert" className="text-sm">
            We couldn’t complete the security check. Reload the page or turn off
            content blockers and try again.
          </p>
        )}
      </div>
    ) : null,
  };
}
