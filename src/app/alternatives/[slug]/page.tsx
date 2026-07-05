import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { EditorialGrid, LandingFooter, LandingNav } from '@/components/landing/shared';
import {
  AlternativesList,
  AltQuickTable,
  ClosingCta,
  CompareHero,
  FaqSection,
  HonestyNote,
  LineDivider,
  RelatedStrip,
  WhySwitchCards,
} from '@/components/landing/compare-ui';
import {
  ALT_PROFILES,
  COMPETITORS,
  COMPETITOR_SLUGS,
  LAST_UPDATED,
  alternativesHref,
  compareHref,
  type CompetitorSlug,
} from '@/lib/marketing/competitors';

export const dynamicParams = false;

export function generateStaticParams() {
  return COMPETITOR_SLUGS.map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const competitor = COMPETITORS[slug as CompetitorSlug];
  if (!competitor) return {};
  return {
    title: { absolute: competitor.altMeta.title },
    description: competitor.altMeta.description,
    alternates: { canonical: `/alternatives/${slug}` },
    openGraph: {
      title: competitor.altMeta.title,
      description: competitor.altMeta.description,
      type: 'article',
      url: `/alternatives/${slug}`,
    },
    twitter: {
      card: 'summary_large_image',
      title: competitor.altMeta.title,
      description: competitor.altMeta.description,
    },
  };
}

export default async function AlternativesPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const competitor = COMPETITORS[slug as CompetitorSlug];
  if (!competitor) notFound();

  const profiles = competitor.alt.list
    .map((key) => ALT_PROFILES[key])
    .filter(Boolean);

  const related = [
    { href: compareHref(competitor.slug), label: `Botflow vs ${competitor.name}` },
    ...COMPETITOR_SLUGS.filter((s) => s !== competitor.slug).map((s) => ({
      href: alternativesHref(s),
      label: `${COMPETITORS[s].name} alternatives`,
    })),
  ];

  const faqJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: competitor.alt.faqs.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };

  const itemListJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `${competitor.name} alternatives`,
    itemListElement: profiles.map((p, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: p.name,
      ...(p.url ? { url: p.url } : {}),
    })),
  };

  const breadcrumbJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://botflow.io' },
      { '@type': 'ListItem', position: 2, name: 'Compare', item: 'https://botflow.io/compare' },
      {
        '@type': 'ListItem',
        position: 3,
        name: `${competitor.name} alternatives`,
        item: `https://botflow.io/alternatives/${slug}`,
      },
    ],
  };

  return (
    <div className="relative min-h-screen bg-[var(--sand-bg)] text-[var(--sand-text)] antialiased overflow-x-hidden">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(itemListJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />

      <EditorialGrid />
      <LandingNav />

      <main className="relative z-10">
        <CompareHero
          label="Alternatives"
          titlePre={`${competitor.name} alternatives,`}
          titleEm="honestly compared"
          intro={competitor.alt.heroIntro}
          updated={LAST_UPDATED}
        />

        <HonestyNote name={competitor.name} />

        <WhySwitchCards name={competitor.name} items={competitor.alt.whySwitch} />

        <LineDivider />
        <AlternativesList profiles={profiles} />

        <LineDivider />
        <AltQuickTable profiles={profiles} />

        <LineDivider />
        <FaqSection faqs={competitor.alt.faqs} />

        <RelatedStrip links={related} />

        <ClosingCta
          heading="Try the top pick"
          em="free"
          sub="Describe an app. Watch it run. No credit card required."
        />
      </main>

      <LandingFooter />
    </div>
  );
}
