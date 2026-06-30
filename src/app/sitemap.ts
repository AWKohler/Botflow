import type { MetadataRoute } from 'next';
import { getIndexablePostSlugs } from '@/lib/sanity/posts';

const BASE_URL =
  process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ?? 'https://botflow.io';

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticEntries: MetadataRoute.Sitemap = [
    {
      url: BASE_URL,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 1.0,
    },
    {
      url: `${BASE_URL}/blog`,
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 0.9,
    },
    {
      url: `${BASE_URL}/pricing`,
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/sign-up`,
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.6,
    },
    {
      url: `${BASE_URL}/sign-in`,
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.4,
    },
  ];

  let blogEntries: MetadataRoute.Sitemap = [];
  try {
    const slugs = await getIndexablePostSlugs();
    blogEntries = slugs
      .filter((s) => s.slug)
      .map((s) => ({
        url: `${BASE_URL}/blog/${s.slug}`,
        lastModified: new Date(s.updatedAt ?? s.publishedAt ?? Date.now()),
        changeFrequency: 'monthly' as const,
        priority: 0.7,
      }));
  } catch (err) {
    console.error('Failed to load blog slugs for sitemap:', err);
  }

  return [...staticEntries, ...blogEntries];
}
