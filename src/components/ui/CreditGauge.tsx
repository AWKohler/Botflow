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
  const diameter = size === 'lg' ? 160 : size === 'xs' ? 32 : 40;
  const strokeWidth = size === 'lg' ? 10 : size === 'xs' ? 3.5 : 4;
  const radius = (diameter - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (clamped / 100) * circumference;

  const color =
    clamped >= 80 ? '#ef4444' : // red
    clamped >= 60 ? '#f59e0b' : // amber
    '#22c55e';                  // green

  const fontSize = size === 'lg' ? 28 : size === 'xs' ? 9 : 10;

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
          className="text-border opacity-40"
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
      {/* Center label */}
      <span
        className="absolute font-semibold tabular-nums"
        style={{ fontSize, color, lineHeight: 1 }}
      >
        {clamped}%
      </span>
    </div>
  );
}
