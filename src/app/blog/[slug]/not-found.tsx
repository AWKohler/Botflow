import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { serif } from '@/components/landing/fonts';
import { cn } from '@/lib/utils';

export default function PostNotFound() {
  return (
    <section className="mx-auto flex min-h-[60vh] max-w-3xl flex-col items-center justify-center px-4 text-center">
      <h1 className={cn(serif.className, 'text-4xl sm:text-5xl')}>
        Post not found
      </h1>
      <p className="mt-4 text-[var(--sand-text-muted)]">
        We couldn&apos;t find that article. It may have been moved or unpublished.
      </p>
      <Link
        href="/blog"
        className="mt-8 inline-flex items-center gap-2 rounded-xl border border-[var(--sand-border)] bg-[var(--sand-elevated)] px-4 py-2 text-sm font-medium shadow-sm transition hover:bg-[var(--sand-surface)]"
      >
        <ArrowLeft className="h-4 w-4" /> Back to all posts
      </Link>
    </section>
  );
}
