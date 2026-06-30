import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import Script from 'next/script';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Reveal, SectionLabel, serif } from '@/components/landing/shared';
import { BlogPortableText } from '@/components/blog/PortableText';
import { PostCard } from '@/components/blog/PostCard';
import { sanityClient } from '@/lib/sanity/client';
import { imageUrl } from '@/lib/sanity/image';
import {
  getPostBySlug,
  getPostSlugs,
  getRelatedPosts,
} from '@/lib/sanity/posts';
import { isBlogPostNoIndexed } from '@/lib/sanity/blog-seo';
import { cn } from '@/lib/utils';

export const revalidate = 60;
export const dynamicParams = true;

const SITE_URL =
  process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ?? 'https://botflow.io';

export async function generateStaticParams() {
  const slugs = await getPostSlugs();
  return slugs
    .filter((s) => s.slug)
    .map((s) => ({ slug: s.slug }));
}

type Props = {
  params: Promise<{ slug: string }>;
};

function formatDate(input?: string) {
  if (!input) return null;
  try {
    return new Date(input).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return null;
  }
}

function isoDate(input?: string) {
  if (!input) return undefined;
  try {
    return new Date(input).toISOString();
  } catch {
    return undefined;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPostBySlug(slug);
  if (!post) {
    return {
      title: 'Post not found',
      robots: { index: false, follow: false },
    };
  }

  const title = post.seo?.metaTitle ?? post.title;
  const description = post.seo?.metaDescription ?? post.excerpt ?? undefined;
  const canonical =
    post.seo?.canonicalUrl ?? `${SITE_URL}/blog/${post.slug}`;

  const og =
    imageUrl(post.seo?.ogImage, 1200, 630) ??
    imageUrl(post.mainImage, 1200, 630) ??
    undefined;

  return {
    title,
    description,
    alternates: { canonical },
    robots: isBlogPostNoIndexed(post) ? { index: false, follow: true } : undefined,
    openGraph: {
      title,
      description,
      url: canonical,
      type: 'article',
      siteName: 'Botflow',
      publishedTime: isoDate(post.publishedAt),
      modifiedTime: isoDate(post.updatedAt ?? post.publishedAt),
      authors: post.author?.name ? [post.author.name] : undefined,
      tags: post.categories?.map((c) => c.title),
      images: og ? [{ url: og, width: 1200, height: 630, alt: title }] : undefined,
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: og ? [og] : undefined,
      creator: post.author?.twitter ? `@${post.author.twitter}` : undefined,
    },
  };
}

export default async function BlogPostPage({ params }: Props) {
  const { slug } = await params;
  const post = await getPostBySlug(slug);
  if (!post) notFound();

  // resolve raw category ids so we can pull related posts
  const refs = post.categories
    ? await sanityClient.fetch<string[]>(
        `*[_type == "blog" && slug.current == $slug][0].categories[]._ref`,
        { slug },
      )
    : [];
  const related = await getRelatedPosts(slug, refs ?? []);

  const date = formatDate(post.publishedAt);
  const updated = post.updatedAt && post.updatedAt !== post.publishedAt
    ? formatDate(post.updatedAt)
    : null;
  const heroImage = imageUrl(post.mainImage, 1800);
  const ogImage =
    imageUrl(post.seo?.ogImage, 1200, 630) ?? imageUrl(post.mainImage, 1200, 630);
  const canonical = post.seo?.canonicalUrl ?? `${SITE_URL}/blog/${post.slug}`;

  const articleJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    description: post.excerpt ?? post.seo?.metaDescription ?? undefined,
    image: ogImage ? [ogImage] : undefined,
    datePublished: isoDate(post.publishedAt),
    dateModified: isoDate(post.updatedAt ?? post.publishedAt),
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonical },
    author: post.author?.name
      ? { '@type': 'Person', name: post.author.name }
      : { '@type': 'Organization', name: 'Botflow' },
    publisher: {
      '@type': 'Organization',
      name: 'Botflow',
      logo: {
        '@type': 'ImageObject',
        url: `${SITE_URL}/brand/botflow-glyph.svg`,
      },
    },
    keywords: post.categories?.map((c) => c.title).join(', '),
  };

  const breadcrumbsJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      {
        '@type': 'ListItem',
        position: 1,
        name: 'Blog',
        item: `${SITE_URL}/blog`,
      },
      {
        '@type': 'ListItem',
        position: 2,
        name: post.title,
        item: canonical,
      },
    ],
  };

  return (
    <>
      <Script
        id="article-jsonld"
        type="application/ld+json"
        strategy="afterInteractive"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd) }}
      />
      <Script
        id="breadcrumbs-jsonld"
        type="application/ld+json"
        strategy="afterInteractive"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbsJsonLd) }}
      />

      <article className="mx-auto max-w-3xl px-4 pt-12 pb-24 sm:px-6 sm:pt-20">
        <Reveal>
          <Link
            href="/blog"
            className="mb-10 inline-flex items-center gap-2 text-sm text-[var(--sand-text-muted)] transition-colors hover:text-[var(--sand-text)]"
          >
            <ArrowLeft className="h-4 w-4" /> All posts
          </Link>

          <header className="flex flex-col gap-5">
            {post.categories?.[0]?.title && (
              <SectionLabel>{post.categories[0].title}</SectionLabel>
            )}
            <h1
              className={cn(
                serif.className,
                'text-balance text-4xl leading-[1.08] tracking-tight sm:text-5xl md:text-6xl',
              )}
            >
              {post.title}
            </h1>
            {post.excerpt && (
              <p className="text-lg leading-relaxed text-[var(--sand-text-muted)]">
                {post.excerpt}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-2 text-sm text-[var(--sand-text-muted)]">
              {post.author?.name && (
                <span className="font-medium text-[var(--sand-text)]">
                  {post.author.name}
                </span>
              )}
              {date && <span>{date}</span>}
              {post.readingTime ? <span>{post.readingTime} min read</span> : null}
              {updated && (
                <span className="italic">Updated {updated}</span>
              )}
            </div>
          </header>
        </Reveal>

        {heroImage && (
          <Reveal delay={120}>
            <div className="relative mt-12 overflow-hidden rounded-2xl border border-[var(--sand-border)] bg-[var(--sand-elevated)]">
              <Image
                src={heroImage}
                alt={post.mainImage?.alt ?? post.title}
                width={post.mainImage?.asset?.metadata?.dimensions?.width ?? 1800}
                height={
                  post.mainImage?.asset?.metadata?.dimensions?.height ?? 1000
                }
                priority
                sizes="(min-width: 768px) 768px, 100vw"
                className="h-auto w-full"
                placeholder={post.mainImage?.asset?.metadata?.lqip ? 'blur' : undefined}
                blurDataURL={post.mainImage?.asset?.metadata?.lqip}
              />
            </div>
          </Reveal>
        )}

        <Reveal delay={200}>
          <div className="mt-12 max-w-none [&>:first-child]:mt-0">
            <BlogPortableText value={post.body} />
          </div>
        </Reveal>
      </article>

      {related.length > 0 && (
        <section className="border-t border-[var(--sand-border)]">
          <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6">
            <SectionLabel>Keep reading</SectionLabel>
            <div className="mt-8 grid grid-cols-1 gap-x-10 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
              {related.map((p) => (
                <PostCard key={p._id} post={p} />
              ))}
            </div>
          </div>
        </section>
      )}
    </>
  );
}
