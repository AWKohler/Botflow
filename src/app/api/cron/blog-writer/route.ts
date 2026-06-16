import { NextResponse } from 'next/server';
import { revalidatePath, revalidateTag } from 'next/cache';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { generateObject, generateText, tool, type ModelMessage } from 'ai';
import { createFireworks } from '@ai-sdk/fireworks';
import { createOpenAI } from '@ai-sdk/openai';
import OpenAI from 'openai';
import { z } from 'zod';

import { getSanityWriteClient } from '@/lib/sanity/admin';
import { fetchNewsFeed, formatFeedForPrompt } from '@/lib/blog-writer/feeds';
import {
  WRITER_SYSTEM_PROMPT,
  buildWriterUserPrompt,
  IMAGE_PROMPT_SYSTEM,
  buildImagePromptUserText,
  BRAND_SUBJECT_SYSTEM,
  buildBrandSubjectUserText,
  buildBrandMasterPrompt,
} from '@/lib/blog-writer/prompts';
import { blocksToPortableText, type AuthoredBlock } from '@/lib/blog-writer/portable-text';
import { SANITY_TAG_POSTS } from '@/lib/sanity/fetch';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 800;

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const writerSchema = z.object({
  selectedHeadline: z
    .string()
    .min(4)
    .describe('The exact headline you picked from the feed'),
  selectedLink: z.string().describe('The URL of the picked story'),
  title: z.string().min(8).max(110),
  slug: z
    .string()
    .min(4)
    .max(80)
    .regex(SLUG_RE, 'Must be lowercase kebab-case'),
  excerpt: z.string().min(120).max(220),
  blocks: z
    .array(
      z.discriminatedUnion('type', [
        z.object({
          type: z.literal('heading2'),
          text: z.string().min(2).max(120),
        }),
        z.object({
          type: z.literal('heading3'),
          text: z.string().min(2).max(120),
        }),
        z.object({
          type: z.literal('paragraph'),
          text: z.string().min(20).max(2400),
        }),
      ]),
    )
    .min(8)
    .max(60),
});

const imageSchema = z.object({
  prompt: z.string().min(120).max(2400),
  altText: z.string().min(8).max(180),
});

const brandSubjectSchema = z.object({
  subject: z.string().min(8).max(300).describe('What to render — a vivid, specific scene description using brand metaphors'),
  accentColor: z.enum(['#1A65FF', '#FFCD2E', '#FE342C']).describe('The single accent color for this image'),
  altText: z.string().min(8).max(180).describe('Accessible alt text for the generated image'),
});

interface RecentPost {
  title: string;
  slug: string;
}

async function fetchRecentPosts(): Promise<RecentPost[]> {
  const client = getSanityWriteClient();
  return client.fetch<RecentPost[]>(
    `*[_type == "blog" && !(_id in path("drafts.**"))] | order(_createdAt desc)[0...12]{
      title,
      "slug": slug.current
    }`,
  );
}

async function ensureUniqueSlug(slug: string): Promise<string> {
  const client = getSanityWriteClient();
  let candidate = slug;
  let suffix = 2;
  while (
    await client.fetch<number>(
      'count(*[_type=="blog" && slug.current == $s])',
      { s: candidate },
    ) > 0
  ) {
    candidate = `${slug}-${suffix++}`;
    if (suffix > 50) {
      throw new Error(`Could not find unique slug starting from "${slug}"`);
    }
  }
  return candidate;
}

async function loadMoodboardImages(): Promise<{ data: string; mediaType: string }[]> {
  const dir = path.join(process.cwd(), 'public', 'blog-moodboard');
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    console.error('[blog-writer] failed to read moodboard dir:', err);
    return [];
  }
  const pngs = entries.filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort();
  const out: { data: string; mediaType: string }[] = [];
  for (const f of pngs) {
    const buf = await fs.readFile(path.join(dir, f));
    const ext = path.extname(f).toLowerCase();
    const mediaType =
      ext === '.png' ? 'image/png'
      : ext === '.webp' ? 'image/webp'
      : 'image/jpeg';
    out.push({ data: buf.toString('base64'), mediaType });
  }
  return out;
}

function isAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    // Allow only on Vercel itself when not configured (Vercel cron header).
    // Better: require CRON_SECRET to be set.
    console.error('[blog-writer] CRON_SECRET is not set');
    return false;
  }
  const auth = req.headers.get('authorization');
  if (auth === `Bearer ${cronSecret}`) return true;
  const url = new URL(req.url);
  return url.searchParams.get('token') === cronSecret;
}

interface WriterResult {
  selectedHeadline: string;
  selectedLink: string;
  title: string;
  slug: string;
  excerpt: string;
  blocks: AuthoredBlock[];
}

async function runWriter(args: {
  feedSummary: string;
  recentPosts: RecentPost[];
}): Promise<WriterResult> {
  const apiKey = process.env.FIREWORKS_API_KEY;
  if (!apiKey) {
    throw new Error('FIREWORKS_API_KEY is not set — required to run Kimi K2.7');
  }
  const fireworks = createFireworks({ apiKey });

  const recentBit = args.recentPosts.length
    ? `\n\nRecently published posts (do NOT pick a story we've already covered):\n${args.recentPosts
        .map((p) => `- ${p.title} (/blog/${p.slug})`)
        .join('\n')}`
    : '';

  const userPrompt = buildWriterUserPrompt(args.feedSummary) + recentBit;

  const result = await generateText({
    model: fireworks('accounts/fireworks/models/kimi-k2p7-code'),
    system: WRITER_SYSTEM_PROMPT,
    prompt: userPrompt,
    tools: {
      submitArticle: tool({
        description: 'Submit the chosen story as a fully written blog post.',
        inputSchema: writerSchema,
      }),
    },
    toolChoice: { type: 'tool', toolName: 'submitArticle' },
    maxRetries: 2,
  });

  const call = result.toolCalls.find((c) => c.toolName === 'submitArticle');
  if (!call) {
    throw new Error('Writer model did not call submitArticle');
  }
  const object = call.input as WriterResult;

  if (!SLUG_RE.test(object.slug)) {
    throw new Error(`Writer returned invalid slug: "${object.slug}"`);
  }
  return object;
}

async function runImagePromptWriter(args: {
  title: string;
  excerpt: string;
  moodboard: { data: string; mediaType: string }[];
}): Promise<{ prompt: string; altText: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set — required for image prompt model');
  }

  const userText = buildImagePromptUserText({ title: args.title, excerpt: args.excerpt });

  const messages: ModelMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: userText },
        ...args.moodboard.map((img) => ({
          type: 'image' as const,
          image: `data:${img.mediaType};base64,${img.data}`,
        })),
      ],
    },
  ];

  const openai = createOpenAI({ apiKey });
  const { object } = await generateObject({
    model: openai('gpt-5.4'),
    system: IMAGE_PROMPT_SYSTEM,
    messages,
    schema: imageSchema,
    maxRetries: 2,
  });
  return object;
}

async function generateCoverImage(args: {
  prompt: string;
  moodboard: { data: string; mediaType: string }[];
}): Promise<Buffer> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set — required for image generation');
  }
  const openai = new OpenAI({ apiKey });

  if (args.moodboard.length === 0) {
    // Fallback: no reference images, use plain generation
    const result = await openai.images.generate({
      model: 'gpt-image-2',
      prompt: args.prompt,
      size: '1536x1024',
      quality: 'high',
      n: 1,
    });
    const b64 = result.data?.[0]?.b64_json;
    if (!b64) throw new Error('Image generation returned no b64_json data');
    return Buffer.from(b64, 'base64');
  }

  // Pass moodboard images as visual style references via the Responses API
  const response = await openai.responses.create({
    model: 'gpt-5.5',
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: args.prompt },
          ...args.moodboard.map((img) => ({
            type: 'input_image' as const,
            detail: 'high' as const,
            image_url: `data:${img.mediaType};base64,${img.data}`,
          })),
        ],
      },
    ],
    tools: [{ type: 'image_generation', quality: 'high', size: '1536x1024' } as const],
  });

  const imageBlock = response.output.find((b) => b.type === 'image_generation_call');
  if (!imageBlock || imageBlock.type !== 'image_generation_call') {
    throw new Error('Responses API returned no image_generation_call block');
  }
  if (!imageBlock.result) {
    throw new Error('image_generation_call block has no result data');
  }
  return Buffer.from(imageBlock.result, 'base64');
}

// ---------------------------------------------------------------------------
// Brand image path (BLOG_IMAGE_STYLE=brand)
// ---------------------------------------------------------------------------

async function runBrandSubjectWriter(args: {
  title: string;
  excerpt: string;
}): Promise<{ subject: string; accentColor: '#1A65FF' | '#FFCD2E' | '#FE342C'; altText: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  const openai = createOpenAI({ apiKey });
  const { object } = await generateObject({
    model: openai('gpt-5.4'),
    system: BRAND_SUBJECT_SYSTEM,
    prompt: buildBrandSubjectUserText({ title: args.title, excerpt: args.excerpt }),
    schema: brandSubjectSchema,
    maxRetries: 2,
  });
  return object;
}

async function generateBrandCoverImage(args: {
  subject: string;
  accentColor: '#1A65FF' | '#FFCD2E' | '#FE342C';
  altText: string;
}): Promise<Buffer> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  const openai = new OpenAI({ apiKey });
  const prompt = buildBrandMasterPrompt(args);
  const result = await openai.images.generate({
    model: 'gpt-image-2',
    prompt,
    size: '1536x1024',
    quality: 'high',
    n: 1,
  });
  const b64 = result.data?.[0]?.b64_json;
  if (!b64) throw new Error('Brand image generation returned no b64_json data');
  return Buffer.from(b64, 'base64');
}

// ---------------------------------------------------------------------------

async function publishBlog(args: {
  writer: WriterResult;
  coverImage: Buffer;
  imagePrompt: string;
  altText: string;
  uniqueSlug: string;
}): Promise<{ id: string; slug: string }> {
  const client = getSanityWriteClient();

  const asset = await client.assets.upload('image', args.coverImage, {
    filename: `${args.uniqueSlug}-cover.png`,
    contentType: 'image/png',
  });

  const now = new Date().toISOString();
  const body = blocksToPortableText(args.writer.blocks);

  const doc = await client.create({
    _type: 'blog',
    title: args.writer.title,
    slug: { _type: 'slug', current: args.uniqueSlug },
    excerpt: args.writer.excerpt,
    publishedAt: now,
    updatedAt: now,
    featured: false,
    mainImage: {
      _type: 'image',
      asset: { _type: 'reference', _ref: asset._id },
      alt: args.altText,
    },
    body,
    seo: {
      metaTitle: args.writer.title,
      metaDescription: args.writer.excerpt,
    },
  });

  return { id: doc._id, slug: args.uniqueSlug };
}

export async function POST(req: Request) {
  return handle(req);
}

export async function GET(req: Request) {
  return handle(req);
}

async function handle(req: Request) {
  const startedAt = Date.now();

  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    console.log('[blog-writer] run started');

    const [items, recentPosts, moodboard] = await Promise.all([
      fetchNewsFeed({ perFeed: 12 }),
      fetchRecentPosts().catch((e) => {
        console.error('[blog-writer] failed to fetch recent posts:', e);
        return [] as RecentPost[];
      }),
      loadMoodboardImages(),
    ]);
    if (moodboard.length === 0) {
      console.warn('[blog-writer] no moodboard images found, proceeding without them');
    }
    const feedSummary = formatFeedForPrompt(items);
    console.log(`[blog-writer] fetched ${items.length} feed items, ${recentPosts.length} recent posts, ${moodboard.length} moodboard images`);

    const writer = await runWriter({ feedSummary, recentPosts });
    console.log(`[blog-writer] picked story: "${writer.selectedHeadline}" → "${writer.title}"`);

    const uniqueSlug = await ensureUniqueSlug(writer.slug);
    if (uniqueSlug !== writer.slug) {
      console.log(`[blog-writer] slug collision, using "${uniqueSlug}" instead of "${writer.slug}"`);
    }

    const imageStyle = process.env.BLOG_IMAGE_STYLE ?? 'moodboard';
    console.log(`[blog-writer] image style: ${imageStyle}`);

    let imagePrompt: string;
    let altText: string;
    let coverImage: Buffer;

    if (imageStyle === 'brand') {
      const brand = await runBrandSubjectWriter({ title: writer.title, excerpt: writer.excerpt });
      imagePrompt = buildBrandMasterPrompt(brand);
      altText = brand.altText;
      console.log(`[blog-writer] brand subject: "${brand.subject}" accent: ${brand.accentColor}`);
      coverImage = await generateBrandCoverImage(brand);
    } else {
      const imgResult = await runImagePromptWriter({ title: writer.title, excerpt: writer.excerpt, moodboard });
      imagePrompt = imgResult.prompt;
      altText = imgResult.altText;
      console.log(`[blog-writer] image prompt generated (${imagePrompt.length} chars)`);
      coverImage = await generateCoverImage({ prompt: imagePrompt, moodboard });
    }
    console.log(`[blog-writer] cover image generated (${coverImage.length} bytes)`);

    const result = await publishBlog({
      writer,
      coverImage,
      imagePrompt,
      altText,
      uniqueSlug,
    });

    revalidateTag(SANITY_TAG_POSTS);
    revalidatePath('/blog');
    revalidatePath(`/blog/${result.slug}`);
    revalidatePath('/blog/rss.xml');

    const durationMs = Date.now() - startedAt;
    console.log(`[blog-writer] published "${writer.title}" → /blog/${result.slug} (${durationMs}ms)`);

    return NextResponse.json({
      ok: true,
      id: result.id,
      slug: result.slug,
      title: writer.title,
      sourceHeadline: writer.selectedHeadline,
      sourceLink: writer.selectedLink,
      durationMs,
    });
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error('[blog-writer] FAILED:', message, stack ?? '');
    return NextResponse.json(
      { ok: false, error: message, durationMs },
      { status: 500 },
    );
  }
}
