import { Instrument_Serif } from 'next/font/google';

// Server-safe home for the landing display font. shared.tsx is a 'use client'
// module, and next/font objects exported through a client boundary silently
// lose their className when read from a server component — so server
// components (blog pages, not-found, compare) must import `serif` from here,
// not from shared.tsx. shared.tsx re-exports it for client components.
export const serif = Instrument_Serif({
  weight: '400',
  style: ['normal', 'italic'],
  subsets: ['latin'],
  display: 'swap',
});
