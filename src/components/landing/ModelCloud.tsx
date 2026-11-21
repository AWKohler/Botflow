'use client';

import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * ModelCloud — a freeform floating cloud of provider squircle icons.
 *
 * Each icon idle-floats (rAF-driven sine offset) and gently repels from the
 * cursor when it gets close. Hovering an icon scales it up, glows the
 * squircle, and reveals a provider label.
 */

type CloudIcon = {
  key: string;
  src: string;
  label: string;
  /** Position in percent of container (0–100) */
  x: number;
  y: number;
  /** Rendered size in px */
  size: number;
  /** Idle float amplitude in px */
  amp?: number;
  /** Idle float period in seconds */
  period?: number;
  /** Idle float phase offset (0–1) */
  phase?: number;
  /** Subtle tilt in degrees applied at rest */
  tilt?: number;
};

const ICONS: CloudIcon[] = [
  { key: 'openai',    src: '/model-icons/openai.png',    label: 'OpenAI',    x: 20, y: 26, size: 112, amp: 8,  period: 6.2, phase: 0.0,  tilt: -4 },
  { key: 'kimi',      src: '/model-icons/kimi.png',      label: 'Kimi',      x: 70, y: 18, size: 98,  amp: 10, period: 5.4, phase: 0.25, tilt: 3  },
  { key: 'anthropic', src: '/model-icons/anthropic.png', label: 'Anthropic', x: 46, y: 54, size: 140, amp: 6,  period: 7.1, phase: 0.5,  tilt: -2 },
  { key: 'minimax',   src: '/model-icons/minimax.png',   label: 'MiniMax',   x: 82, y: 60, size: 88,  amp: 9,  period: 5.9, phase: 0.7,  tilt: 5  },
  { key: 'zai',       src: '/model-icons/zai.png',       label: 'Z.AI',      x: 18, y: 74, size: 96,  amp: 8,  period: 6.6, phase: 0.9,  tilt: -6 },
];

const INFLUENCE_RADIUS = 200;
const MAX_REPULSION = 60;
const LERP = 0.12;

export function ModelCloud({ className }: { className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const iconRefs = useRef<(HTMLDivElement | null)[]>([]);
  const mouse = useRef<{ x: number; y: number; inside: boolean }>({ x: 0, y: 0, inside: false });
  const offsets = useRef(ICONS.map(() => ({ x: 0, y: 0 })));
  const [hovered, setHovered] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let raf = 0;
    const start = performance.now();

    const onMove = (e: MouseEvent) => {
      const r = container.getBoundingClientRect();
      mouse.current.x = e.clientX - r.left;
      mouse.current.y = e.clientY - r.top;
      mouse.current.inside = true;
    };
    const onLeave = () => {
      mouse.current.inside = false;
    };

    container.addEventListener('mousemove', onMove);
    container.addEventListener('mouseleave', onLeave);

    const tick = (now: number) => {
      const rect = container.getBoundingClientRect();
      const t = (now - start) / 1000;

      ICONS.forEach((icon, i) => {
        const cx = (icon.x / 100) * rect.width;
        const cy = (icon.y / 100) * rect.height;

        // Idle sine float
        const phase = (icon.phase ?? 0) * Math.PI * 2;
        const period = icon.period ?? 6;
        const amp = icon.amp ?? 6;
        const idleX = Math.sin((t / period) * Math.PI * 2 + phase) * amp;
        const idleY = Math.cos((t / period) * Math.PI * 2 + phase * 1.3) * amp * 0.8;

        // Cursor repulsion
        let repelX = 0;
        let repelY = 0;
        if (mouse.current.inside) {
          const dx = cx - mouse.current.x;
          const dy = cy - mouse.current.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < INFLUENCE_RADIUS && dist > 0.001) {
            const strength = (1 - dist / INFLUENCE_RADIUS) ** 2;
            repelX = (dx / dist) * strength * MAX_REPULSION;
            repelY = (dy / dist) * strength * MAX_REPULSION;
          }
        }

        const targetX = idleX + repelX;
        const targetY = idleY + repelY;

        const cur = offsets.current[i];
        cur.x += (targetX - cur.x) * LERP;
        cur.y += (targetY - cur.y) * LERP;

        const el = iconRefs.current[i];
        if (el) {
          el.style.transform = `translate3d(${cur.x.toFixed(2)}px, ${cur.y.toFixed(2)}px, 0) rotate(${icon.tilt ?? 0}deg)`;
        }
      });

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mouseleave', onLeave);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={cn(
        // Clipped sideways on phones: an icon's hover glow at the edge would
        // otherwise make the page a pixel wider than the screen.
        'relative w-full aspect-[5/4] min-h-[420px] max-md:[overflow-x:clip]',
        className,
      )}
    >
      {/* Ambient backdrop: soft accent glow + subtle dot grid */}
      <div
        aria-hidden
        className="absolute inset-0 rounded-3xl"
        style={{
          background:
            'radial-gradient(60% 55% at 50% 45%, color-mix(in oklab, var(--sand-accent) 9%, transparent), transparent 70%)',
        }}
      />
      <div
        aria-hidden
        className="absolute inset-0 rounded-3xl"
        style={{
          backgroundImage:
            'radial-gradient(circle at 1px 1px, color-mix(in oklab, var(--sand-accent) 40%, transparent) 1px, transparent 0)',
          backgroundSize: '22px 22px',
          WebkitMaskImage:
            'radial-gradient(70% 60% at 50% 50%, black 0%, transparent 85%)',
          maskImage:
            'radial-gradient(70% 60% at 50% 50%, black 0%, transparent 85%)',
          opacity: 0.35,
        }}
      />

      {/* Icons */}
      {ICONS.map((icon, i) => (
        <div
          key={icon.key}
          className="absolute pointer-events-none"
          style={{
            left: `${icon.x}%`,
            top: `${icon.y}%`,
            width: icon.size,
            height: icon.size,
            marginLeft: -icon.size / 2,
            marginTop: -icon.size / 2,
            willChange: 'transform',
          }}
          ref={(el) => {
            iconRefs.current[i] = el;
          }}
        >
          <button
            type="button"
            aria-label={icon.label}
            onMouseEnter={() => setHovered(icon.key)}
            onMouseLeave={() => setHovered((h) => (h === icon.key ? null : h))}
            className="group pointer-events-auto relative block h-full w-full transition-transform duration-300 ease-out hover:scale-[1.08]"
            style={{
              filter:
                'drop-shadow(0 12px 28px color-mix(in oklab, var(--sand-accent) 16%, transparent)) drop-shadow(0 2px 6px rgba(0,0,0,0.12))',
            }}
          >
            {/* Glow halo that brightens on hover */}
            <span
              aria-hidden
              className="absolute inset-[-14%] rounded-[32%] opacity-0 transition-opacity duration-300 group-hover:opacity-100"
              style={{
                background:
                  'radial-gradient(closest-side, color-mix(in oklab, var(--sand-accent) 26%, transparent), transparent 70%)',
              }}
            />
            <Image
              src={icon.src}
              alt={icon.label}
              fill
              sizes={`${icon.size}px`}
              className="relative select-none object-contain"
              draggable={false}
              priority={i < 2}
            />
            {/* Label chip */}
            <span
              aria-hidden
              className={cn(
                'pointer-events-none absolute left-1/2 top-full mt-2 -translate-x-1/2 whitespace-nowrap rounded-full border border-[var(--sand-border)] bg-[var(--sand-surface)] px-2.5 py-1 text-xs font-medium text-[var(--sand-text-muted)] shadow-sm transition-all duration-300',
                hovered === icon.key
                  ? 'translate-y-0 opacity-100'
                  : '-translate-y-1 opacity-0',
              )}
            >
              {icon.label}
            </span>
          </button>
        </div>
      ))}
    </div>
  );
}
