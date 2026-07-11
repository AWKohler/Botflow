import type { Metadata } from 'next';
import Script from 'next/script';
import { Reveal, SectionLabel } from '@/components/landing/shared';
import { serif } from '@/components/landing/fonts';
import { PostCard } from '@/components/blog/PostCard';
import { getAllPosts } from '@/lib/sanity/posts';
import { cn } from '@/lib/utils';

export const revalidate = 60;

const SITE_URL =
  process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ?? 'https://botflow.io';

export const metadata: Metadata = {
  title: 'Field notes on building with AI',
  description:
    'Engineering notes, product updates, and field guides on building full-stack apps in the browser with AI.',
  alternates: { canonical: '/blog' },
  openGraph: {
    title: 'Botflow Blog — Field notes on building with AI',
    description:
      'Engineering notes, product updates, and field guides on building full-stack apps in the browser with AI.',
    url: '/blog',
    type: 'website',
  },
  twitter: {
    title: 'Botflow Blog',
    description:
      'Engineering notes, product updates, and field guides on building full-stack apps in the browser with AI.',
    card: 'summary_large_image',
  },
};

export default async function BlogIndexPage() {
  const posts = await getAllPosts();
  const [hero, ...rest] = posts;

  const itemListJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Blog',
    name: 'Botflow Blog',
    url: `${SITE_URL}/blog`,
    blogPost: posts.slice(0, 20).map((p) => ({
      '@type': 'BlogPosting',
      headline: p.title,
      url: `${SITE_URL}/blog/${p.slug}`,
      datePublished: p.publishedAt,
      dateModified: p.updatedAt ?? p.publishedAt,
      description: p.excerpt,
      author: p.author?.name
        ? { '@type': 'Person', name: p.author.name }
        : undefined,
    })),
  };

  return (
    <>
      <Script
        id="blog-jsonld"
        type="application/ld+json"
        strategy="afterInteractive"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(itemListJsonLd) }}
      />

      <section className="mx-auto max-w-7xl px-4 pt-16 sm:px-6 sm:pt-24">
        <Reveal>
          <SectionLabel>Botflow Journal</SectionLabel>
          <h1
            className={cn(
              serif.className,
              'max-w-3xl text-balance text-5xl leading-[1.05] tracking-tight sm:text-6xl md:text-7xl',
            )}
          >
            Field notes on building <em className="italic">with</em> AI.
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-[var(--sand-text-muted)]">
            Product updates, engineering deep-dives, and the occasional
            workshop on shipping full-stack apps in the browser.
          </p>
        </Reveal>
      </section>

      <section className="mx-auto max-w-7xl px-4 pt-12 pb-24 sm:px-6 sm:pt-20">
        {posts.length === 0 ? (
          <p className="text-[var(--sand-text-muted)]">
            No posts yet. Check back soon.
          </p>
        ) : (
          <div className="flex flex-col gap-20">
            {hero && (
              <Reveal delay={100}>
                <PostCard post={hero} variant="featured" />
              </Reveal>
            )}

            {rest.length > 0 && (
              <>
                <div
                  aria-hidden
                  className="h-px w-full bg-[var(--sand-border)]"
                />
                <div className="grid grid-cols-1 gap-x-10 gap-y-16 sm:grid-cols-2 lg:grid-cols-3">
                  {rest.map((post, idx) => (
                    <Reveal key={post._id} delay={idx * 50}>
                      <PostCard post={post} />
                    </Reveal>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </section>
    </>
  );
}
