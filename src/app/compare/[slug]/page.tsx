import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { EditorialGrid, LandingFooter, LandingNav } from '@/components/landing/shared';
import {
  ClosingCta,
  CompareHero,
  CompareTable,
  DeepDives,
  FaqSection,
  GlanceCards,
  HonestyNote,
  LineDivider,
  RelatedStrip,
  StrengthsSplit,
  VerdictCards,
} from '@/components/landing/compare-ui';
import {
  COMPETITORS,
  COMPETITOR_SLUGS,
  LAST_UPDATED,
  alternativesHref,
  compareHref,
  competitorFromCompareParam,
} from '@/lib/marketing/competitors';

export const dynamicParams = false;

export function generateStaticParams() {
  return COMPETITOR_SLUGS.map((slug) => ({ slug: `botflow-vs-${slug}` }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const competitor = competitorFromCompareParam(slug);
  if (!competitor) return {};
  return {
    title: { absolute: competitor.compareMeta.title },
    description: competitor.compareMeta.description,
    alternates: { canonical: `/compare/${slug}` },
    openGraph: {
      title: competitor.compareMeta.title,
      description: competitor.compareMeta.description,
      type: 'article',
      url: `/compare/${slug}`,
    },
    twitter: {
      card: 'summary_large_image',
      title: competitor.compareMeta.title,
      description: competitor.compareMeta.description,
    },
  };
}

export default async function ComparePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const competitor = competitorFromCompareParam(slug);
  if (!competitor) notFound();

  const related = [
    ...COMPETITOR_SLUGS.filter((s) => s !== competitor.slug).map((s) => ({
      href: compareHref(s),
      label: `Botflow vs ${COMPETITORS[s].name}`,
    })),
    {
      href: alternativesHref(competitor.slug),
      label: `${competitor.name} alternatives`,
    },
  ];

  const faqJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: competitor.compareFaqs.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
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
        name: `Botflow vs ${competitor.name}`,
        item: `https://botflow.io/compare/${slug}`,
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
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />

      <EditorialGrid />
      <LandingNav />

      <main className="relative z-10">
        <CompareHero
          label="Compare"
          titlePre="Botflow"
          titleEm="vs"
          titlePost={competitor.name}
          intro={competitor.heroIntro}
          updated={LAST_UPDATED}
        />

        <HonestyNote name={competitor.name} />

        <GlanceCards
          usBlurb={competitor.glance.us.blurb}
          usBestFor={competitor.glance.us.bestFor}
          themName={competitor.name}
          themBlurb={competitor.glance.them.blurb}
          themBestFor={competitor.glance.them.bestFor}
        />

        <LineDivider />
        <CompareTable themName={competitor.name} groups={competitor.tableGroups} />

        <LineDivider />
        <StrengthsSplit
          themName={competitor.name}
          theirStrengths={competitor.theirStrengths}
          ourStrengths={competitor.ourStrengths}
        />

        <LineDivider />
        <DeepDives dives={competitor.deepDives} />

        <LineDivider />
        <VerdictCards
          themName={competitor.name}
          chooseThem={competitor.chooseThem}
          chooseUs={competitor.chooseUs}
        />

        <LineDivider />
        <FaqSection faqs={competitor.compareFaqs} />

        <RelatedStrip links={related} />

        <ClosingCta
          heading="See the difference"
          em="yourself"
          sub="Describe an app. Watch it run. Free to start — no credit card."
        />
      </main>

      <LandingFooter />
    </div>
  );
}
