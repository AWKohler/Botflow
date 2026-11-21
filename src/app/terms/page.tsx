import { LandingNav, LandingFooter } from "@/components/landing/shared";
import { serif } from "@/components/landing/fonts";

export const metadata = {
  title: "Terms of Service — Botflow",
  description: "Terms governing your use of the Botflow platform.",
};

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-[var(--sand-bg)]">
      <LandingNav />

      <main className="mx-auto max-w-3xl px-6 py-16 sm:px-10 sm:py-24">
        <p className="mb-5 text-[11px] font-medium uppercase tracking-[0.2em] text-muted">Legal</p>
        <h1 className={`${serif.className} mb-4 text-5xl leading-[1.05] tracking-tight text-fg sm:text-6xl`}>
          Terms of Service
        </h1>
        <p className="text-sm text-[var(--sand-text-muted)] mb-12">
          Effective date: May 2, 2026 &nbsp;·&nbsp; Botflow LLC, North Carolina
        </p>

        <div className="space-y-10 text-[var(--sand-text-muted)] leading-relaxed">

          <Section title="1. Agreement to Terms">
            <p>
              These Terms of Service (&quot;Terms&quot;) form a legally binding agreement between you and{" "}
              <strong className="text-[var(--sand-text)]">Botflow LLC</strong> (&quot;Botflow,&quot; &quot;we,&quot;
              &quot;us,&quot; or &quot;our&quot;), a limited liability company organized under the laws of North Carolina.
              By creating an account or using Botflow at{" "}
              <a href="https://botflow.io" className="text-fg underline decoration-border-strong underline-offset-4 transition-colors hover:decoration-fg">
                botflow.io
              </a>{" "}
              (the &quot;Service&quot;), you agree to be bound by these Terms. If you do not agree, do not use
              the Service.
            </p>
            <p className="mt-3">
              The Service is powered by{" "}
              <strong className="text-[var(--sand-text)]">OpenVibeCode</strong>, a source-available
              development environment for building full-stack applications in the browser.
            </p>
          </Section>

          <Section title="2. Eligibility">
            <p>
              You must be at least 13 years old to use the Service. By accepting these Terms, you
              represent that you meet this age requirement. If you are using the Service on behalf of
              an organization, you represent that you have authority to bind that organization to
              these Terms.
            </p>
          </Section>

          <Section title="3. Accounts">
            <p>
              Account creation and authentication are managed by Clerk. You are responsible for
              maintaining the confidentiality of your login credentials and for all activity that
              occurs under your account. You agree to notify us immediately at{" "}
              <a
                href="mailto:awkohler@botflow.io"
                className="text-fg underline decoration-border-strong underline-offset-4 transition-colors hover:decoration-fg"
              >
                awkohler@botflow.io
              </a>{" "}
              if you suspect unauthorized use of your account.
            </p>
            <p className="mt-3">
              We reserve the right to suspend or terminate accounts that violate these Terms or that
              we reasonably believe are involved in fraudulent or harmful activity.
            </p>
          </Section>

          <Section title="4. Description of Service">
            <p>
              Botflow is a browser-based development platform that lets you write, run, and deploy
              full-stack applications using AI assistance. Core capabilities include:
            </p>
            <ul className="list-disc pl-5 mt-3 space-y-2">
              <li>
                In-browser execution of Node.js applications via the{" "}
                <strong className="text-[var(--sand-text)]">WebContainer API</strong> (provided by
                StackBlitz).
              </li>
              <li>
                AI-assisted coding powered by models from OpenAI, Anthropic, and Fireworks AI.
              </li>
              <li>GitHub integration for reading and writing code repositories.</li>
              <li>File uploads and asset management.</li>
              <li>Deployment integrations for publishing projects.</li>
            </ul>
            <p className="mt-4">
              We may modify, suspend, or discontinue any feature at any time, with or without notice,
              though we will endeavor to provide advance notice for material changes.
            </p>
          </Section>

          <Section title="5. Acceptable Use">
            <p>You agree not to use the Service to:</p>
            <ul className="list-disc pl-5 mt-3 space-y-2">
              <li>
                Violate any applicable law, regulation, or third-party rights (including intellectual
                property rights).
              </li>
              <li>
                Upload, transmit, or store content that is illegal, harmful, threatening, abusive,
                defamatory, obscene, or otherwise objectionable.
              </li>
              <li>
                Attempt to gain unauthorized access to Botflow&apos;s systems or another user&apos;s account.
              </li>
              <li>
                Reverse-engineer, decompile, or extract proprietary components of the platform beyond
                what is permitted by the source-available license of OpenVibeCode.
              </li>
              <li>
                Use the Service to build or distribute malware, spyware, or other malicious software.
              </li>
              <li>
                Interfere with or disrupt the integrity or performance of the Service or its
                underlying infrastructure.
              </li>
              <li>
                Use automated scraping, crawling, or data-harvesting tools against the platform in a
                manner that places an unreasonable load on our infrastructure.
              </li>
              <li>
                Misrepresent your identity or affiliation when interacting with other users or
                third-party services through the platform.
              </li>
            </ul>
            <p className="mt-4">
              We reserve the right to investigate potential violations and to remove content or
              suspend access without prior notice when necessary to protect users, third parties, or
              the integrity of the Service.
            </p>
          </Section>

          <Section title="6. Your Content & Intellectual Property">
            <p>
              <strong className="text-[var(--sand-text)]">Your projects belong to you.</strong> You
              retain full ownership of all code, content, and data you create or upload to Botflow.
              By storing your content on the platform, you grant Botflow a limited, non-exclusive,
              worldwide license to host, store, process, and display your content solely as necessary
              to operate and improve the Service.
            </p>
            <p className="mt-3">
              You represent that you own or have the necessary rights to any content you submit, and
              that doing so does not violate any third-party rights.
            </p>
            <p className="mt-3">
              We do not claim ownership over your projects, and we do not use your project code to
              train AI models without your explicit consent.
            </p>
          </Section>

          <Section title="7. OpenVibeCode Source-Available License">
            <p>
              The underlying platform software, OpenVibeCode, is source-available. The source code
              is made available for personal inspection and non-commercial use under the terms of its
              applicable source-available license, which is published in the OpenVibeCode repository.
              Commercial use, redistribution, or hosting of the platform software requires a separate
              commercial license from Botflow LLC. These Terms do not grant you any rights to the
              OpenVibeCode software beyond what is provided in that license.
            </p>
          </Section>

          <Section title="8. AI-Generated Content">
            <p>
              The Service includes AI-powered features that generate code and other content. You are
              solely responsible for reviewing, testing, and validating any AI-generated output before
              deploying it to production. Botflow makes no warranties as to the accuracy,
              completeness, or fitness for purpose of AI-generated content. AI-generated code may
              contain errors, security vulnerabilities, or third-party licensed material — always
              review it carefully.
            </p>
          </Section>

          <Section title="9. GitHub Integration">
            <p>
              When you connect your GitHub account, you authorize Botflow to act on your behalf using
              a GitHub OAuth token stored securely in our database. You remain responsible for all
              repository activity performed through Botflow. You can revoke this access at any time
              from your GitHub account settings or from within Botflow&apos;s settings panel. Use of the
              GitHub integration is also subject to{" "}
              <a
                href="https://docs.github.com/en/site-policy/github-terms/github-terms-of-service"
                target="_blank"
                rel="noopener noreferrer"
                className="text-fg underline decoration-border-strong underline-offset-4 transition-colors hover:decoration-fg"
              >
                GitHub&apos;s Terms of Service
              </a>
              .
            </p>
          </Section>

          <Section title="10. Subscriptions & Payment">
            <p>
              Botflow offers free and paid subscription plans (Pro and Max). Subscription billing is
              managed by Clerk. By subscribing to a paid plan, you authorize recurring charges to
              your payment method. All subscription fees are stated in US dollars and are
              non-refundable except as required by applicable law or as described in our refund
              policy.
            </p>
            <p className="mt-3">
              We reserve the right to change pricing with at least 30 days&apos; notice. Continued use of
              a paid plan after a price change takes effect constitutes acceptance of the new price.
              Failure to pay may result in suspension or downgrade of your account.
            </p>
          </Section>

          <Section title="11. Third-Party Services">
            <p>
              The Service integrates with third-party services including Clerk, Neon, UploadThing,
              Vercel, StackBlitz (WebContainer API), OpenAI, Anthropic, Fireworks AI, and GitHub.
              Your use of these services is also governed by their respective terms and privacy
              policies. Botflow is not responsible for the availability, content, or conduct of any
              third-party service.
            </p>
          </Section>

          <Section title="12. Disclaimers">
            <p>
              THE SERVICE IS PROVIDED &quot;AS IS&quot; AND &quot;AS AVAILABLE&quot; WITHOUT WARRANTIES OF ANY KIND,
              EITHER EXPRESS OR IMPLIED. TO THE FULLEST EXTENT PERMITTED BY LAW, BOTFLOW DISCLAIMS
              ALL WARRANTIES, INCLUDING IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
              PARTICULAR PURPOSE, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SERVICE WILL BE
              UNINTERRUPTED, ERROR-FREE, OR FREE OF HARMFUL COMPONENTS.
            </p>
          </Section>

          <Section title="13. Limitation of Liability">
            <p>
              TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, BOTFLOW LLC AND ITS OFFICERS,
              EMPLOYEES, AND AGENTS SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL,
              CONSEQUENTIAL, OR PUNITIVE DAMAGES ARISING FROM YOUR USE OF OR INABILITY TO USE THE
              SERVICE, EVEN IF WE HAVE BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES. OUR TOTAL
              CUMULATIVE LIABILITY TO YOU FOR ALL CLAIMS ARISING FROM OR RELATED TO THE SERVICE
              SHALL NOT EXCEED THE GREATER OF (A) THE TOTAL FEES YOU PAID TO BOTFLOW IN THE TWELVE
              MONTHS PRECEDING THE CLAIM, OR (B) ONE HUNDRED US DOLLARS ($100).
            </p>
          </Section>

          <Section title="14. Indemnification">
            <p>
              You agree to indemnify, defend, and hold harmless Botflow LLC and its officers,
              directors, employees, and agents from and against any claims, liabilities, damages,
              losses, and expenses (including reasonable legal fees) arising from: (a) your use of
              the Service; (b) your violation of these Terms; (c) your violation of any third-party
              right, including intellectual property rights; or (d) any content you submit to the
              platform.
            </p>
          </Section>

          <Section title="15. Termination">
            <p>
              You may stop using the Service and delete your account at any time. We may suspend or
              terminate your account if you violate these Terms, upon reasonable notice where
              practicable. Upon termination, your right to use the Service ends immediately. Sections
              6, 7, 12, 13, 14, 16, and 17 survive termination.
            </p>
          </Section>

          <Section title="16. Governing Law & Dispute Resolution">
            <p>
              These Terms are governed by and construed in accordance with the laws of the State of
              North Carolina, without regard to its conflict-of-law provisions. Any dispute arising
              from these Terms or your use of the Service shall be resolved exclusively in the state
              or federal courts located in North Carolina, and you consent to personal jurisdiction in
              those courts.
            </p>
          </Section>

          <Section title="17. Changes to These Terms">
            <p>
              We may modify these Terms at any time. When we do, we will update the effective date at
              the top of this page. If changes are material, we will provide at least 14 days&apos; notice
              via email or a notice within the platform. Continued use of the Service after changes
              take effect constitutes acceptance of the revised Terms.
            </p>
          </Section>

          <Section title="18. Miscellaneous">
            <ul className="list-disc pl-5 space-y-2">
              <li>
                <strong className="text-[var(--sand-text)]">Entire Agreement:</strong> These Terms,
                together with our Privacy Policy, constitute the entire agreement between you and
                Botflow regarding the Service.
              </li>
              <li>
                <strong className="text-[var(--sand-text)]">Severability:</strong> If any provision
                is found unenforceable, the remaining provisions remain in full force.
              </li>
              <li>
                <strong className="text-[var(--sand-text)]">No Waiver:</strong> Failure to enforce
                any right or provision shall not constitute a waiver.
              </li>
              <li>
                <strong className="text-[var(--sand-text)]">Assignment:</strong> You may not assign
                these Terms without our prior written consent. Botflow may assign these Terms in
                connection with a merger, acquisition, or sale of assets.
              </li>
            </ul>
          </Section>

          <Section title="19. Contact">
            <p>For questions about these Terms, please contact us:</p>
            <address className="not-italic mt-3 space-y-1 text-sm">
              <div className="text-[var(--sand-text)]">Botflow LLC</div>
              <div>North Carolina, USA</div>
              <div>
                <a
                  href="mailto:awkohler@botflow.io"
                  className="text-fg underline decoration-border-strong underline-offset-4 transition-colors hover:decoration-fg"
                >
                  awkohler@botflow.io
                </a>
              </div>
            </address>
          </Section>

        </div>
      </main>

      <LandingFooter />
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-[var(--sand-text)] mb-3">{title}</h2>
      <div className="space-y-2">{children}</div>
    </section>
  );
}
