'use client';

import { X } from 'lucide-react';
import { useModal } from "@/components/ui/use-modal";

interface ImageLightboxProps {
  src: string;
  alt?: string;
  onClose: () => void;
}

export function ImageLightbox({ src, alt, onClose }: ImageLightboxProps) {
  const modalRef = useModal<HTMLDivElement>(true, onClose);

  return (
    <div
      ref={modalRef}
      role="dialog"
      aria-modal="true"
      aria-label={alt || 'Image preview'}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 outline-none"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 right-4 flex items-center justify-center size-8 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
        aria-label="Close"
      >
        <X size={16} />
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt ?? ''}
        className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg"
        crossOrigin="anonymous"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
