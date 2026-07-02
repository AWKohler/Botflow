// ============================================================================
// Competitor comparison + alternatives page content.
//
// Editorial rules for everything in this file:
//   1. Honest first. Where a competitor is genuinely better, say so plainly.
//      These pages earn trust (and AI-overview citations) by being useful,
//      not by being a brochure.
//   2. Never over-claim Botflow. Native iOS is *early access*. Publishing
//      requires the user's own Apple Developer account — same as every tool.
//   3. Facts should be durable. Describe pricing models, not price points
//      that go stale. Date the page instead (LAST_UPDATED).
// ============================================================================

export const LAST_UPDATED = 'July 2026';

export type CompetitorSlug = 'lovable' | 'rork' | 'vibecode' | 'bloom' | 'base44';

export interface CompareRow {
  feature: string;
  us: boolean | string;
  them: boolean | string;
}

export interface CompareGroup {
  label: string;
  rows: CompareRow[];
}

export interface Strength {
  title: string;
  body: string;
}

export interface DeepDive {
  title: string;
  em: string; // italicized (accent) part of the heading
  paragraphs: string[];
}

export interface Faq {
  q: string;
  a: string;
}

// A short reusable profile of a product, used on the "alternatives" pages.
export interface AltProfile {
  key: string;
  name: string;
  oneLiner: string;
  bestFor: string;
  strengths: string[];
  tradeoffs: string[];
  pricingNote: string;
  /** Official site — only set when we're certain of the domain. */
  url?: string;
  /** Link to our head-to-head page when one exists. */
  compareSlug?: CompetitorSlug;
  isBotflow?: boolean;
  facts: {
    platforms: string;
    backend: string;
    code: string;
    native: string;
  };
}

export interface Competitor {
  slug: CompetitorSlug;
  name: string;
  compareMeta: { title: string; description: string };
  altMeta: { title: string; description: string };
  /** Hero intro for the vs page — the honest TLDR. */
  heroIntro: string;
  glance: {
    us: { blurb: string; bestFor: string };
    them: { blurb: string; bestFor: string };
  };
  tableGroups: CompareGroup[];
  theirStrengths: Strength[];
  ourStrengths: Strength[];
  deepDives: DeepDive[];
  chooseThem: string[];
  chooseUs: string[];
  compareFaqs: Faq[];
  alt: {
    heroIntro: string;
    whySwitch: Strength[];
    /** Keys into ALT_PROFILES, in ranked order. Botflow is always first. */
    list: string[];
    faqs: Faq[];
  };
}

// ============================================================================
// Reusable product profiles for the alternatives lists
// ============================================================================

export const ALT_PROFILES: Record<string, AltProfile> = {
  botflow: {
    key: 'botflow',
    name: 'Botflow',
    oneLiner:
      'An AI app builder that ships real full-stack web apps and real native iOS apps from one conversation.',
    bestFor:
      'Shipping a real product — a web app, a native iOS app, or both — from one workspace.',
    strengths: [
      'A real backend from the first prompt — Convex (database, auth, real-time sync) is provisioned and wired automatically, no Firebase or Supabase setup.',
      'Bring your own Claude Pro or Max subscription and the actual Claude Code agent does the building — consuming zero platform credits. Or pick from 9+ models (GPT-5, Claude, Gemini, and more) with transparent per-token pricing.',
      'Real ownership end to end: standard React + Convex projects with GitHub sync on web, and native SwiftUI with managed App Store builds, server-side signing, and TestFlight upload (early access) on iOS.',
    ],
    tradeoffs: [
      'The native iOS pipeline is in early access — capacity opens in waves.',
      'Publishing to the App Store requires your own Apple Developer account ($99/yr) — true of every tool on this list.',
    ],
    pricingNote:
      'Free tier (no credit card), Pro and Max plans. Your own keys or Claude subscription are never marked up.',
    url: 'https://botflow.io',
    isBotflow: true,
    facts: {
      platforms: 'Web + native iOS',
      backend: 'Convex, included',
      code: 'Full export + GitHub',
      native: 'Managed (early access)',
    },
  },
  lovable: {
    key: 'lovable',
    name: 'Lovable',
    oneLiner:
      'The category-defining AI web-app builder — polished React apps with a Supabase-backed cloud.',
    bestFor: 'Polished web MVPs with the largest community behind you.',
    strengths: [
      'The fastest path from prompt to a genuinely good-looking web app.',
      'Full visual editing — click any element and change it without spending credits.',
      'Huge community, template ecosystem, and team/multiplayer features.',
    ],
    tradeoffs: [
      'No native mobile apps — the docs are explicit that iOS/Android isn’t supported; you export and wrap the code yourself.',
      'Credit consumption on long debugging sessions is the most common complaint from heavy users.',
    ],
    pricingNote: 'Free tier, then credit-based subscriptions.',
    url: 'https://lovable.dev',
    compareSlug: 'lovable',
    facts: {
      platforms: 'Web only',
      backend: 'Supabase (Lovable Cloud)',
      code: 'Full export + GitHub',
      native: 'Not supported',
    },
  },
  base44: {
    key: 'base44',
    name: 'Base44',
    oneLiner:
      'The simplest all-in-one AI builder — database, auth, storage, and functions all built in. Owned by Wix.',
    bestFor: 'Non-technical builders who want zero setup decisions.',
    strengths: [
      'Everything is first-party: database, auth, file storage, serverless functions, email — one login, one bill.',
      'Arguably the fastest “describe it and it runs” experience in the category.',
      'A cheap “discuss mode” for planning before you spend build credits.',
    ],
    tradeoffs: [
      'The backend never leaves Base44 — migrating away means rebuilding, not porting. Lock-in is the most-cited complaint.',
      'Web only, and code export covers the frontend, not the backend.',
    ],
    pricingNote: 'Free tier, then credit-based subscriptions.',
    url: 'https://base44.com',
    compareSlug: 'base44',
    facts: {
      platforms: 'Web only',
      backend: 'Proprietary, built in',
      code: 'Frontend only',
      native: 'Not supported',
    },
  },
  rork: {
    key: 'rork',
    name: 'Rork',
    oneLiner:
      'A prompt-to-mobile-app builder: React Native cross-platform (Rork) and native SwiftUI with cloud publishing (Rork Max).',
    bestFor: 'Mobile-first builders who need Android as well as iOS.',
    strengths: [
      'Rork Max builds real SwiftUI on a cloud Mac fleet with a browser-streamed iOS Simulator and a fast App Store publish flow.',
      'An App Store Publishing AI that drafts your icon, screenshots, and store listing.',
      'Public, well-funded, and moving fast — a top App Store developer tool.',
    ],
    tradeoffs: [
      'No built-in backend — you bring and configure Firebase or Supabase yourself.',
      'No checkpoints or rollback, and reliability complaints (broken previews, publish retries) are common in reviews.',
    ],
    pricingNote: 'Credit-based subscriptions; code export on paid plans.',
    compareSlug: 'rork',
    facts: {
      platforms: 'iOS + Android (RN); iOS (Max)',
      backend: 'Bring your own',
      code: 'Export on paid plans',
      native: 'Managed (Rork Max)',
    },
  },
  vibecode: {
    key: 'vibecode',
    name: 'Vibecode',
    oneLiner:
      'The iPhone app that builds mobile apps — prompt on your phone, get a React Native app with media generation built in.',
    bestFor: 'Building small apps entirely from your phone.',
    strengths: [
      'The build-from-your-phone experience is genuinely magical — no computer needed.',
      'Built-in image and sound generation for app assets.',
      'A guided in-app App Store submission flow via Expo’s cloud builds.',
    ],
    tradeoffs: [
      'As an on-device builder app, it sits in the blast radius of Apple’s Guideline 2.5.2 enforcement — previews already had to move to an external browser.',
      'Output is React Native, not native SwiftUI, and publishing still needs your own Apple Developer account plus an Expo token.',
    ],
    pricingNote: 'Subscription via the App Store.',
    compareSlug: 'vibecode',
    facts: {
      platforms: 'iOS-first (React Native)',
      backend: 'Limited, built in',
      code: 'Limited export',
      native: 'Via Expo/EAS',
    },
  },
  bloom: {
    key: 'bloom',
    name: 'Bloom',
    oneLiner:
      'Build native-feel mobile apps with no code and share them instantly by link, QR, or App Clip — no App Store needed for demos.',
    bestFor: 'Instantly shareable app prototypes.',
    strengths: [
      'App Clip / link sharing is the fastest “try my app” experience in the category — no install, no developer account, seconds to share.',
      'Exports a standard Expo + Convex project — real code, GitHub sync, a genuinely good stack.',
      'One of the most generous free tiers in the category.',
    ],
    tradeoffs: [
      'No managed App Store publishing — a real store listing means exporting the code and running EAS builds with your own certificates.',
      'Output is React Native, not native SwiftUI.',
    ],
    pricingNote: 'Generous free tier, then subscriptions.',
    compareSlug: 'bloom',
    facts: {
      platforms: 'iOS + Android (RN)',
      backend: 'Convex, included',
      code: 'Full export + GitHub',
      native: 'DIY (EAS CLI)',
    },
  },
  bolt: {
    key: 'bolt',
    name: 'Bolt.new',
    oneLiner:
      'StackBlitz’s AI builder — fast in-browser full-stack web apps with broad framework support.',
    bestFor: 'Web apps when you want framework flexibility beyond React.',
    strengths: [
      'Supports many frameworks (React, Vue, Svelte, Astro, and more), not just one blessed stack.',
      'Very fast in-browser dev loop built on StackBlitz’s WebContainer technology.',
      'Straightforward code download and GitHub export.',
    ],
    tradeoffs: [
      'Backend, auth, and database are integrations you assemble rather than something provisioned for you.',
      'No native mobile pipeline.',
    ],
    pricingNote: 'Free tier, then token-based subscriptions.',
    url: 'https://bolt.new',
    facts: {
      platforms: 'Web only',
      backend: 'Via integrations',
      code: 'Full export + GitHub',
      native: 'Not supported',
    },
  },
  v0: {
    key: 'v0',
    name: 'v0',
    oneLiner:
      'Vercel’s AI builder — exceptional React/Next.js UI generation, deeply tied into the Vercel ecosystem.',
    bestFor: 'UI-first builds that will live on Vercel anyway.',
    strengths: [
      'Best-in-class UI generation quality for React + Tailwind + shadcn/ui.',
      'First-party Vercel deployment and ecosystem integration.',
      'Great for handing polished components to an existing codebase.',
    ],
    tradeoffs: [
      'More a UI and prototyping tool than an end-to-end app platform — backend and auth are yours to assemble.',
      'No native mobile story.',
    ],
    pricingNote: 'Free tier, then usage-based subscriptions.',
    url: 'https://v0.dev',
    facts: {
      platforms: 'Web only',
      backend: 'Via integrations',
      code: 'Full export',
      native: 'Not supported',
    },
  },
  replit: {
    key: 'replit',
    name: 'Replit',
    oneLiner:
      'The general-purpose cloud IDE with an AI agent — build anything, in any language, with hosting attached.',
    bestFor: 'Technical generality — when your project isn’t a typical web app.',
    strengths: [
      'Not limited to one stack: Python, Node, Go, games, bots, APIs — anything.',
      'Replit Agent can scaffold and iterate on full projects, with hosting, databases, and auth available in-platform.',
      'A massive education and hobbyist community.',
    ],
    tradeoffs: [
      'The generality cuts both ways — less opinionated, so non-technical users face more decisions than on app-builder-shaped tools.',
      'Its own mobile-builder surface has faced the same Apple 2.5.2 pressure as other on-device builders.',
    ],
    pricingNote: 'Free tier, then subscription plus usage.',
    url: 'https://replit.com',
    facts: {
      platforms: 'Web + general compute',
      backend: 'In-platform options',
      code: 'Full export + git',
      native: 'Not supported',
    },
  },
  a0: {
    key: 'a0',
    name: 'a0.dev',
    oneLiner:
      'A focused prompt-to-React-Native tool for getting mobile app ideas onto a device quickly.',
    bestFor: 'Quick React Native prototypes on a real phone.',
    strengths: [
      'Tight loop from prompt to a running app on your device.',
      'Mobile-first from the ground up rather than a web tool with mobile bolted on.',
    ],
    tradeoffs: [
      'A smaller product with a smaller ecosystem than the funded players.',
      'App Store publishing and backend are largely yours to handle.',
    ],
    pricingNote: 'Free tier, then subscriptions.',
    url: 'https://a0.dev',
    facts: {
      platforms: 'iOS + Android (RN)',
      backend: 'Bring your own',
      code: 'Export available',
      native: 'DIY',
    },
  },
  flutterflow: {
    key: 'flutterflow',
    name: 'FlutterFlow',
    oneLiner:
      'The established visual app builder — drag-and-drop Flutter apps for iOS, Android, and web, with AI assists.',
    bestFor: 'Visual builders who want mature cross-platform tooling.',
    strengths: [
      'Years of maturity: a deep widget library, Firebase/Supabase integrations, and real production apps in the wild.',
      'True cross-platform output (iOS, Android, web) from one project.',
      'Full Flutter code export.',
    ],
    tradeoffs: [
      'It’s a visual builder you learn, not a conversation — the learning curve is real.',
      'Output is Flutter/Dart, a different ecosystem from the JavaScript/Swift mainstream.',
    ],
    pricingNote: 'Free tier, then per-seat subscriptions.',
    url: 'https://flutterflow.io',
    facts: {
      platforms: 'iOS + Android + Web (Flutter)',
      backend: 'Firebase/Supabase integrations',
      code: 'Full export',
      native: 'Guided, via your accounts',
    },
  },
};

// ============================================================================
// The five head-to-head competitors
// ============================================================================

export const COMPETITORS: Record<CompetitorSlug, Competitor> = {
  // ==========================================================================
  // LOVABLE
  // ==========================================================================
  lovable: {
    slug: 'lovable',
    name: 'Lovable',
    compareMeta: {
      title: 'Botflow vs Lovable (2026) — an honest comparison',
      description:
        'Lovable is the biggest name in AI web-app building. Botflow builds web apps too — then goes where Lovable doesn’t: real native iOS apps, a portable Convex backend, and building with your own Claude subscription. An honest side-by-side.',
    },
    altMeta: {
      title: '5 Best Lovable Alternatives in 2026 (Compared Honestly)',
      description:
        'Looking for a Lovable alternative? An honest comparison of Botflow, Base44, Bolt.new, v0, and Replit — including native mobile support, backend portability, and how each one charges for AI.',
    },
    heroIntro:
      'Lovable is the biggest name in AI app building, and it earned that: if you want a polished web MVP from a prompt, it’s excellent. Botflow covers the same ground — full-stack web apps from a conversation — and then goes where Lovable doesn’t: a real native iOS app, built, previewed, and published from the same chat. Here’s an honest look at both.',
    glance: {
      them: {
        blurb:
          'The category-defining AI web-app builder. Describe an app and get a polished React frontend with a Supabase-backed cloud, click-to-edit visual controls, team features, and one-click publishing. Massive community and momentum.',
        bestFor: 'Polished web MVPs with the largest ecosystem behind you.',
      },
      us: {
        blurb:
          'An AI app builder that pairs full-stack web apps (React + a real-time Convex backend) with a native iOS pipeline — real SwiftUI, a streamed iOS Simulator in your browser, and managed App Store publishing, currently in early access. Bring your own Claude subscription and the building costs you zero credits.',
        bestFor: 'Founders who want a web app and a real app in the App Store.',
      },
    },
    tableGroups: [
      {
        label: 'Platforms',
        rows: [
          { feature: 'Full-stack web apps', us: true, them: true },
          { feature: 'Native iOS apps', us: 'SwiftUI (early access)', them: false },
          { feature: 'App Store publishing', us: 'Managed (early access)', them: false },
          { feature: 'Android apps', us: false, them: false },
        ],
      },
      {
        label: 'AI & cost',
        rows: [
          {
            feature: 'Use your own Claude subscription',
            us: 'Yes — the real Claude Code agent',
            them: false,
          },
          { feature: 'Choose your model', us: '9+ models (GPT-5, Claude, Gemini…)', them: 'Managed for you' },
          { feature: 'Bring your own API keys', us: true, them: false },
          { feature: 'Credit pricing', us: 'Per-token, published multipliers', them: 'Per-message credits' },
        ],
      },
      {
        label: 'Backend & data',
        rows: [
          { feature: 'Backend included', us: 'Convex (real-time, typed)', them: 'Supabase (Lovable Cloud)' },
          { feature: 'Auth included', us: true, them: true },
          { feature: 'Bring your own backend account', us: 'Yes — connect your Convex', them: 'Supabase only' },
          { feature: 'Real-time sync by default', us: true, them: 'Via Supabase subscriptions' },
        ],
      },
      {
        label: 'Code & shipping',
        rows: [
          { feature: 'You own the code', us: true, them: true },
          { feature: 'GitHub', us: 'Real git in the workspace — branches, PRs', them: 'Two-way sync' },
          { feature: 'One-click deploy', us: 'Cloudflare + custom domains', them: 'Lovable hosting + custom domains' },
          { feature: 'Visual click-to-edit', us: 'Basic (styling)', them: 'Full visual edits' },
          { feature: 'Team multiplayer', us: false, them: true },
        ],
      },
    ],
    theirStrengths: [
      {
        title: 'Web polish, instantly',
        body: 'Lovable’s first-minutes experience is the best in the category: seconds from prompt to a deployed, genuinely attractive web app. For a pure web MVP, that magic is real.',
      },
      {
        title: 'Visual edits',
        body: 'Click any element and change text, styles, or layout directly — without spending AI credits. Lovable’s visual editing is more complete than Botflow’s, which currently covers styling only.',
      },
      {
        title: 'Community and momentum',
        body: 'Millions of users, a deep template ecosystem, team workspaces, and enterprise features. If you want the tool everyone else uses, this is it.',
      },
    ],
    ourStrengths: [
      {
        title: 'A native iOS path',
        body: 'Lovable’s own docs say native apps aren’t supported — the suggested route is exporting your code and wrapping it yourself. Botflow builds real SwiftUI, previews it on a real iOS Simulator streamed to your browser, and manages the App Store build and signing (early access).',
      },
      {
        title: 'Your Claude subscription, the real Claude Code',
        body: 'If you already pay for Claude Pro or Max, Botflow runs the actual Claude Code agent on your subscription — full agentic quality, zero platform credits consumed. No other builder in the category offers this.',
      },
      {
        title: 'Model choice with honest pricing',
        body: 'Pick GPT-5, Claude, Gemini, and more — or bring your own API keys at zero markup. Credits are per-token with published per-model multipliers, so a heavy debugging session never feels like a slot machine.',
      },
      {
        title: 'A backend that can leave with you',
        body: 'Botflow provisions Convex — typed, real-time, and portable. Connect your own Convex account and the backend is literally yours. Lovable Cloud is Supabase underneath, but the managed path keeps you inside Lovable’s wrapper.',
      },
    ],
    deepDives: [
      {
        title: 'The native',
        em: 'question',
        paragraphs: [
          'A whole ecosystem of third-party tools exists purely to convert Lovable apps into React Native — which tells you two things: Lovable users want real mobile apps, and Lovable doesn’t make them. The official answer is a progressive web app or exporting your code to wrap with Capacitor, a route that carries real App Store rejection risk for web-wrapper apps.',
          'Botflow’s approach is different in kind, not degree: describe your app, and the agent writes real SwiftUI — the same framework Apple’s own apps use — then builds it on managed Mac infrastructure and streams a real iOS Simulator into your browser. When you’re ready, a guided wizard handles the archive, signing, and TestFlight upload server-side. You never touch Xcode.',
          'The honest caveats: Botflow’s iOS platform is in early access, and publishing requires your own Apple Developer account ($99/year) — that last part is true of every tool that ships to the App Store, including this one.',
        ],
      },
      {
        title: 'Who pays for',
        em: 'the AI',
        paragraphs: [
          'The most common complaint about AI builders — Lovable included — is watching credits disappear into a debugging loop. Most tools charge per message against a hidden model with an opaque credit definition.',
          'Botflow takes the opposite bet: transparency and choice. Nine-plus models with published per-token multipliers, bring-your-own API keys at zero markup, and — uniquely — the option to sign in with your Claude Pro or Max subscription and have the real Claude Code agent do the work at no credit cost at all. Your subscription, your agent, our infrastructure.',
        ],
      },
      {
        title: 'Security by',
        em: 'architecture',
        paragraphs: [
          'In 2025, a misconfiguration pattern in Lovable-generated apps (missing Supabase row-level-security policies, catalogued as CVE-2025-48757) left personal data readable in at least 170 published apps. That’s not a knock on Supabase — it’s evidence that security policies bolted on per-table are easy for generated code to forget.',
          'Convex, Botflow’s backend, takes a structurally different approach: the database is only reachable through typed server functions, so there is no direct-from-browser table access to misconfigure in the first place. No architecture makes an app automatically secure — but defaults matter, and this class of leak simply doesn’t have the same footgun shape on Convex.',
        ],
      },
    ],
    chooseThem: [
      'You want the most polished pure-web builder with the largest community and template ecosystem',
      'Click-to-edit visual design control matters to you day-to-day',
      'You’re building with a team and want multiplayer workspaces',
      'A web app or PWA is genuinely all you need',
    ],
    chooseUs: [
      'You want your product in the App Store, not just in a browser tab',
      'You already pay for Claude Pro or Max and want it building for you at zero markup',
      'You want to choose your model — and see exactly what each turn costs',
      'You want a typed, real-time backend you can take with you (or bring your own)',
    ],
    compareFaqs: [
      {
        q: 'Is Botflow a good alternative to Lovable?',
        a: 'If you only ever want web apps, both are strong and Lovable has the bigger ecosystem. Botflow becomes the clear choice when you want a native iOS app too, when you have a Claude subscription you’d like to build with at no extra cost, or when you want model choice and per-token pricing instead of per-message credits.',
      },
      {
        q: 'Can Lovable build native mobile apps?',
        a: 'No. Lovable’s documentation states native mobile apps aren’t supported — the recommended path is a progressive web app, or exporting your code and wrapping it with a tool like Capacitor yourself. Botflow builds real SwiftUI iOS apps with managed App Store publishing, currently in early access.',
      },
      {
        q: 'Do Botflow and Lovable both give you the code?',
        a: 'Yes — both are genuinely export-friendly with GitHub support, which is not true of every builder. The difference is the backend: Lovable Cloud runs on Supabase inside Lovable’s wrapper, while Botflow provisions Convex and lets you connect your own Convex account, so the backend itself is portable.',
      },
      {
        q: 'How do Botflow and Lovable pricing compare?',
        a: 'Both have free tiers and paid subscriptions. The structural difference: Lovable charges per-message credits against a managed model. Botflow prices per-token with published per-model multipliers, lets you bring your own API keys at zero markup, and lets Claude Pro/Max subscribers build using their existing subscription without consuming credits at all.',
      },
    ],
    alt: {
      heroIntro:
        'Lovable is a genuinely good product — the fastest route from a prompt to a polished web app, with a huge community behind it. But it isn’t the right tool for everyone: there’s no native mobile path, heavy debugging sessions burn credits fast, and the managed backend keeps you on one stack. Here are the alternatives worth your time, compared honestly.',
      whySwitch: [
        {
          title: 'You need a real mobile app',
          body: 'Lovable’s docs are explicit: native iOS and Android aren’t supported. If the App Store is part of your plan, you need a tool where mobile isn’t an export-and-figure-it-out afterthought.',
        },
        {
          title: 'Credit burn on iteration',
          body: 'Per-message credits against a managed model mean a stubborn bug can eat a week’s allowance. Tools with model choice, BYO keys, or subscription-based agents change that math.',
        },
        {
          title: 'One managed stack',
          body: 'Lovable Cloud is Supabase under a managed wrapper. It’s good infrastructure — but if you want to choose or own your backend, you’ll want a tool that treats that as a feature, not a workaround.',
        },
      ],
      list: ['botflow', 'base44', 'bolt', 'v0', 'replit'],
      faqs: [
        {
          q: 'What is the best Lovable alternative?',
          a: 'It depends on what pulled you away. For native iOS apps alongside web, Botflow (our product — bias declared) is the only one on this list with a managed App Store pipeline. For maximum simplicity, Base44. For framework flexibility, Bolt.new. For UI quality on Vercel, v0. For technical generality, Replit.',
        },
        {
          q: 'Can I migrate my Lovable project to another tool?',
          a: 'Partially. Lovable exports real React code via GitHub, so your frontend travels well — most builders (Botflow included) can work on an imported React codebase. The Supabase backend is the sticky part: you’ll typically re-point the app at a new backend rather than lift the managed one out.',
        },
        {
          q: 'Are there free alternatives to Lovable?',
          a: 'Every tool on this list has a free tier. Botflow’s free plan needs no credit card, and if you have a Claude Pro/Max subscription you can build with it at no additional model cost — the most generous arrangement here for existing Claude subscribers.',
        },
      ],
    },
  },

  // ==========================================================================
  // RORK
  // ==========================================================================
  rork: {
    slug: 'rork',
    name: 'Rork',
    compareMeta: {
      title: 'Botflow vs Rork (2026) — native iOS app builders compared',
      description:
        'Rork Max and Botflow both turn prompts into real SwiftUI apps with cloud Macs and streamed simulators. The differences: Botflow includes a Convex backend with auth, runs on your own Claude subscription, and treats web apps as first-class. Honest comparison.',
    },
    altMeta: {
      title: '5 Best Rork Alternatives in 2026 (Compared Honestly)',
      description:
        'Looking for a Rork alternative? An honest comparison of Botflow, Bloom, Vibecode, a0.dev, and FlutterFlow — including which ones include a backend, handle App Store publishing, and offer rollback when the AI breaks something.',
    },
    heroIntro:
      'Rork and Botflow are the two tools attacking the same hard problem: taking a prompt all the way to a real, native iOS app in the App Store. Rork is further along publicly — it’s generally available, funded, and moving fast. Botflow’s answer is a backend that comes included, an agent you can power with your own Claude subscription, and web apps that are first-class rather than an afterthought. Here’s the honest head-to-head.',
    glance: {
      them: {
        blurb:
          'A prompt-to-mobile-app builder with two products: Rork (React Native + Expo, cross-platform) and Rork Max (native SwiftUI built on a cloud Mac fleet, browser-streamed iOS Simulator, fast App Store publishing, and an AI that drafts your store listing). Public and well-funded.',
        bestFor: 'Mobile-first builders who need Android too, shipping today.',
      },
      us: {
        blurb:
          'The same architecture class as Rork Max — real SwiftUI, streamed simulator, managed server-side signing — plus what Rork leaves out: an auto-provisioned Convex backend with auth on the first prompt, checkpoints you can roll back to, real full-stack web apps, and the option to build on your own Claude subscription. Native pipeline in early access.',
        bestFor: 'Apps that need a database and login from the first prompt.',
      },
    },
    tableGroups: [
      {
        label: 'Platforms',
        rows: [
          { feature: 'Native iOS (SwiftUI)', us: 'Yes (early access)', them: 'Yes (Rork Max)' },
          { feature: 'Android', us: false, them: 'React Native (Rork Pro)' },
          { feature: 'Full-stack web apps', us: 'First-class (React + Convex)', them: 'Secondary target' },
          { feature: 'Real iOS Simulator in browser', us: true, them: true },
        ],
      },
      {
        label: 'Backend & data',
        rows: [
          { feature: 'Backend included', us: 'Convex, auto-provisioned', them: 'No — bring Firebase/Supabase' },
          { feature: 'Auth included', us: 'Wired by the agent', them: 'DIY' },
          { feature: 'Database dashboard in the IDE', us: true, them: false },
        ],
      },
      {
        label: 'AI & cost',
        rows: [
          { feature: 'Use your own Claude subscription', us: 'Yes — the real Claude Code agent', them: false },
          { feature: 'Choose your model', us: '9+ models', them: 'Fixed' },
          { feature: 'Bring your own API keys', us: true, them: false },
          { feature: 'Credit pricing', us: 'Per-token, published multipliers', them: 'Per-message credits' },
        ],
      },
      {
        label: 'Shipping & safety',
        rows: [
          { feature: 'Managed App Store publishing', us: 'Guided wizard (early access)', them: 'Yes (Max)' },
          { feature: 'Install on your device', us: 'Companion app, free Apple ID', them: 'QR / companion flow' },
          { feature: 'AI-generated store listing', us: false, them: true },
          { feature: 'Checkpoints / rollback', us: 'Snapshots + real git', them: false },
          { feature: 'You own the code', us: 'Always, with GitHub', them: 'Export on paid plans' },
        ],
      },
    ],
    theirStrengths: [
      {
        title: 'It’s shipping today',
        body: 'Rork Max is generally available, publicly battle-tested, and iterating fast with real funding behind it. Botflow’s native platform is in early access — if you need to publish this week, that difference matters and we won’t pretend otherwise.',
      },
      {
        title: 'App Store Publishing AI',
        body: 'Rork drafts your app icon, screenshots, description, and store page automatically, and pitches it as reducing review rejections. Botflow doesn’t have an equivalent yet — you bring your own store assets to the publish wizard.',
      },
      {
        title: 'Android, via Rork Pro',
        body: 'Rork’s React Native product covers iOS and Android from one codebase. Botflow is deliberately Apple-first: real SwiftUI, no Android today.',
      },
    ],
    ourStrengths: [
      {
        title: 'The backend is included',
        body: 'This is the biggest practical difference. A Rork app that needs accounts or data means setting up Firebase or Supabase yourself — keys, rules, SDKs. On Botflow, your first prompt gets a typed, real-time Convex database with auth wired by the agent. “Sign in and save my data” works before you’ve configured anything.',
      },
      {
        title: 'Your Claude subscription does the building',
        body: 'Botflow can run the real Claude Code agent on your existing Claude Pro/Max subscription — zero credits consumed. Rork uses the same model family but you pay for it through their credits, every message.',
      },
      {
        title: 'Rollback when the AI overreaches',
        body: 'The most common complaint from Rork users is losing a working app to a bad iteration with no way back. Botflow keeps sandbox snapshots and real git history in every workspace, so a working state is something you can return to.',
      },
      {
        title: 'Web apps that aren’t an afterthought',
        body: 'Sometimes the right first ship is a web app. Botflow’s web platform — React, Convex, one-click deploy with custom domains — is a full product, not a checkbox. With Rork you’d be using a mobile tool to make websites.',
      },
    ],
    deepDives: [
      {
        title: 'The backend',
        em: 'gap',
        paragraphs: [
          'Almost every real app needs the same three things: users can sign in, data persists, everyone sees updates. On Rork, that’s your homework — create a Firebase or Supabase project, manage keys, write security rules, and prompt the AI to integrate it all, with every mistake burning credits.',
          'Botflow provisions Convex automatically: a typed, real-time backend with auth the agent wires on the first prompt, and a database dashboard right in the workspace. It’s the difference between “build me an app” and “build me an app, after I do the infrastructure part myself.”',
        ],
      },
      {
        title: 'One tool or',
        em: 'two',
        paragraphs: [
          'Rork splits its offering: Rork (React Native, cross-platform) and Rork Max (native SwiftUI) are different products with different capabilities. Botflow is one workspace where a project is either a full-stack web app or a native SwiftUI app — same agent, same backend, same account.',
          'If Android is a hard requirement today, Rork Pro genuinely covers ground Botflow doesn’t, and you should weigh that. If your plan is iOS plus web — the most common indie combination — one tool that does both well beats two products stitched together.',
        ],
      },
      {
        title: 'What early access',
        em: 'actually means',
        paragraphs: [
          'Honesty over marketing: Rork Max is generally available today, and Botflow’s Swift platform is in early access with capacity opening in waves. If you need to ship a native app this week and can’t wait, Rork is the available option, full stop.',
          'What you get for joining Botflow’s early access is the architecture Rork users ask for: a backend included, checkpoints, transparent pricing, and the option to build on a Claude subscription you already pay for. Both tools require your own Apple Developer account ($99/year) to publish — no platform can waive Apple.',
        ],
      },
    ],
    chooseThem: [
      'You need to publish a native app this week — Rork Max is generally available now',
      'Android matters today (Rork Pro’s React Native covers both platforms)',
      'You want AI-drafted store listings, screenshots, and icons built in',
      'You prefer the tool with more public users and reviews to learn from',
    ],
    chooseUs: [
      'Your app needs accounts and data — Botflow includes a real backend from prompt one',
      'You already pay for Claude Pro or Max and want it building at zero credit cost',
      'You want checkpoints and real git history for when an iteration goes wrong',
      'You want real web apps and native iOS from a single tool',
    ],
    compareFaqs: [
      {
        q: 'Is Botflow a good alternative to Rork?',
        a: 'For apps that need a backend — accounts, saved data, real-time updates — yes, arguably the strongest one: Botflow auto-provisions a Convex database with auth, where Rork requires you to bring and configure Firebase or Supabase yourself. Rork’s advantages are general availability today, Android support via Rork Pro, and AI-generated store listings.',
      },
      {
        q: 'Does Rork include a backend?',
        a: 'No. Both Rork products expect you to bring your own backend, typically Firebase or Supabase, and integrate it via prompts. Botflow provisions a typed, real-time Convex backend with authentication automatically on every project that needs one.',
      },
      {
        q: 'Can both publish to the App Store?',
        a: 'Yes — both run managed build-and-sign pipelines on cloud Macs so you never touch Xcode. Botflow’s publish wizard is in early access; Rork Max’s flow is generally available. Both require your own Apple Developer account ($99/year); no tool can publish without one.',
      },
      {
        q: 'Rork Max vs Botflow — what’s actually different?',
        a: 'The build architecture is similar: real SwiftUI, cloud Mac builds, a streamed iOS Simulator in the browser. The differences are around it: Botflow includes a Convex backend with auth, supports rollback via snapshots and git, offers 9+ models or your own Claude subscription, and builds first-class web apps. Rork Max counters with general availability, store-listing AI, and Rork Pro for Android.',
      },
    ],
    alt: {
      heroIntro:
        'Rork earned its momentum: it made “prompt to App Store” feel real, and Rork Max’s native SwiftUI pipeline is genuinely impressive. But it’s not the right fit for everyone — there’s no built-in backend, no rollback when an iteration breaks your app, and reliability complaints are easy to find. Here are the alternatives worth considering, honestly compared.',
      whySwitch: [
        {
          title: 'No backend included',
          body: 'Rork apps that need login or data mean setting up Firebase or Supabase yourself — the single most common friction point. Some alternatives provision a real backend automatically.',
        },
        {
          title: 'No way back',
          body: 'No checkpoints or rollback means a bad AI iteration can cost you a working app. Reviews cite lost progress and context after a few iterations.',
        },
        {
          title: 'Fixed model, credit pricing',
          body: 'You build with the model Rork chose, paid through per-message credits. Alternatives offer model choice, BYO keys, or building on an AI subscription you already have.',
        },
      ],
      list: ['botflow', 'bloom', 'vibecode', 'a0', 'flutterflow'],
      faqs: [
        {
          q: 'What is the best Rork alternative?',
          a: 'For the same native-SwiftUI-with-managed-publishing architecture plus a built-in backend, Botflow (our product — bias declared) is the most direct alternative. Bloom is best for instantly shareable prototypes, Vibecode for building from your phone, a0.dev for quick React Native tests, and FlutterFlow for mature visual cross-platform building.',
        },
        {
          q: 'Which Rork alternatives include a backend?',
          a: 'Botflow and Bloom both build on Convex — a typed, real-time backend — rather than asking you to bring Firebase or Supabase. Botflow provisions and wires it (including auth) automatically; Bloom exports it as part of a standard Expo + Convex project.',
        },
        {
          q: 'Do any alternatives publish to the App Store for me?',
          a: 'Botflow manages the full build-sign-upload pipeline server-side (early access) — you bring only an Apple Developer account. Vibecode offers a guided flow through Expo’s cloud builds. Bloom and a0.dev leave store publishing to you. No tool can remove the Apple Developer account requirement.',
        },
      ],
    },
  },

  // ==========================================================================
  // VIBECODE
  // ==========================================================================
  vibecode: {
    slug: 'vibecode',
    name: 'Vibecode',
    compareMeta: {
      title: 'Botflow vs Vibecode (2026) — two ways to build mobile apps with AI',
      description:
        'Vibecode builds React Native apps from your iPhone. Botflow builds native SwiftUI from your browser — an architecture Apple’s Guideline 2.5.2 crackdown can’t touch. Both use Claude Code. An honest comparison of the two approaches.',
    },
    altMeta: {
      title: '4 Best Vibecode Alternatives in 2026 (Compared Honestly)',
      description:
        'Looking for a Vibecode alternative? An honest comparison of Botflow, Rork, Bloom, and a0.dev — including native SwiftUI options, Apple Guideline 2.5.2 exposure, and which tools manage App Store publishing for you.',
    },
    heroIntro:
      'Vibecode pioneered something genuinely delightful: building a mobile app from your phone, no computer involved. Botflow takes the opposite architectural bet — a full IDE in your browser producing native SwiftUI, previewed on a real streamed iOS Simulator. Both run on Claude under the hood. The deciding factors are where you want to build, what the output should be made of, and how much Apple-policy risk you want between you and your users.',
    glance: {
      them: {
        blurb:
          'The iPhone app that builds mobile apps. Prompt from your phone and get a React Native app, with image and sound generation built in and a guided App Store submission flow through Expo’s cloud builds. A genuinely magical demo — and a featured Anthropic customer.',
        bestFor: 'Building small apps entirely from your phone.',
      },
      us: {
        blurb:
          'A browser-based AI workspace that writes real SwiftUI — the same framework Apple’s own apps use — previews it on a real iOS Simulator streamed to any device with a browser, and manages App Store builds and signing server-side (early access). Plus full-stack web apps with a real Convex backend from the same chat.',
        bestFor: 'Real native apps meant to live in the App Store for years.',
      },
    },
    tableGroups: [
      {
        label: 'Where and what you build',
        rows: [
          { feature: 'Where you build', us: 'Any browser, any device', them: 'On your iPhone' },
          { feature: 'App output', us: 'Native SwiftUI', them: 'React Native + Expo' },
          { feature: 'Full-stack web apps', us: true, them: 'Web-to-mobile conversion' },
          { feature: 'Preview', us: 'Real iOS Simulator, streamed', them: 'External browser preview' },
        ],
      },
      {
        label: 'Apple policy exposure',
        rows: [
          { feature: 'Builder subject to App Review', us: 'No — it’s a web app', them: 'Yes — it’s an iOS app' },
          { feature: 'Guideline 2.5.2 exposure', us: 'Structurally low', them: 'Named in the 2026 crackdown' },
        ],
      },
      {
        label: 'AI & cost',
        rows: [
          { feature: 'Claude Code under the hood', us: true, them: true },
          { feature: 'Use your own Claude subscription', us: 'Yes — zero credits', them: false },
          { feature: 'Choose your model', us: '9+ models', them: 'Managed' },
          { feature: 'Built-in image / sound generation', us: false, them: true },
        ],
      },
      {
        label: 'Backend & shipping',
        rows: [
          { feature: 'Backend included', us: 'Convex (database, auth, real-time)', them: 'Limited' },
          { feature: 'App Store publishing', us: 'Managed signing, server-side (early access)', them: 'Guided, via Expo/EAS + your token' },
          { feature: 'You own the code', us: 'Always, with GitHub', them: 'Limited export' },
        ],
      },
    ],
    theirStrengths: [
      {
        title: 'Build from your phone',
        body: 'Vibecode’s core magic is real: idea to running app from the device in your pocket, no computer required. Botflow works in a phone browser, but it’s built for a bigger screen. For pure spontaneity, Vibecode wins.',
      },
      {
        title: 'Media generation built in',
        body: 'Images, sounds, and AI-API integrations are first-class inside Vibecode — generate your app’s assets where you build it. Botflow has no equivalent built in today.',
      },
      {
        title: 'A slick guided submission flow',
        body: 'Vibecode wraps Expo’s cloud builds in a genuinely friendly in-app GUI that walks you from project to App Store submission without touching a terminal.',
      },
    ],
    ourStrengths: [
      {
        title: 'An architecture Apple isn’t cracking down on',
        body: 'In March 2026 Apple began enforcing Guideline 2.5.2 against on-device app builders — Vibecode was named, previews were forced into external browsers, and one competitor was pulled from the store entirely. Botflow’s builder is a web app: there is no iOS builder app for Apple to reject. Your project can’t be orphaned by a policy change aimed at the tool that built it.',
      },
      {
        title: 'Native SwiftUI, not a JavaScript bridge',
        body: 'Botflow writes the framework Apple builds its own apps with — native performance, native look, and first-class access to Apple frameworks as the agent needs them. React Native is a fine technology, but for App-Store-first products, real SwiftUI is the higher fidelity path.',
      },
      {
        title: 'A real backend from the first prompt',
        body: 'Apps need accounts and data. Botflow provisions a typed, real-time Convex backend with auth wired automatically. On Vibecode, persistent multi-user backends are largely your problem to assemble.',
      },
      {
        title: 'Your Claude subscription, not another bill',
        body: 'Both products run Claude under the hood. The difference: Vibecode pays Anthropic and charges you credits; Botflow can run the real Claude Code agent directly on your existing Claude Pro/Max subscription — zero credits consumed.',
      },
    ],
    deepDives: [
      {
        title: 'The 2.5.2',
        em: 'problem',
        paragraphs: [
          'In March 2026, Apple started blocking updates to vibe-coding builder apps under Guideline 2.5.2 — the rule that apps must be self-contained and may not download or execute code that changes their functionality. Vibecode and Replit were named in coverage; the builder app “Anything” was removed from the store entirely. The accepted workaround — previews must open in an external browser — landed in the middle of Vibecode’s core experience.',
          'This isn’t a Vibecode quality problem; it’s a structural problem with building an app-builder inside an iOS app. Botflow sits on the other side of that line: the builder is a browser app Apple never reviews, the preview is a real iOS Simulator streamed from managed Macs, and what ships to the store is a normal, self-contained, reviewed app. The category risk simply doesn’t attach.',
          'Worth saying honestly: a generated app can still violate 2.5.2 if it does dynamic-code tricks — no builder can waive Apple’s rules for your app. The difference is whether the tool itself lives inside Apple’s jurisdiction.',
        ],
      },
      {
        title: 'React Native or',
        em: 'real SwiftUI',
        paragraphs: [
          'React Native is a good pragmatic choice — it’s how Vibecode ships one codebase to many places, and for plenty of apps nobody will notice. But it puts a JavaScript bridge between your app and the platform, and the newest Apple features tend to arrive on native first.',
          'Botflow made the opposite bet: the agent writes Swift 6 and SwiftUI directly. You feel it in scrolling and animations, and you see it when your app needs something platform-deep. The trade-off is honest too: SwiftUI means Apple-only — Botflow has no Android story today, and if Android matters to you now, a React Native tool is the right call.',
        ],
      },
      {
        title: 'Same engine,',
        em: 'different bill',
        paragraphs: [
          'Vibecode and Botflow both build with Claude — Anthropic has even featured Vibecode as a customer. The economics differ: on Vibecode, model usage flows through their credits on every message.',
          'Botflow is, as far as we know, the only builder where you can sign in with your own Claude Pro or Max subscription and have the genuine Claude Code agent build inside your workspace, consuming zero platform credits. If you already pay Anthropic monthly, your builder effectively stops charging you for the model.',
        ],
      },
    ],
    chooseThem: [
      'You want to build apps entirely from your iPhone, wherever you are',
      'Built-in image and sound generation matters for your app’s assets',
      'You’re making small, fun apps and the phone-first workflow is the point',
      'You want Android reach eventually via React Native',
    ],
    chooseUs: [
      'You’re building something meant to live in the App Store for years, on an architecture Apple isn’t targeting',
      'You want real native SwiftUI performance and platform depth',
      'Your app needs accounts and data — a real backend comes wired',
      'You already pay for Claude and want it building at zero extra cost',
    ],
    compareFaqs: [
      {
        q: 'Is Botflow a good alternative to Vibecode?',
        a: 'Yes, if your goal is a durable native app: Botflow writes real SwiftUI, includes a Convex backend with auth, and manages App Store signing server-side (early access) — all from a browser IDE that isn’t exposed to Apple’s crackdown on on-device builder apps. Vibecode remains the better pick for building from your phone with built-in media generation.',
      },
      {
        q: 'How does Apple’s Guideline 2.5.2 affect Vibecode and Botflow?',
        a: 'Apple’s March 2026 enforcement targets iOS apps that build or execute apps inside themselves — Vibecode was named in coverage and moved previews to an external browser. Botflow is a web application, so the builder isn’t subject to App Review at all; only the finished, self-contained apps it produces go through Apple.',
      },
      {
        q: 'Do Vibecode and Botflow use the same AI?',
        a: 'Both build with Anthropic’s Claude models and Claude Code agent technology. The difference is cost structure: Vibecode meters usage through its own credits, while Botflow can run the real Claude Code agent on your personal Claude Pro/Max subscription at zero credit cost, or let you choose from 9+ models with per-token pricing.',
      },
      {
        q: 'Which one publishes to the App Store more easily?',
        a: 'Both manage the mechanics for you in different ways: Vibecode wraps Expo’s cloud build service in a friendly GUI (you supply an Expo token), while Botflow builds and signs on managed Macs server-side with a guided wizard (early access). Both require your own Apple Developer account — Apple doesn’t allow anyone to skip that.',
      },
    ],
    alt: {
      heroIntro:
        'Vibecode made building an app from your phone feel like magic, and it deserves credit for that. But Apple’s Guideline 2.5.2 enforcement has made life structurally hard for on-device builders, the output is React Native rather than native Swift, and shipping still runs through your own Expo and Apple accounts. Here are the alternatives worth knowing, compared honestly.',
      whySwitch: [
        {
          title: 'The 2.5.2 cloud overhead',
          body: 'Apple’s crackdown on builder apps named Vibecode directly and forced previews into external browsers. Tools that build from the browser instead of from an iOS app sidestep the whole category of risk.',
        },
        {
          title: 'React Native output',
          body: 'Vibecode ships React Native + Expo. If you want native SwiftUI fidelity — or Apple-framework depth — you need a tool that writes Swift.',
        },
        {
          title: 'Thin backend, your accounts',
          body: 'Persistent multi-user apps need real infrastructure. Alternatives range from “backend included” to “bring your own Firebase” — it’s worth choosing deliberately.',
        },
      ],
      list: ['botflow', 'rork', 'bloom', 'a0'],
      faqs: [
        {
          q: 'What is the best Vibecode alternative?',
          a: 'For native SwiftUI with a managed App Store pipeline and a built-in backend, Botflow (our product — bias declared). Rork is the most established mobile-first alternative with store-listing AI and Android via Rork Pro. Bloom is best for instantly shareable prototypes. a0.dev is a lighter tool for quick React Native tests.',
        },
        {
          q: 'Which alternatives avoid the Apple 2.5.2 problem?',
          a: 'Browser-based builders — Botflow, Rork, and Bloom’s web surface — aren’t iOS apps, so Apple’s rules for self-contained app bundles don’t apply to the builder itself. Any tool’s generated apps must still individually pass App Review.',
        },
        {
          q: 'Can I keep building from my phone?',
          a: 'Bloom retains a strong phone-first flow, and Botflow’s workspace runs in a mobile browser though it shines on a bigger screen. If phone-first building is non-negotiable, that narrows your list — weigh it against output quality and publishing support.',
        },
      ],
    },
  },

  // ==========================================================================
  // BLOOM
  // ==========================================================================
  bloom: {
    slug: 'bloom',
    name: 'Bloom',
    compareMeta: {
      title: 'Botflow vs Bloom (2026) — same backend, different finish line',
      description:
        'Bloom and Botflow both build on Convex — but they finish differently: Bloom is unbeatable for instantly shareable App Clip prototypes, while Botflow manages real SwiftUI builds and App Store publishing end-to-end. An honest comparison.',
    },
    altMeta: {
      title: '4 Best Bloom Alternatives in 2026 (Compared Honestly)',
      description:
        'Looking for a Bloom alternative? An honest comparison of Botflow, Rork, Vibecode, and a0.dev — including who manages App Store publishing, native SwiftUI options, and what happens after the prototype stage.',
    },
    heroIntro:
      'Bloom and Botflow agree on more than most rivals: both believe apps deserve a real backend from day one, and both independently chose Convex to provide it. The fork in the road is the finish line. Bloom is built for the magical demo — share a working app by link or App Clip in seconds, no store, no developer account. Botflow is built for the destination — a real SwiftUI app, built, signed, and published to the App Store without you touching Xcode. Here’s the honest comparison.',
    glance: {
      them: {
        blurb:
          'Build native-feel mobile apps with no code, from your phone or browser, and share them instantly via link, QR, or App Clip — no App Store, no developer account needed for sharing. Exports a standard Expo + Convex project with GitHub sync, and offers one of the most generous free tiers in the category.',
        bestFor: 'Instantly shareable app prototypes.',
      },
      us: {
        blurb:
          'An AI workspace where the same Convex-backed philosophy ends in the App Store: the agent writes real SwiftUI, previews it on a streamed iOS Simulator, and a guided wizard handles distribution builds, server-side signing, and TestFlight upload (early access). Full-stack web apps come from the same chat.',
        bestFor: 'Apps whose destination is the App Store, not just a demo link.',
      },
    },
    tableGroups: [
      {
        label: 'Platforms & output',
        rows: [
          { feature: 'App output', us: 'Native SwiftUI', them: 'React Native + Expo' },
          { feature: 'Android', us: false, them: 'Yes (React Native)' },
          { feature: 'Full-stack web apps', us: 'First-class', them: false },
          { feature: 'Instant share (no install)', us: false, them: 'Link / QR / App Clip — excellent' },
        ],
      },
      {
        label: 'Backend & code',
        rows: [
          { feature: 'Backend', us: 'Convex, auto-provisioned', them: 'Convex — same great choice' },
          { feature: 'Auth included', us: true, them: true },
          { feature: 'You own the code', us: 'Always, with GitHub', them: 'Yes — standard Expo + Convex export' },
        ],
      },
      {
        label: 'AI & cost',
        rows: [
          { feature: 'Use your own Claude subscription', us: 'Yes — zero credits', them: false },
          { feature: 'Choose your model', us: '9+ models', them: 'Managed' },
          { feature: 'Free tier', us: 'Yes, no credit card', them: 'Yes — among the most generous' },
        ],
      },
      {
        label: 'Getting to the App Store',
        rows: [
          { feature: 'Managed store publishing', us: 'Build, sign, upload — server-side (early access)', them: 'No — export and run EAS yourself' },
          { feature: 'Signing handled for you', us: true, them: false },
          { feature: 'TestFlight upload', us: 'Built into the wizard', them: 'DIY' },
          { feature: 'Install on your device', us: 'Companion app, free Apple ID', them: 'App Clip / Expo flows' },
        ],
      },
    ],
    theirStrengths: [
      {
        title: 'Instant, magical sharing',
        body: 'Bloom’s App Clip and link sharing is the best “try my app right now” experience in the category — no install, no developer account, seconds from build to someone else’s hands. Botflow has nothing equivalent; device installs go through its Companion app instead.',
      },
      {
        title: 'The most generous free tier',
        body: 'Bloom gives you more room to experiment for free than almost anyone in the category. If you’re exploring ideas casually, that generosity is a real reason to start there.',
      },
      {
        title: 'A genuinely good, open stack',
        body: 'Bloom exports a standard Expo + Convex project with GitHub sync — real, portable code on the same backend philosophy Botflow bets on. Among mobile builders, that’s rare and commendable.',
      },
    ],
    ourStrengths: [
      {
        title: 'The App Store, handled',
        body: 'Bloom’s path to a real store listing is: export your code, set up EAS, wrangle certificates, and submit yourself. Botflow’s is: a guided wizard that builds, distribution-signs, and uploads to TestFlight from managed Macs (early access). You bring an Apple Developer account; the machinery is ours.',
      },
      {
        title: 'Native SwiftUI output',
        body: 'Bloom apps are React Native. Botflow writes Swift 6 and SwiftUI — Apple’s own frameworks — for native performance and the deepest platform access. For an app you intend to grow for years on iOS, that fidelity compounds.',
      },
      {
        title: 'Web apps from the same chat',
        body: 'Botflow also builds full-stack web apps — React frontend, the same Convex backend, one-click deploy with custom domains. Bloom is mobile-only; with Botflow, your product’s web presence comes from the same workspace.',
      },
      {
        title: 'Your Claude subscription, welcome here',
        body: 'Sign in with Claude Pro or Max and the real Claude Code agent builds for you at zero credit cost — a cost structure no other builder offers, Bloom included.',
      },
    ],
    deepDives: [
      {
        title: 'Same backend,',
        em: 'different finish line',
        paragraphs: [
          'It’s worth pausing on the agreement: two independent teams looked at the mobile-builder landscape and both picked Convex — typed, real-time, serverless — over Firebase and Supabase. If you’re evaluating either tool, the backend is a reason for confidence in both.',
          'That makes the real difference unusually clean: what happens at the end. Bloom optimizes the beginning of an app’s life — the prototype someone taps into via App Clip within a minute of you describing it. Botflow optimizes the destination — the reviewed, signed, real app in the store with your name on it.',
        ],
      },
      {
        title: 'The publishing',
        em: 'cliff',
        paragraphs: [
          'Bloom’s “no App Store needed” is true — for sharing. A real store listing means leaving the guided path: export the project, install the EAS CLI, manage certificates and provisioning with your Apple account, and drive the submission yourself. It’s all doable, but it’s exactly the part of iOS development that no-code users came to a builder to avoid.',
          'Botflow treats that cliff as the product. The publish wizard collects your app info and App Store Connect key, then managed Macs run the distribution build, handle signing server-side, and upload to TestFlight while you watch progress stages (early access). Honest scope note: both paths require an Apple Developer account ($99/year), and the app record itself is created once in App Store Connect by hand — Apple provides no API for that part, to anyone.',
        ],
      },
      {
        title: 'Prototype tool or',
        em: 'product tool',
        paragraphs: [
          'The cleanest way to choose: what does “done” mean for you? If done means “people I know are playing with it this afternoon,” Bloom’s share-first design and generous free tier are unmatched, and we’d genuinely point you there.',
          'If done means “strangers find it in the App Store and my web app matches,” Botflow was built for exactly that arc — native SwiftUI, managed publishing, a web platform, and a backend that was never a toy to begin with.',
        ],
      },
    ],
    chooseThem: [
      'You want people trying your app minutes from now — App Clip sharing is unmatched',
      'You’re exploring ideas casually and want the most generous free tier',
      'Android reach via React Native matters to you',
      'A store listing isn’t the goal — shareable prototypes are',
    ],
    chooseUs: [
      'The App Store is the destination, and you want the pipeline managed end-to-end',
      'You want native SwiftUI rather than React Native',
      'You want a real web app for your product from the same workspace',
      'You have a Claude subscription you’d like doing the building at zero credit cost',
    ],
    compareFaqs: [
      {
        q: 'Is Botflow a good alternative to Bloom?',
        a: 'Yes — especially at the point Bloom hands off: getting into the App Store. Both tools build on the excellent Convex backend, but Bloom leaves store publishing to you (export, EAS CLI, certificates), while Botflow manages builds, signing, and TestFlight upload server-side (early access) and outputs native SwiftUI rather than React Native.',
      },
      {
        q: 'Do Bloom and Botflow really use the same backend?',
        a: 'Yes — both chose Convex, the typed real-time backend, independently. Botflow auto-provisions and wires it (including auth) inside its workspace and also offers connecting your own Convex account; Bloom exports it as part of a standard Expo + Convex project. On backend quality, honestly, call it a tie.',
      },
      {
        q: 'Can Bloom publish apps to the App Store?',
        a: 'Not in a managed way. Bloom’s instant sharing (link, QR, App Clip) needs no store and no developer account — that’s its superpower — but an actual App Store listing requires exporting your code and running EAS builds with your own Apple credentials yourself. Botflow’s wizard handles the build, signing, and upload for you (early access).',
      },
      {
        q: 'Which has the better free tier?',
        a: 'Bloom’s free tier is among the most generous in the category and is genuinely great for casual exploration. Botflow’s free plan requires no credit card and has a different kind of generosity: bring your own API keys or a Claude Pro/Max subscription and the model cost drops to zero regardless of plan.',
      },
    ],
    alt: {
      heroIntro:
        'Bloom is one of the most likable tools in the category — instant App Clip sharing, a generous free tier, and a genuinely good exportable stack (Expo + Convex). The reasons people look elsewhere are specific: no managed path to an actual App Store listing, React Native rather than native Swift output, and no web-app story. Here are the alternatives, honestly compared.',
      whySwitch: [
        {
          title: 'The store listing is DIY',
          body: 'Bloom’s magic ends where the App Store begins: a real listing means exporting code and running EAS builds with your own certificates. If publishing is the point, you want a tool that manages it.',
        },
        {
          title: 'React Native ceiling',
          body: 'Bloom outputs Expo + React Native. Good technology — but if you want native SwiftUI performance and Apple-framework depth, you need a tool that writes Swift.',
        },
        {
          title: 'Mobile only',
          body: 'Most products eventually need a web presence too. Bloom doesn’t build web apps; some alternatives treat web as first-class.',
        },
      ],
      list: ['botflow', 'rork', 'vibecode', 'a0'],
      faqs: [
        {
          q: 'What is the best Bloom alternative?',
          a: 'For keeping Bloom’s Convex backend philosophy but adding native SwiftUI and managed App Store publishing, Botflow (our product — bias declared) is the most direct step up. Rork is the established mobile-first player with store-listing AI. Vibecode keeps the build-from-phone magic. a0.dev suits quick React Native experiments.',
        },
        {
          q: 'Which alternatives keep the Convex backend?',
          a: 'Botflow — it independently chose Convex too, and goes further by auto-provisioning it with auth wired by the agent, plus an in-workspace database dashboard. Migrating a Bloom project’s Convex functions to a Botflow project is about as friendly as cross-tool moves get in this category, though it’s still a port, not an import button.',
        },
        {
          q: 'Do any alternatives match Bloom’s instant sharing?',
          a: 'Honestly, no — Bloom’s App Clip sharing is the best in the category and if that’s your primary need, stay. The alternatives trade that immediacy for depth: managed publishing (Botflow, Rork), native SwiftUI (Botflow, Rork Max), or web apps (Botflow).',
        },
      ],
    },
  },

  // ==========================================================================
  // BASE44
  // ==========================================================================
  base44: {
    slug: 'base44',
    name: 'Base44',
    compareMeta: {
      title: 'Botflow vs Base44 (2026) — simplicity vs ownership',
      description:
        'Base44 is the simplest all-in-one AI builder; Botflow gives you real exportable code, a portable Convex backend, model choice, and a native iOS path. An honest comparison of the trade-off that actually matters: turnkey simplicity versus owning what you build.',
    },
    altMeta: {
      title: '4 Best Base44 Alternatives in 2026 (Compared Honestly)',
      description:
        'Looking for a Base44 alternative? An honest comparison of Botflow, Lovable, Bolt.new, and Replit — focused on the reasons people leave: backend lock-in, post-acquisition support, and the missing mobile story.',
    },
    heroIntro:
      'Base44 made “describe it and it runs” genuinely real — database, auth, storage, and functions all first-party, zero setup, one bill. The trade is the exit: the backend never leaves Base44, so migrating means rebuilding. Botflow sits on the other side of that trade — real exportable code, a portable backend, model choice, and a native iOS path — while working hard to keep the first-prompt experience just as simple. Here’s the honest comparison.',
    glance: {
      them: {
        blurb:
          'The all-in-one AI app builder, now owned by Wix. Describe an app and everything — NoSQL database, auth with SSO, file storage, serverless functions, email — is provisioned first-party with zero integrations. Probably the fastest zero-decision path from idea to working web app.',
        bestFor: 'Non-technical builders who want zero setup decisions.',
      },
      us: {
        blurb:
          'An AI app builder with the same chat-first flow but opposite architecture: real React code you own with GitHub sync, a typed real-time Convex backend that can leave with you, 9+ models or your own Claude subscription, and a native iOS pipeline in early access. Depth is there when you want it, hidden when you don’t.',
        bestFor: 'Builders who want simplicity now without a wall later.',
      },
    },
    tableGroups: [
      {
        label: 'Experience',
        rows: [
          { feature: 'Zero-setup first prompt', us: true, them: true },
          { feature: 'Simplicity ceiling', us: 'IDE, terminal, git — when you want them', them: 'Radically simple, by design' },
          { feature: 'Plan-before-you-build mode', us: 'Yes — agent plans and discusses', them: 'Yes — discounted discuss mode' },
        ],
      },
      {
        label: 'Ownership & portability',
        rows: [
          { feature: 'Code export', us: 'Full project + GitHub', them: 'Frontend only' },
          { feature: 'Backend portability', us: 'Convex — managed or bring your own', them: 'Proprietary — cannot leave Base44' },
          { feature: 'Migration path out', us: 'Standard React + Convex project', them: 'Rebuild on new infrastructure' },
        ],
      },
      {
        label: 'Platforms',
        rows: [
          { feature: 'Full-stack web apps', us: true, them: true },
          { feature: 'Native iOS apps', us: 'SwiftUI (early access)', them: false },
          { feature: 'App Store publishing', us: 'Managed (early access)', them: false },
        ],
      },
      {
        label: 'AI & cost',
        rows: [
          { feature: 'Use your own Claude subscription', us: 'Yes — zero credits', them: false },
          { feature: 'Choose your model', us: '9+ models', them: 'Managed for you' },
          { feature: 'Bring your own API keys', us: true, them: false },
        ],
      },
    ],
    theirStrengths: [
      {
        title: 'Radical, real simplicity',
        body: 'Base44’s all-first-party design removes every integration decision — auth, database, storage, email just exist. For a non-technical user, that absence of choices is genuinely the fastest path to a working app, and Botflow’s extra capability is worth nothing to someone it confuses.',
      },
      {
        title: 'Everything on one bill',
        body: 'No Convex, no Cloudflare, no GitHub — one product, one subscription, one support channel. There’s real appeal in never seeing a second logo.',
      },
      {
        title: 'Wix-scale resources',
        body: 'Whatever the acquisition changed, Base44 now sits inside a large public company with real infrastructure, compliance, and staying power behind it.',
      },
    ],
    ourStrengths: [
      {
        title: 'Your app can leave with you',
        body: 'The most-cited Base44 complaint is the one-way door: the backend is proprietary, export covers the frontend only, and migrating means rebuilding. Botflow’s output is a standard React + Convex project with GitHub sync — the door out is always open, which is exactly what makes staying a choice.',
      },
      {
        title: 'A native iOS path',
        body: 'Base44 is web-only. Botflow builds real SwiftUI apps with a streamed simulator preview and managed App Store publishing (early access) — from the same chat-first workflow.',
      },
      {
        title: 'Model choice and your own Claude',
        body: 'Base44 picks your model. Botflow offers 9+ (GPT-5, Claude, Gemini, and more), BYO API keys at zero markup, and the unique option to build with the real Claude Code agent on your existing Claude subscription — zero credits.',
      },
      {
        title: 'Headroom without a cliff',
        body: 'When your app outgrows the prompt — a weird bug, a performance issue, a custom integration — Botflow has a real IDE, terminal, and git underneath the chat. On Base44, the ceiling is the product.',
      },
    ],
    deepDives: [
      {
        title: 'The lock-in',
        em: 'question',
        paragraphs: [
          'Base44’s architecture is its pitch and its trap: because everything is first-party, everything works instantly — and nothing can leave. The database, auth, storage, and functions are Base44’s own; code export gives you the frontend, and the community’s consistent verdict on migration is “a rebuild, not a port.”',
          'Botflow is built on the opposite conviction: the fastest way to make users stay is to make leaving easy. Your project is standard React and TypeScript in a real git repository you can push to GitHub. The backend is Convex — a real product with its own dashboard, docs, and CLI — and you can even connect your own Convex account, at which point the backend is literally yours regardless of what happens to Botflow.',
        ],
      },
      {
        title: 'Simplicity now vs',
        em: 'headroom later',
        paragraphs: [
          'Let’s be fair about the trade. On day one, Base44 is simpler — fewer concepts, fewer logos, fewer decisions, and its all-in-one design is executed well. If the apps you build are internal tools and quick utilities that will never need to scale or leave, that simplicity may be worth the lock-in, genuinely.',
          'The calculation changes the moment an app matters. Real products accumulate needs — a custom integration, a performance fix, an audit, a second platform. Botflow’s bet is that you should never have to switch tools to meet them: the chat stays simple, and the IDE, terminal, real backend, and native iOS pipeline are already underneath when you get there.',
        ],
      },
      {
        title: 'The acquisition',
        em: 'factor',
        paragraphs: [
          'Base44 was acquired by Wix in 2025, and the record since is mixed: users have reported slower support, price adjustments, and feature changes as the product integrates into a large company’s portfolio and priorities. None of that makes Base44 a bad product — but when your entire backend lives inside a platform, its owner’s roadmap is your risk surface.',
          'Portability is the hedge. Whatever tool you choose — including Botflow — prefer architectures where your code and data outlive any one company’s strategy. That’s not marketing; it’s the lesson of every platform shift of the last decade.',
        ],
      },
    ],
    chooseThem: [
      'You want the absolute simplest path and never want to think about a stack',
      'You’re building internal tools or utilities where lock-in costs little',
      'One product, one bill, one support channel matters to you',
      'You’d rather have Wix-scale infrastructure than portability',
    ],
    chooseUs: [
      'You want real, exportable code and a backend that can leave with you',
      'A native iOS app is (or might become) part of your plan',
      'You want model choice, BYO keys, or your Claude subscription doing the work',
      'You want headroom — IDE, terminal, git — without leaving the tool',
    ],
    compareFaqs: [
      {
        q: 'Is Botflow a good alternative to Base44?',
        a: 'Yes, particularly if lock-in worries you: Botflow produces standard React + Convex projects with full GitHub export, and can even run on your own Convex account. You also gain model choice, the option to build on your own Claude subscription, and a native iOS path — while keeping a chat-first flow. Base44 remains simpler for pure zero-decision building.',
      },
      {
        q: 'Can I export my app from Base44?',
        a: 'Only partially — code export covers the frontend, but the database, auth, storage, and functions are proprietary to Base44 and can’t be self-hosted or moved. Migrating typically means rebuilding the backend elsewhere. Botflow’s projects export completely: standard React code on GitHub plus a Convex backend that works anywhere Convex does.',
      },
      {
        q: 'Which is easier for a non-technical founder?',
        a: 'Base44 has the edge on pure day-one simplicity — its all-first-party design means zero integration decisions. Botflow’s default path is also chat-only (describe, iterate, publish), but an IDE and terminal exist underneath. The question is whether you’ll ever want that headroom; if yes, Botflow means not switching tools later.',
      },
      {
        q: 'Does Base44 build mobile apps?',
        a: 'No — Base44 outputs web apps only, and native export is a long-standing open feature request. Botflow builds real native SwiftUI iOS apps with managed App Store publishing, currently in early access.',
      },
    ],
    alt: {
      heroIntro:
        'Base44 nailed something real: the fastest zero-decision path from a description to a working app, with everything first-party. The reasons people look elsewhere are just as real: the backend can never leave, support and pricing have shifted since the Wix acquisition, and there’s no mobile story. Here are the alternatives, honestly compared.',
      whySwitch: [
        {
          title: 'The one-way door',
          body: 'Base44’s proprietary backend means code export covers the frontend only — migration is a rebuild. If your app might matter in two years, portability is insurance you buy now.',
        },
        {
          title: 'Post-acquisition drift',
          body: 'Since the Wix acquisition, users have reported slower support and pricing changes. When a platform owns your whole stack, its roadmap is your risk.',
        },
        {
          title: 'Web-only ceiling',
          body: 'No native mobile apps, and no path to the App Store. If “we should have an app” is in your future, plan for it now.',
        },
      ],
      list: ['botflow', 'lovable', 'bolt', 'replit'],
      faqs: [
        {
          q: 'What is the best Base44 alternative?',
          a: 'For escaping lock-in without losing the chat-first flow, Botflow (our product — bias declared) exports full React + Convex projects and adds native iOS. Lovable is the polished mainstream pick for pure web. Bolt.new offers framework flexibility. Replit suits more technical, general-purpose projects.',
        },
        {
          q: 'Can I move my Base44 app to another platform?',
          a: 'Expect a rebuild rather than a migration: Base44’s backend (database, auth, functions, storage) is proprietary and can’t be exported. Your product knowledge, schema design, and any exported frontend code transfer — the infrastructure doesn’t. That’s the strongest argument for choosing a portable stack the second time.',
        },
        {
          q: 'Which alternatives avoid backend lock-in?',
          a: 'Botflow (standard Convex backend — managed or your own account — plus full code on GitHub), Bolt.new (you assemble your own integrations), and Replit (standard code you can take anywhere). Lovable exports real code too, though its managed cloud keeps the backend on Lovable’s Supabase wrapper.',
        },
      ],
    },
  },
};

export const COMPETITOR_SLUGS = Object.keys(COMPETITORS) as CompetitorSlug[];

export function compareHref(slug: CompetitorSlug): string {
  return `/compare/botflow-vs-${slug}`;
}

export function alternativesHref(slug: CompetitorSlug): string {
  return `/alternatives/${slug}`;
}

/** Resolve a /compare/[slug] URL param like "botflow-vs-lovable". */
export function competitorFromCompareParam(param: string): Competitor | null {
  const m = param.match(/^botflow-vs-(.+)$/);
  if (!m) return null;
  const slug = m[1] as CompetitorSlug;
  return COMPETITORS[slug] ?? null;
}
