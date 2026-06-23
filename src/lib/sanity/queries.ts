import { BLOG_NOINDEX_BEFORE } from './blog-seo';

const POST_FIELDS_BASE = /* groq */ `
  _id,
  title,
  "slug": slug.current,
  excerpt,
  mainImage{
    ...,
    "alt": coalesce(alt, ""),
    asset->{
      _id,
      _type,
      url,
      metadata{ lqip, dimensions }
    }
  },
  // Fall back to titleImage for legacy posts authored under the old schema
  "legacyImage": titleImage{
    ...,
    asset->{ _id, _type, url, metadata{ lqip, dimensions } }
  },
  // smallDescription was the legacy field name for excerpt
  "legacyExcerpt": smallDescription,
  publishedAt,
  "updatedAt": coalesce(updatedAt, _updatedAt),
  author->{
    name,
    role,
    twitter,
    avatar{ asset->{ _id, _type, url } }
  },
  // Inline author fallback for legacy
  "authorInline": author{
    name, role, twitter,
    avatar{ asset->{ _id, _type, url } }
  },
  categories[]->{
    title,
    "slug": slug.current
  },
  readingTime,
  featured
`;

export const allPostsQuery = /* groq */ `
  *[_type == "blog" && !(_id in path("drafts.**"))] | order(coalesce(publishedAt, _createdAt) desc) {
    ${POST_FIELDS_BASE}
  }
`;

export const featuredPostsQuery = /* groq */ `
  *[_type == "blog" && featured == true && !(_id in path("drafts.**"))] | order(coalesce(publishedAt, _createdAt) desc) [0...3] {
    ${POST_FIELDS_BASE}
  }
`;

export const postBySlugQuery = /* groq */ `
  *[_type == "blog" && slug.current == $slug && !(_id in path("drafts.**"))][0] {
    ${POST_FIELDS_BASE},
    _createdAt,
    body[]{
      ...,
      _type == "image" => {
        ...,
        "alt": coalesce(alt, ""),
        asset->{
          _id,
          _type,
          url,
          metadata{ lqip, dimensions }
        }
      },
      // Legacy posts stored portable text under "content"
      markDefs[]{ ... }
    },
    // Legacy fallback when authors used the old schema field name
    "legacyBody": content,
    seo{
      metaTitle,
      metaDescription,
      noIndex,
      canonicalUrl,
      ogImage{
        ...,
        asset->{ _id, _type, url, metadata{ dimensions } }
      }
    }
  }
`;

export const postSlugsQuery = /* groq */ `
  *[_type == "blog" && defined(slug.current) && !(_id in path("drafts.**"))]{
    "slug": slug.current,
    publishedAt,
    "updatedAt": coalesce(updatedAt, _updatedAt)
  }
`;

// Slugs eligible for the sitemap: indexable posts only. Mirrors the rule in
// isBlogPostNoIndexed() — exclude posts explicitly marked noIndex, and exclude
// pre-cutover autoblog posts unless explicitly force-indexed (seo.noIndex==false).
export const indexablePostSlugsQuery = /* groq */ `
  *[_type == "blog" && defined(slug.current) && !(_id in path("drafts.**"))
    && seo.noIndex != true
    && (seo.noIndex == false || _createdAt >= "${BLOG_NOINDEX_BEFORE}")
  ]{
    "slug": slug.current,
    publishedAt,
    "updatedAt": coalesce(updatedAt, _updatedAt)
  }
`;

export const relatedPostsQuery = /* groq */ `
  *[
    _type == "blog"
    && slug.current != $slug
    && !(_id in path("drafts.**"))
    && count(categories[]._ref[@ in $categoryIds]) > 0
  ] | order(coalesce(publishedAt, _createdAt) desc) [0...3] {
    ${POST_FIELDS_BASE}
  }
`;
