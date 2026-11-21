import { LandingNav, LandingFooter } from "@/components/landing/shared";
import { serif } from "@/components/landing/fonts";

export const metadata = {
  title: "Privacy Policy — Botflow",
  description: "How Botflow collects, uses, and protects your information.",
};

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-[var(--sand-bg)]">
      <LandingNav />

      <main className="mx-auto max-w-3xl px-6 py-16 sm:px-10 sm:py-24">
        <p className="mb-5 text-[11px] font-medium uppercase tracking-[0.2em] text-muted">Legal</p>
        <h1 className={`${serif.className} mb-4 text-5xl leading-[1.05] tracking-tight text-fg sm:text-6xl`}>
          Privacy Policy
        </h1>
        <p className="text-sm text-[var(--sand-text-muted)] mb-12">
          Effective date: May 2, 2026 &nbsp;·&nbsp; Botflow LLC, North Carolina
        </p>

        <div className="prose-custom space-y-10 text-[var(--sand-text-muted)] leading-relaxed">

          <Section title="1. Who We Are">
            <p>
              Botflow LLC (&quot;Botflow,&quot; &quot;we,&quot; &quot;us,&quot; or &quot;our&quot;) is a limited liability company
              incorporated in North Carolina. We operate the Botflow platform, accessible at{" "}
              <a href="https://botflow.io" className="text-fg underline decoration-border-strong underline-offset-4 transition-colors hover:decoration-fg">
                botflow.io
              </a>
              , which is powered by{" "}
              <span className="text-[var(--sand-text)]">OpenVibeCode</span> — our source-available
              development environment that lets you build full-stack applications directly in the browser.
            </p>
            <p className="mt-3">
              Questions about this Privacy Policy can be directed to{" "}
              <a
                href="mailto:awkohler@botflow.io"
                className="text-fg underline decoration-border-strong underline-offset-4 transition-colors hover:decoration-fg"
              >
                awkohler@botflow.io
              </a>
              .
            </p>
          </Section>

          <Section title="2. Information We Collect">
            <SubSection title="2.1 Account Information">
              <p>
                Authentication and account management are handled by{" "}
                <strong className="text-[var(--sand-text)]">Clerk</strong>. When you sign up, Clerk
                collects your email address and, optionally, your name and profile photo. If you use a
                social login (e.g., GitHub, Google), Clerk receives basic profile information from that
                provider. We receive a user ID and basic profile metadata from Clerk to associate your
                account with your projects.
              </p>
            </SubSection>

            <SubSection title="2.2 Project Data">
              <p>
                We store the files, code, project configuration, and metadata that you create inside
                Botflow. This data is stored in our PostgreSQL database (hosted on{" "}
                <strong className="text-[var(--sand-text)]">Neon</strong>) and includes project names,
                descriptions, file trees, file contents, and related settings.
              </p>
            </SubSection>

            <SubSection title="2.3 Uploaded Files">
              <p>
                If you upload assets to your projects, those files are processed and stored through{" "}
                <strong className="text-[var(--sand-text)]">UploadThing</strong>, a third-party
                file-handling service. Files you upload are stored on UploadThing&apos;s infrastructure.
              </p>
            </SubSection>

            <SubSection title="2.4 GitHub Integration">
              <p>
                If you connect your GitHub account to Botflow, we store a GitHub OAuth access token in
                our database to perform Git operations (reading and writing repositories) on your behalf.
                We only request the minimum GitHub scopes necessary to enable the features you use. You
                can revoke this access at any time from your GitHub account settings or from within
                Botflow.
              </p>
            </SubSection>

            <SubSection title="2.5 AI Features">
              <p>
                Botflow offers AI-assisted coding features powered by models from OpenAI, Anthropic,
                and Fireworks AI. When you use these features, the relevant portions of your code or
                conversation are sent to the applicable AI provider for processing. Please review the
                privacy policies of{" "}
                <a
                  href="https://openai.com/policies/privacy-policy"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-fg underline decoration-border-strong underline-offset-4 transition-colors hover:decoration-fg"
                >
                  OpenAI
                </a>
                ,{" "}
                <a
                  href="https://www.anthropic.com/legal/privacy"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-fg underline decoration-border-strong underline-offset-4 transition-colors hover:decoration-fg"
                >
                  Anthropic
                </a>
                , and{" "}
                <a
                  href="https://fireworks.ai/privacy"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-fg underline decoration-border-strong underline-offset-4 transition-colors hover:decoration-fg"
                >
                  Fireworks AI
                </a>{" "}
                to understand how they handle this data.
              </p>
            </SubSection>

            <SubSection title="2.6 Subscription & Billing">
              <p>
                Subscription and billing are managed by Clerk. Payment card data is handled entirely by
                Clerk&apos;s payment infrastructure and is never stored on Botflow&apos;s servers. We receive
                information about your subscription plan (Free, Pro, or Max) and subscription status.
              </p>
            </SubSection>

            <SubSection title="2.7 Usage & Technical Data">
              <p>
                We may automatically collect information such as your IP address, browser type,
                operating system, referring URLs, pages visited, and timestamps when you use the
                platform. This data helps us understand how the service is used and improve reliability.
              </p>
            </SubSection>
          </Section>

          <Section title="3. How We Use Your Information">
            <ul className="list-disc pl-5 space-y-2">
              <li>Providing, operating, and improving the Botflow platform.</li>
              <li>Authenticating your identity and securing your account.</li>
              <li>Storing and serving your project files and settings.</li>
              <li>Processing GitHub operations on your behalf when you use the GitHub integration.</li>
              <li>Sending transactional emails (e.g., account notifications) through Clerk.</li>
              <li>Responding to your support requests.</li>
              <li>Detecting and preventing abuse, fraud, or security incidents.</li>
              <li>
                Complying with applicable laws and enforcing our Terms of Service.
              </li>
            </ul>
            <p className="mt-4">
              We do not sell your personal information to third parties. We do not use your project
              code to train AI models without your explicit consent.
            </p>
          </Section>

          <Section title="4. Sharing of Information">
            <p>We share data only in the following limited circumstances:</p>
            <ul className="list-disc pl-5 mt-3 space-y-2">
              <li>
                <strong className="text-[var(--sand-text)]">Service providers:</strong> Clerk
                (authentication &amp; billing), Neon (database), UploadThing (file storage), Vercel
                (hosting), and AI providers (OpenAI, Anthropic, Fireworks AI) — solely to provide
                the services you use.
              </li>
              <li>
                <strong className="text-[var(--sand-text)]">Legal requirements:</strong> When
                required by law, regulation, or valid legal process.
              </li>
              <li>
                <strong className="text-[var(--sand-text)]">Business transfers:</strong> In
                connection with a merger, acquisition, or sale of assets, with appropriate protections
                applied.
              </li>
              <li>
                <strong className="text-[var(--sand-text)]">With your consent:</strong> In any other
                case where you have given explicit permission.
              </li>
            </ul>
          </Section>

          <Section title="5. Data Retention">
            <p>
              We retain your account and project data for as long as your account remains active. If
              you delete your account, we will delete or anonymize your personal data within 90 days,
              except where we are required to retain it for legal or compliance purposes. Uploaded
              files hosted by UploadThing are subject to UploadThing&apos;s own retention policies.
            </p>
          </Section>

          <Section title="6. Cookies & Tracking">
            <p>
              Botflow uses cookies and similar technologies set by Clerk to maintain authentication
              sessions. We do not use advertising or behavioral-tracking cookies. You can control
              cookies through your browser settings, but disabling session cookies will prevent you
              from staying logged in.
            </p>
          </Section>

          <Section title="7. Security">
            <p>
              We implement industry-standard security measures, including TLS encryption for data in
              transit and access controls for data at rest. However, no system is completely secure.
              We encourage you to use a strong, unique password and to protect your account credentials.
            </p>
          </Section>

          <Section title="8. Children's Privacy">
            <p>
              Botflow is not directed to children under 13. We do not knowingly collect personal
              information from children under 13. If you believe we have inadvertently done so, please
              contact us at{" "}
              <a
                href="mailto:awkohler@botflow.io"
                className="text-fg underline decoration-border-strong underline-offset-4 transition-colors hover:decoration-fg"
              >
                awkohler@botflow.io
              </a>{" "}
              and we will delete the information promptly.
            </p>
          </Section>

          <Section title="9. Your Rights">
            <p>
              Depending on your location, you may have rights regarding your personal data, including
              the right to access, correct, or delete it. To exercise any of these rights, contact us
              at{" "}
              <a
                href="mailto:awkohler@botflow.io"
                className="text-fg underline decoration-border-strong underline-offset-4 transition-colors hover:decoration-fg"
              >
                awkohler@botflow.io
              </a>
              . We will respond within the timeframe required by applicable law.
            </p>
            <p className="mt-3">
              North Carolina residents may also have rights under the North Carolina Identity Theft
              Protection Act and any applicable state data-privacy legislation.
            </p>
          </Section>

          <Section title="10. Third-Party Links">
            <p>
              The platform may contain links to third-party websites or services. This Privacy Policy
              does not apply to those services, and we encourage you to review their privacy policies.
            </p>
          </Section>

          <Section title="11. Changes to This Policy">
            <p>
              We may update this Privacy Policy from time to time. When we do, we will update the
              effective date at the top of this page. If changes are material, we will notify you via
              email or a prominent notice within the platform. Continued use of Botflow after changes
              take effect constitutes acceptance of the updated policy.
            </p>
          </Section>

          <Section title="12. Contact">
            <p>
              If you have questions or concerns about this Privacy Policy, please contact us:
            </p>
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

function SubSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-4">
      <h3 className="text-sm font-semibold text-[var(--sand-text)] mb-1">{title}</h3>
      {children}
    </div>
  );
}
