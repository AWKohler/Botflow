import type { PortableTextBlock } from '@portabletext/react';

export interface SanityImage {
  _type?: 'image';
  asset: {
    _id?: string;
    _ref?: string;
    _type?: string;
    url?: string;
    metadata?: {
      lqip?: string;
      dimensions?: { width: number; height: number; aspectRatio: number };
    };
  };
  alt?: string;
  caption?: string;
  hotspot?: { x: number; y: number; height: number; width: number };
  crop?: { top: number; bottom: number; left: number; right: number };
}

export interface BlogAuthor {
  name: string;
  role?: string;
  avatar?: SanityImage;
  twitter?: string;
}

export interface BlogSEO {
  metaTitle?: string;
  metaDescription?: string;
  ogImage?: SanityImage;
  noIndex?: boolean;
  canonicalUrl?: string;
}

export interface BlogCategory {
  title: string;
  slug: string;
}

export interface BlogPostListItem {
  _id: string;
  title: string;
  slug: string;
  excerpt?: string;
  mainImage?: SanityImage;
  publishedAt: string;
  updatedAt?: string;
  author?: BlogAuthor;
  categories?: BlogCategory[];
  readingTime?: number;
  featured?: boolean;
}

export interface BlogPost extends BlogPostListItem {
  _createdAt?: string;
  body: PortableTextBlock[];
  seo?: BlogSEO;
}

export interface BlogPostSlug {
  slug: string;
  updatedAt?: string;
  publishedAt: string;
}
