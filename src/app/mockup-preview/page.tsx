import { WorkspaceMockup } from '@/components/landing/WorkspaceMockup';

export default function MockupPreviewPage() {
  return (
    <div className="min-h-screen bg-bg p-8 space-y-12">
      <h1 className="text-2xl font-bold text-fg">Workspace Mockup Preview</h1>

      {/* Preview view mockup */}
      <div>
        <h2 className="text-lg font-semibold text-fg mb-4">Preview Mode (agent working)</h2>
        <WorkspaceMockup
          messages={[
            { role: 'user', content: 'Build me a task manager app with Convex backend' },
            {
              role: 'assistant',
              content: "I'll create a task manager with full CRUD operations using Convex.",
              toolCalls: [
                { name: 'writeFile', done: true },
                { name: 'writeFile', done: true },
                { name: 'writeFile', done: true },
                { name: 'convexDeploy', done: true },
                { name: 'startDevServer', done: true },
              ],
            },
            { role: 'assistant', content: 'Your task manager is live! You can add, complete, and delete tasks. The data persists in your Convex database.' },
            { role: 'user', content: 'Add a dark mode toggle and animate the task list' },
            {
              role: 'assistant',
              content: 'Adding dark mode support and list animations.',
              toolCalls: [
                { name: 'readFile', done: true },
                { name: 'writeFile', done: true },
                { name: 'writeFile', done: false },
              ],
            },
          ]}
          // previewSrc="/preview_mockup.html"
          // previewSrc="/discover_events_preview.html"
          previewSrc='component_gallery_preview.html'
          creditPct={47}
          agentWorking={true}
          defaultView="preview"
        />
      </div>

      {/* Code view mockup */}
      <div>
        <h2 className="text-lg font-semibold text-fg mb-4">Code Mode</h2>
        <WorkspaceMockup
          messages={[
            { role: 'user', content: 'Create a landing page with hero section' },
            {
              role: 'assistant',
              content: 'Done! I created a responsive landing page with a hero section, feature cards, and a CTA.',
              toolCalls: [
                { name: 'writeFile', done: true },
                { name: 'writeFile', done: true },
                { name: 'startDevServer', done: true },
              ],
            },
          ]}
          creditPct={18}
          defaultView="code"
          agentWorking={false}
          modelName="Claude Sonnet 5"
        />
      </div>
    </div>
  );
}
