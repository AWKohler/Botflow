import type { MetadataRoute } from 'next';

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ?? 'https://botflow.io';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: [
        '/api/',
        '/workspace/',
        '/projects',
        '/settings',
        '/start',
      ],
    },
    sitemap: `${BASE_URL}/sitemap.xml`,
  };
}
