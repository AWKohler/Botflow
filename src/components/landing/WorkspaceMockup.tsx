'use client';

import { useState, useRef, useEffect } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  ArrowUp,
  Cog,
  Monitor,
  RefreshCw,
  ArrowUpRight,
  Square,
  PanelLeft,
  Github,
  Download,
  FileText,
  Folder,
  FolderOpen,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// ============================================================================
// Types
// ============================================================================

export interface MockMessage {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: { name: string; done: boolean }[];
}

export interface MockFileEntry {
  name: string;
  type: 'file' | 'folder';
  children?: MockFileEntry[];
}

export interface WorkspaceMockupProps {
  /** Chat messages to display in the agent panel */
  messages: MockMessage[];
  /** HTML string rendered in the preview iframe (inline) */
  previewHtml?: string;
  /** URL to load in the preview iframe (takes priority over previewHtml) */
  previewSrc?: string;
  /** Virtual viewport width the iframe should render at before being scaled down to fit. Defaults to 1440. */
  previewVirtualWidth?: number;
  /** Credit gauge percentage (0–100) */
  creditPct?: number;
  /** Fake file tree */
  files?: MockFileEntry[];
  /** Currently "selected" file name (shown in code tab header) */
  selectedFile?: string;
  /** Fake code content to show in the code editor area */
  codeContent?: string;
  /** Which tab is active by default */
  defaultView?: 'preview' | 'code' | 'database';
  /** Whether to show the agent "working" indicator */
  agentWorking?: boolean;
  /** Model name to display */
  modelName?: string;
  /** Additional className on the root */
  className?: string;
  /** Hide the left-side agent panel entirely — useful when the chrome around the chat would distract from the main surface. */
  hideAgentPanel?: boolean;
}

// ============================================================================
// CreditGauge (inlined for mockup independence)
// ============================================================================

function MockCreditGauge({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  const diameter = 40;
  const strokeWidth = 4;
  const radius = (diameter - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (clamped / 100) * circumference;
  const color = clamped >= 80 ? '#ef4444' : clamped >= 60 ? '#f59e0b' : '#22c55e';

  return (
    <div className="relative inline-flex items-center justify-center">
      <svg width={diameter} height={diameter} viewBox={`0 0 ${diameter} ${diameter}`} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={diameter / 2} cy={diameter / 2} r={radius} fill="none" stroke="currentColor" strokeWidth={strokeWidth} className="text-border opacity-40" />
        <circle cx={diameter / 2} cy={diameter / 2} r={radius} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={offset} style={{ transition: 'stroke-dashoffset 0.4s ease, stroke 0.4s ease' }} />
      </svg>
      <span className="absolute font-semibold tabular-nums" style={{ fontSize: 10, color, lineHeight: 1 }}>{clamped}%</span>
    </div>
  );
}

// ============================================================================
// Tabs (inlined)
// ============================================================================

function MockTabs({ options, selected, onSelect }: { options: { value: string; text: string }[]; selected: string; onSelect: (v: string) => void }) {
  return (
    <div className="flex rounded-lg p-1 border border-border">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onSelect(o.value)}
          className={cn(
            'px-4 py-1 text-sm font-medium rounded-md transition-all duration-200',
            selected === o.value ? 'bg-accent text-white shadow-sm font-bold' : 'text-muted hover:text-fg hover:bg-elevated/60',
          )}
        >
          {o.text}
        </button>
      ))}
    </div>
  );
}

// ============================================================================
// ToolStep (mockup version)
// ============================================================================

function MockToolStep({ name, done }: { name: string; done: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div className="flex items-center gap-2.5 h-7">
        <div className="shrink-0 z-10 size-[14px] rounded-full border-[1.5px] border-border bg-surface flex items-center justify-center">
          {done ? <Check size={8} className="text-muted" /> : <Loader2 size={8} className="animate-spin text-muted" />}
        </div>
        <button type="button" className="flex items-center gap-1 p-0 text-sm text-muted hover:text-fg transition-colors" onClick={() => setOpen((v) => !v)}>
          <span className="font-medium">{name}</span>
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </button>
      </div>
      {open && (
        <div className="pl-[26px] pb-1.5">
          <div className="text-xs text-muted bg-surface p-2 rounded border border-border">Tool output...</div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// File icon helper
// ============================================================================

function fileColor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    js: 'text-yellow-500', jsx: 'text-yellow-500',
    ts: 'text-blue-500', tsx: 'text-blue-500',
    json: 'text-orange-400',
    css: 'text-blue-400', scss: 'text-blue-400',
    html: 'text-orange-500',
    md: 'text-sky-400',
    py: 'text-green-500',
  };
  return map[ext] ?? 'text-muted';
}

// ============================================================================
// MockFileTree
// ============================================================================

function MockFileTree({ entries, depth = 0 }: { entries: MockFileEntry[]; depth?: number }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  return (
    <div>
      {entries.map((entry) => {
        const isFolder = entry.type === 'folder';
        const isOpen = expanded[entry.name] ?? (depth === 0);
        return (
          <div key={entry.name}>
            <button
              type="button"
              className="flex items-center gap-1.5 w-full text-left px-2 py-1 text-sm hover:bg-elevated/60 transition-colors"
              style={{ paddingLeft: `${depth * 16 + 8}px` }}
              onClick={() => isFolder && setExpanded((e) => ({ ...e, [entry.name]: !isOpen }))}
            >
              {isFolder ? (
                <>
                  {isOpen ? <ChevronDown size={12} className="text-muted" /> : <ChevronRight size={12} className="text-muted" />}
                  {isOpen ? <FolderOpen size={14} className="text-accent" /> : <Folder size={14} className="text-accent" />}
                </>
              ) : (
                <>
                  <span className="w-3" />
                  <FileText size={14} className={fileColor(entry.name)} />
                </>
              )}
              <span className={cn('truncate', isFolder ? 'text-fg font-medium' : 'text-fg')}>{entry.name}</span>
            </button>
            {isFolder && isOpen && entry.children && <MockFileTree entries={entry.children} depth={depth + 1} />}
          </div>
        );
      })}
    </div>
  );
}

// ============================================================================
// Fake code editor with syntax-ish coloring
// ============================================================================

function MockCodeEditor({ code }: { code: string }) {
  const lines = code.split('\n');
  return (
    <div className="h-full overflow-auto modern-scrollbar font-mono text-sm leading-6 p-4">
      {lines.map((line, i) => (
        <div key={i} className="flex">
          <span className="w-10 shrink-0 text-right pr-4 select-none text-muted/50 text-xs leading-6">{i + 1}</span>
          <span className="text-fg whitespace-pre">{line}</span>
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// ScaledIframe — renders the iframe at a fixed "desktop" virtual width and
// scales it down to fit its container so buttons/typography look natural
// instead of squished.
// ============================================================================

function ScaledIframe({
  src,
  srcDoc,
  virtualWidth,
  sandbox,
}: {
  src?: string;
  srcDoc?: string;
  virtualWidth: number;
  sandbox?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const update = () => {
      const r = el.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scale = size.w > 0 ? size.w / virtualWidth : 1;
  const virtualHeight = size.h > 0 ? size.h / scale : 0;

  return (
    <div ref={containerRef} className="w-full h-full overflow-hidden">
      {size.w > 0 && (
        <iframe
          src={src}
          srcDoc={srcDoc}
          sandbox={sandbox as never}
          title="Preview"
          style={{
            width: virtualWidth,
            height: virtualHeight,
            border: 0,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
          }}
        />
      )}
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function WorkspaceMockup({
  messages,
  previewHtml,
  previewSrc,
  previewVirtualWidth = 1440,
  creditPct = 32,
  files,
  selectedFile = 'App.tsx',
  codeContent,
  defaultView = 'preview',
  agentWorking = false,
  modelName = 'GPT-6.1 Sol',
  className,
  hideAgentPanel = false,
}: WorkspaceMockupProps) {
  const [currentView, setCurrentView] = useState<string>(defaultView);
  const [showSidebar, setShowSidebar] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Auto-scroll agent panel
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const defaultFiles: MockFileEntry[] = files ?? [
    {
      name: 'src',
      type: 'folder',
      children: [
        { name: 'App.tsx', type: 'file' },
        { name: 'main.tsx', type: 'file' },
        { name: 'index.css', type: 'file' },
      ],
    },
    {
      name: 'convex',
      type: 'folder',
      children: [
        { name: 'schema.ts', type: 'file' },
        { name: 'tasks.ts', type: 'file' },
      ],
    },
    { name: 'package.json', type: 'file' },
    { name: 'tsconfig.json', type: 'file' },
  ];

  const defaultCode =
    codeContent ??
    `import { useQuery, useMutation } from "convex/react";
import { api } from "../convex/_generated/api";

export default function App() {
  const tasks = useQuery(api.tasks.list);
  const addTask = useMutation(api.tasks.add);

  return (
    <div className="max-w-xl mx-auto p-8">
      <h1 className="text-3xl font-bold mb-6">
        My Tasks
      </h1>
      <ul className="space-y-2">
        {tasks?.map((task) => (
          <li key={task._id} className="p-3 rounded-lg bg-gray-50">
            {task.text}
          </li>
        ))}
      </ul>
    </div>
  );
}`;

  return (
    <div
      className={cn(
        'flex bolt-bg text-fg rounded-xl border border-border overflow-hidden shadow-2xl',
        className,
      )}
      style={{ height: 600 }}
    >
      {/* ================================================================ */}
      {/* Agent Sidebar                                                    */}
      {/* ================================================================ */}
      {!hideAgentPanel && (
      <div className="w-80 flex flex-col bg-elevated/70 backdrop-blur-sm border-border shrink-0">
        {/* Agent header */}
        <div className="flex items-center justify-between px-3 py-2 bg-surface text-sm">
          <div className="flex items-center gap-2">
            <Cog size={16} className="text-muted" />
            <MockCreditGauge pct={creditPct} />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted bg-elevated border border-border rounded-md px-2 py-0.5">{modelName}</span>
          </div>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-auto space-y-3 p-3 modern-scrollbar text-sm">
          {messages.map((m, mi) => {
            if (m.role === 'user') {
              return (
                <div key={mi} className="rounded-xl px-2 py-3 bg-elevated text-[0.95rem]">
                  <p>{m.content}</p>
                </div>
              );
            }

            // Assistant message
            const hasTools = m.toolCalls && m.toolCalls.length > 0;
            return (
              <div key={mi} className="rounded-xl px-2 py-3 text-[0.95rem]">
                {/* Text before tools */}
                {m.content && <p className="mb-2">{m.content}</p>}

                {/* Tool timeline */}
                {hasTools && (
                  <div className="relative">
                    <div className="absolute left-[6px] top-[14px] bottom-0 w-px bg-border" />
                    {m.toolCalls!.map((tc, ti) => (
                      <MockToolStep key={ti} name={tc.name} done={tc.done} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {/* Working indicator */}
          {agentWorking && (
            <div className="flex items-center gap-2 py-2">
              <Loader2 size={14} className="animate-spin text-accent" />
              <span className="text-xs text-muted">
                Agent is working<span className="animate-pulse">...</span>
              </span>
            </div>
          )}
        </div>

        {/* Input area */}
        <div className="mt-2 mx-2.5 mb-2.5">
          <div className="flex flex-col rounded-2xl border border-border bg-elevated">
            <div className="px-4 pt-3">
              <div className="relative flex flex-1 items-center">
                <div
                  className="flex w-full text-[14px] leading-snug text-muted m-1 p-0 select-none"
                  style={{ minHeight: 40 }}
                >
                  Ask Botflow...
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1 px-4 pb-2">
              <div className="ml-auto">
                <div className="flex size-6 items-center justify-center rounded-full bg-accent text-accent-foreground opacity-50">
                  <ArrowUp size={20} />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      )}

      {/* ================================================================ */}
      {/* Main Content Area                                                */}
      {/* ================================================================ */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="h-12 flex items-center px-2.5 gap-4 bg-surface backdrop-blur-sm shrink-0">
          {/* Tabs */}
          <MockTabs
            options={[
              { value: 'preview', text: 'Preview' },
              { value: 'code', text: 'Code' },
              { value: 'database', text: 'Database' },
            ]}
            selected={currentView}
            onSelect={setCurrentView}
          />

          {/* Stop button (dev server is "running" in mockup) */}
          <button className="flex items-center gap-2 font-bold text-md text-red-400 px-2 py-1 rounded-md hover:bg-red-400/10 transition-colors">
            <Square size={16} fill="currentColor" />
            <span>Stop</span>
          </button>

          {/* File explorer toggle (code view) */}
          {currentView === 'code' && (
            <button
              onClick={() => setShowSidebar(!showSidebar)}
              className="text-muted hover:text-fg bolt-hover p-1 rounded"
            >
              <PanelLeft size={16} />
            </button>
          )}

          {/* Selected file (code view) */}
          {currentView === 'code' && selectedFile && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted">/</span>
              <span className="text-fg font-medium bg-elevated/70 px-2 py-1 rounded">{selectedFile}</span>
            </div>
          )}

          {/* Right-side controls */}
          <div className="ml-auto flex items-center gap-2">
            {/* Cloud sync indicator */}
            <div className="text-xs text-muted flex items-center gap-1.5 px-2 py-1 rounded-md bg-elevated">
              <div className="w-2 h-2 rounded-full bg-green-500" />
              <span>Synced 2m ago</span>
            </div>

            {/* Preview URL bar (preview view) */}
            {currentView === 'preview' && (
              <div className="flex items-center gap-2 border border-border rounded-full px-3 py-1 min-w-[180px]">
                <Monitor size={16} className="text-muted" />
                <span className="text-muted text-sm select-none">/</span>
                <span className="flex-1 text-sm text-fg"></span>
                <ArrowUpRight size={16} className="text-muted" />
                <RefreshCw size={16} className="text-muted" />
              </div>
            )}

            {/* Avatar placeholder */}
            <div className="w-8 h-8 rounded-full bg-accent/20 border border-border" />

            {/* Action buttons */}
            {currentView === 'code' && (
              <button className="w-8 h-8 flex items-center justify-center border border-border rounded-md text-muted hover:text-fg">
                <Download size={16} />
              </button>
            )}
            <button className="w-8 h-8 flex items-center justify-center border border-border rounded-md text-muted hover:text-fg border-green-500/50 text-green-600 dark:text-green-400 relative">
              <Github size={16} />
              <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-green-500 border-2 border-surface" />
            </button>
            <button className="px-3 py-1 text-sm font-bold rounded-md bg-green-600 hover:bg-green-700 text-white relative">
              Published
              <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-green-500 border-2 border-surface" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 relative bg-surface">
          {/* Preview View */}
          <div className={cn('absolute inset-0 pb-2.5 pr-2.5', currentView === 'preview' ? 'block' : 'hidden')}>
            <div className="w-full h-full rounded-xl border border-border overflow-hidden bg-white dark:bg-[#1a1a1a]">
              {previewSrc ? (
                <ScaledIframe src={previewSrc} virtualWidth={previewVirtualWidth} />
              ) : previewHtml ? (
                <ScaledIframe
                  srcDoc={previewHtml}
                  virtualWidth={previewVirtualWidth}
                  sandbox="allow-scripts"
                />
              ) : (
                <div className="flex items-center justify-center h-full text-muted text-sm">
                  Preview
                </div>
              )}
            </div>
          </div>

          {/* Code View */}
          <div className={cn('absolute inset-0', currentView === 'code' ? 'flex flex-col' : 'hidden', 'rounded-xl border border-border overflow-hidden')}>
            <div className="flex-1 min-h-0 flex">
              {/* File sidebar */}
              {showSidebar && (
                <div className="w-64 border-r border-border flex flex-col backdrop-blur-sm shrink-0">
                  <div className="p-2 border-b border-border">
                    <div className="flex rounded-lg p-1 border border-border w-full">
                      {['Files', 'Search', 'ENV'].map((t) => (
                        <button
                          key={t}
                          className={cn(
                            'flex-1 px-3 py-1 text-sm font-medium rounded-md transition-all duration-200',
                            t === 'Files' ? 'bg-accent text-white shadow-sm font-bold' : 'text-muted',
                          )}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex-1 overflow-auto modern-scrollbar">
                    <MockFileTree entries={defaultFiles} />
                  </div>
                </div>
              )}

              {/* Editor */}
              <div className="flex-1 min-h-0 relative">
                <div className="absolute inset-0 bg-elevated/90 backdrop-blur-sm">
                  <MockCodeEditor code={defaultCode} />
                </div>
              </div>
            </div>

            {/* Terminal */}
            <div className="h-40 border-t border-border bg-elevated backdrop-blur-sm shrink-0">
              <div className="flex items-center border-b border-border px-2">
                <button className="px-3 py-1.5 text-xs font-medium bg-surface text-fg rounded-t-md border-b-2 border-accent">
                  Terminal 1
                </button>
                <button className="px-3 py-1.5 text-xs text-muted">Terminal 2</button>
              </div>
              <div className="p-2 font-mono text-xs text-muted leading-5 overflow-auto modern-scrollbar h-[calc(100%-32px)]">
                <p className="text-green-400">$ pnpm dev</p>
                <p>  VITE v6.2.1  ready in 312 ms</p>
                <p></p>
                <p>  ➜  Local:   <span className="text-accent">http://localhost:5173/</span></p>
                <p>  ➜  Network: use --host to expose</p>
                <p className="text-muted">  ➜  press h + enter to show help</p>
              </div>
            </div>
          </div>

          {/* Database View */}
          <div className={cn('absolute inset-0 pb-2.5 px-2.5', currentView === 'database' ? 'block' : 'hidden')}>
            <div className="w-full h-full rounded-xl border border-border overflow-hidden bg-surface">
              <iframe
                src="/convex_mockup.html"
                className="w-full h-full border-0"
                title="Database"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
