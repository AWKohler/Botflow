/**
 * Turn a raw agent tool identifier into a short label a person can read in
 * the chat timeline, e.g. `mcp__botflow__getDevServerLog` → "Get dev server
 * log", `bash` → "Run command". Display only — never used for matching.
 */
const KNOWN: Record<string, string> = {
  bash: 'Run command',
  read: 'Read file',
  readfile: 'Read file',
  write: 'Write file',
  writefile: 'Write file',
  edit: 'Edit file',
  multiedit: 'Edit file',
  glob: 'Find files',
  grep: 'Search code',
  ls: 'List files',
  task: 'Run subtask',
  todowrite: 'Update plan',
  webfetch: 'Fetch page',
  websearch: 'Search the web',
};

export function formatToolName(raw: string): string {
  // "task — explore: find the nav" keeps its detail after the label.
  const [head, ...rest] = raw.split(' — ');
  const detail = rest.length ? ` — ${rest.join(' — ')}` : '';
  const name = head.replace(/^mcp__[a-z0-9-]+__/i, '');
  const known = KNOWN[name.toLowerCase()];
  if (known) return known + detail;
  const words = name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  if (!words) return raw;
  return words.charAt(0).toUpperCase() + words.slice(1) + detail;
}
