'use client';

import { cn } from '@/lib/utils';

interface CreditGaugeProps {
  pct: number; // 0–100
  size?: 'xs' | 'sm' | 'lg';
  className?: string;
}

export function CreditGauge({ pct, size = 'sm', className }: CreditGaugeProps) {
  const clamped = Math.max(0, Math.min(100, pct));

  // 'xs' is used when two gauges sit side-by-side in the header, so they don't
  // crowd each other.
  const diameter = size === 'lg' ? 144 : size === 'xs' ? 30 : 34;
  const strokeWidth = size === 'lg' ? 9 : 3;
  const radius = (diameter - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (clamped / 100) * circumference;

  const color =
    clamped >= 80 ? 'var(--danger-solid)' : // red
    clamped >= 60 ? 'var(--warning-solid)' : // amber
    'var(--success-solid)';                  // green

  const fontSize = size === 'lg' ? 26 : 9;

  return (
    <div className={cn('relative inline-flex items-center justify-center', className)}>
      <svg width={diameter} height={diameter} viewBox={`0 0 ${diameter} ${diameter}`} style={{ transform: 'rotate(-90deg)' }}>
        {/* Track */}
        <circle
          cx={diameter / 2}
          cy={diameter / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          className="text-soft"
        />
        {/* Progress */}
        <circle
          cx={diameter / 2}
          cy={diameter / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 0.4s ease, stroke 0.4s ease' }}
        />
      </svg>
      {/* Center label — neutral; the ring carries the status color. */}
      <span
        className={cn('absolute font-medium tabular-nums', size === 'lg' ? 'text-fg' : 'text-muted')}
        style={{ fontSize, lineHeight: 1 }}
      >
        {clamped}%
      </span>
    </div>
  );
}
