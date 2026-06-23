/**
 * Blog search-indexing policy.
 *
 * The blog was seeded by an automated "autoblog" pipeline that published ~105
 * thin, off-topic AI-news posts. Per Google Search Console these earn
 * impressions but effectively zero clicks, and a large share aren't indexed at
 * all — i.e. they add sitewide-quality drag without bringing traffic. So every
 * post created before the cutover is removed from search (noindex) and from the
 * sitemap. Posts authored after the cutover are indexed normally.
 *
 * Any individual post can override the date rule via the Studio `seo.noIndex`
 * boolean:
 *   - seo.noIndex === true   -> always noindex
 *   - seo.noIndex === false  -> always index (force-index a pre-cutover post,
 *                               e.g. a rewritten announcement)
 *   - unset                  -> noindex iff created before BLOG_NOINDEX_BEFORE
 *
 * NOTE: this only governs what search engines do with already-published posts.
 * If the autoblog pipeline keeps running, new auto-posts (created after the
 * cutover) will be indexed — disable the pipeline to stop that.
 */
export const BLOG_NOINDEX_BEFORE = '2026-06-22T00:00:00Z';

export function isBlogPostNoIndexed(post: {
  _createdAt?: string;
  seo?: { noIndex?: boolean } | null;
}): boolean {
  if (post.seo?.noIndex === true) return true;
  if (post.seo?.noIndex === false) return false;
  if (post._createdAt && post._createdAt < BLOG_NOINDEX_BEFORE) return true;
  return false;
}
