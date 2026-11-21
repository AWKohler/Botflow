'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';

interface ImageViewerProps {
  src: string;
  filename: string;
  /** Raw byte length for file size display */
  byteLength?: number;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function ImageViewer({ src, filename, byteLength }: ImageViewerProps) {
  const [dimensions, setDimensions] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);

  const name = filename.split('/').pop() ?? filename;
  const ext = name.split('.').pop()?.toUpperCase() ?? '';

  return (
    <div className="absolute inset-0 flex flex-col bg-elevated/90">
      {/* Image canvas — checkerboard bg to reveal transparency */}
      <div
        className="flex-1 flex items-center justify-center overflow-auto p-6 cursor-zoom-in select-none"
        style={{
          backgroundImage: `
            linear-gradient(45deg, #3a3a3a 25%, transparent 25%),
            linear-gradient(-45deg, #3a3a3a 25%, transparent 25%),
            linear-gradient(45deg, transparent 75%, #3a3a3a 75%),
            linear-gradient(-45deg, transparent 75%, #3a3a3a 75%)
          `,
          backgroundSize: '16px 16px',
          backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
          backgroundColor: '#2a2a2a',
        }}
        onClick={() => setZoom(z => z === 1 ? 2 : z === 2 ? 0.5 : 1)}
        title="Click to zoom"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={name}
          onLoad={(e) => {
            const img = e.currentTarget;
            setDimensions({ w: img.naturalWidth, h: img.naturalHeight });
          }}
          style={{ transform: `scale(${zoom})`, transformOrigin: 'center', transition: 'transform 0.15s ease' }}
          className={cn('max-w-full max-h-full object-contain rounded shadow-lg')}
          draggable={false}
        />
      </div>

      {/* Info bar */}
      <div className="flex items-center gap-3 px-4 py-2 border-t border-border bg-surface shrink-0">
        <span className="text-xs font-mono text-foreground font-medium truncate max-w-xs">{name}</span>
        <span className="text-[11px] px-1.5 py-0.5 rounded bg-soft text-muted font-medium">{ext}</span>
        {dimensions && (
          <span className="text-xs text-muted">
            {dimensions.w} × {dimensions.h}
          </span>
        )}
        {byteLength !== undefined && (
          <span className="text-xs text-muted">{formatBytes(byteLength)}</span>
        )}
        <div className="flex-1" />
        <span className="text-[11px] text-muted opacity-60">Click image to zoom</span>
        <div className="flex items-center gap-1 text-xs text-muted">
          <button
            type="button"
            onClick={() => setZoom(z => Math.max(0.25, z - 0.25))}
            className="px-1.5 py-0.5 rounded hover:bg-soft transition-colors"
          >−</button>
          <span className="w-10 text-center">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            onClick={() => setZoom(z => Math.min(4, z + 0.25))}
            className="px-1.5 py-0.5 rounded hover:bg-soft transition-colors"
          >+</button>
          <button
            type="button"
            onClick={() => setZoom(1)}
            className="px-1.5 py-0.5 rounded hover:bg-soft transition-colors ml-1"
          >Reset</button>
        </div>
      </div>
    </div>
  );
}
