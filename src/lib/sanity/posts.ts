import { sanityFetch } from './fetch';
import {
  allPostsQuery,
  indexablePostSlugsQuery,
  postBySlugQuery,
  postSlugsQuery,
  relatedPostsQuery,
} from './queries';
import type {
  BlogPost,
  BlogPostListItem,
  BlogPostSlug,
  SanityImage,
} from './types';

type RawPost = BlogPostListItem & {
  legacyImage?: SanityImage | null;
  legacyExcerpt?: string | null;
  authorInline?: BlogPost['author'] | null;
};

type RawFullPost = BlogPost &
  RawPost & {
    legacyBody?: BlogPost['body'] | null;
  };

function hasAsset(img: unknown): img is SanityImage {
  if (!img || typeof img !== 'object') return false;
  const asset = (img as { asset?: { _id?: string; _ref?: string } }).asset;
  return Boolean(asset && (asset._id || asset._ref));
}

function normalizeListItem(p: RawPost): BlogPostListItem {
  const mainImage = hasAsset(p.mainImage)
    ? p.mainImage
    : hasAsset(p.legacyImage)
      ? p.legacyImage
      : undefined;
  return {
    ...p,
    excerpt: p.excerpt ?? p.legacyExcerpt ?? undefined,
    mainImage: mainImage ?? undefined,
    author: p.author ?? p.authorInline ?? undefined,
  };
}

function normalizePost(p: RawFullPost): BlogPost {
  const base = normalizeListItem(p);
  return {
    ...p,
    ...base,
    body: (p.body && p.body.length > 0 ? p.body : p.legacyBody) ?? [],
  };
}

const WORDS_PER_MINUTE = 220;

export function estimateReadingTime(body: BlogPost['body']): number {
  if (!Array.isArray(body)) return 1;
  let words = 0;
  for (const block of body) {
    if (block && (block as { _type?: string })._type === 'block') {
      const children = (block as unknown as { children?: { text?: string }[] })
        .children;
      if (Array.isArray(children)) {
        for (const c of children) {
          if (typeof c?.text === 'string') {
            words += c.text.trim().split(/\s+/).filter(Boolean).length;
          }
        }
      }
    }
  }
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

export async function getAllPosts(): Promise<BlogPostListItem[]> {
  const raw = await sanityFetch<RawPost[]>({ query: allPostsQuery });
  return (raw ?? []).map(normalizeListItem);
}

export async function getPostBySlug(slug: string): Promise<BlogPost | null> {
  const raw = await sanityFetch<RawFullPost | null>({
    query: postBySlugQuery,
    params: { slug },
  });
  if (!raw) return null;
  const post = normalizePost(raw);
  if (!post.readingTime) {
    post.readingTime = estimateReadingTime(post.body);
  }
  return post;
}

export async function getPostSlugs(): Promise<BlogPostSlug[]> {
  return (
    (await sanityFetch<BlogPostSlug[]>({
      query: postSlugsQuery,
      revalidate: 300,
    })) ?? []
  );
}

/** Slugs that should appear in the sitemap — indexable posts only. */
export async function getIndexablePostSlugs(): Promise<BlogPostSlug[]> {
  return (
    (await sanityFetch<BlogPostSlug[]>({
      query: indexablePostSlugsQuery,
      revalidate: 300,
    })) ?? []
  );
}

export async function getRelatedPosts(
  slug: string,
  categoryIds: string[],
): Promise<BlogPostListItem[]> {
  if (categoryIds.length === 0) return [];
  const raw = await sanityFetch<RawPost[]>({
    query: relatedPostsQuery,
    params: { slug, categoryIds },
  });
  return (raw ?? []).map(normalizeListItem);
}
