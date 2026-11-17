'use client';

import { Editor, BeforeMount, OnMount } from '@monaco-editor/react';
import { FileCode2 } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';
import type { editor as MonacoEditor } from 'monaco-editor';
import { useEffect, useRef, useState } from 'react';

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language: string;
  filename: string | null;
  disabled?: boolean;
  /** 1-based line to scroll to + center. Used by the build-error
   * "click-to-jump" affordance. Updates to `revealNonce` re-trigger the
   * reveal even if `revealLine` stays the same. */
  revealLine?: number;
  revealNonce?: number;
}

// Sand design token values (mirrored from globals.css)
const DARK = {
  bg:       '#1b1815',
  surface:  '#221f1b',
  elevated: '#2a2621',
  border:   '#35302a',
  text:     '#ede6db',
  muted:    '#b5ab9f',
  subtle:   '#857c72',
  accent:   '#d8826a',
  accentDim:'#c07a4c',
};
const LIGHT = {
  bg:       '#fefefe',
  surface:  '#fbfaf7',
  elevated: '#f6f3ec',
  border:   '#e9e6df',
  text:     '#27272a',
  muted:    '#5f5e5a',
  subtle:   '#8b8984',
  accent:   '#1d52f1',
  accentDim:'#1740c8',
};

export function CodeEditor({
  value,
  onChange,
  language,
  filename,
  disabled = false,
  revealLine,
  revealNonce,
}: CodeEditorProps) {
  const [themeName, setThemeName] = useState<'sand-light' | 'sand-dark'>('sand-light');
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);

  // React to revealLine changes — center the requested line and place the
  // cursor there. revealNonce makes repeat-clicks of the same line still
  // trigger a reveal (otherwise the effect skips when revealLine is unchanged).
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || !revealLine || revealLine < 1) return;
    ed.revealLineInCenter(revealLine);
    ed.setPosition({ lineNumber: revealLine, column: 1 });
    ed.focus();
  }, [revealLine, revealNonce]);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => setThemeName(mq.matches ? 'sand-dark' : 'sand-light');
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  const beforeMount: BeforeMount = (monaco) => {
    // ── Dark theme ──────────────────────────────────────────────────────────
    monaco.editor.defineTheme('sand-dark', {
      base: 'vs-dark',
      inherit: true,
      colors: {
        // Core
        'editor.background':                    DARK.bg,
        'editor.foreground':                    DARK.text,
        'editorCursor.foreground':              DARK.accent,
        'editorLineNumber.foreground':          DARK.subtle,
        'editorLineNumber.activeForeground':    DARK.muted,
        'editor.selectionBackground':           DARK.accent + '30',
        'editor.inactiveSelectionBackground':   DARK.accent + '18',
        'editor.lineHighlightBackground':       '#ffffff08',
        'editor.lineHighlightBorder':           '#00000000',
        // Hover / diagnostic tooltips
        'editorWidget.background':              DARK.surface,
        'editorWidget.border':                  DARK.border,
        'editorWidget.foreground':              DARK.text,
        'editorHoverWidget.background':         DARK.surface,
        'editorHoverWidget.border':             DARK.border,
        'editorHoverWidget.foreground':         DARK.text,
        'editorHoverWidget.statusBarBackground':DARK.bg,
        // Suggest / autocomplete
        'editorSuggestWidget.background':       DARK.surface,
        'editorSuggestWidget.border':           DARK.border,
        'editorSuggestWidget.foreground':       DARK.text,
        'editorSuggestWidget.selectedBackground': DARK.accent + '28',
        'editorSuggestWidget.selectedForeground': DARK.text,
        'editorSuggestWidget.highlightForeground': DARK.accent,
        'editorSuggestWidget.focusHighlightForeground': DARK.accent,
        // Context menu (right-click)
        'menu.background':          DARK.surface,
        'menu.foreground':          DARK.text,
        'menu.selectionBackground': DARK.accent + '28',
        'menu.selectionForeground': DARK.text,
        'menu.separatorBackground': DARK.border,
        'menu.border':              DARK.border,
        // Dropdowns & inputs (find bar, etc.)
        'dropdown.background':       DARK.surface,
        'dropdown.border':           DARK.border,
        'dropdown.foreground':       DARK.text,
        'input.background':          DARK.bg,
        'input.border':              DARK.border,
        'input.foreground':          DARK.text,
        'input.placeholderForeground': DARK.subtle,
        // List / tree
        'list.hoverBackground':            DARK.accent + '15',
        'list.activeSelectionBackground':  DARK.accent + '28',
        'list.activeSelectionForeground':  DARK.text,
        'list.focusBackground':            DARK.accent + '28',
        // Scrollbar
        'scrollbarSlider.background':      DARK.subtle + '44',
        'scrollbarSlider.hoverBackground': DARK.subtle + '66',
        'scrollbarSlider.activeBackground':DARK.subtle + '88',
        // Bracket match
        'editorBracketMatch.background':   DARK.accent + '28',
        'editorBracketMatch.border':       DARK.accent + '66',
        // Squiggles
        'editorError.foreground':   '#f28b82',
        'editorWarning.foreground': '#f9c74f',
        'editorInfo.foreground':    '#90c8f8',
        // Focus ring
        'focusBorder': DARK.accent + '55',
      },
      rules: [
        { token: 'comment',    foreground: '6b6259', fontStyle: 'italic' },
        { token: 'string',     foreground: 'd89b6a' },
        { token: 'number',     foreground: 'c07a4c' },
        { token: 'keyword',    foreground: 'c07a4c' },
        { token: 'type',       foreground: 'e3b48e' },
        { token: 'class',      foreground: 'e3b48e' },
        { token: 'function',   foreground: 'f0c89a' },
        { token: 'variable',   foreground: 'ede6db' },
        { token: 'identifier', foreground: 'ede6db' },
        { token: 'delimiter',  foreground: 'b8ada1' },
        { token: 'operator',   foreground: 'b8ada1' },
      ],
    });

    // ── Light theme ─────────────────────────────────────────────────────────
    monaco.editor.defineTheme('sand-light', {
      base: 'vs',
      inherit: true,
      colors: {
        'editor.background':                     LIGHT.bg,
        'editor.foreground':                     LIGHT.text,
        'editorCursor.foreground':               LIGHT.accent,
        'editorLineNumber.foreground':           LIGHT.subtle,
        'editorLineNumber.activeForeground':     LIGHT.muted,
        'editor.selectionBackground':            LIGHT.accent + '28',
        'editor.inactiveSelectionBackground':    LIGHT.accent + '15',
        'editor.lineHighlightBackground':        '#00000008',
        'editor.lineHighlightBorder':            '#00000000',
        'editorWidget.background':               LIGHT.surface,
        'editorWidget.border':                   LIGHT.border,
        'editorWidget.foreground':               LIGHT.text,
        'editorHoverWidget.background':          LIGHT.surface,
        'editorHoverWidget.border':              LIGHT.border,
        'editorHoverWidget.foreground':          LIGHT.text,
        'editorHoverWidget.statusBarBackground': LIGHT.elevated,
        'editorSuggestWidget.background':        LIGHT.surface,
        'editorSuggestWidget.border':            LIGHT.border,
        'editorSuggestWidget.foreground':        LIGHT.text,
        'editorSuggestWidget.selectedBackground': LIGHT.accent + '18',
        'editorSuggestWidget.selectedForeground': LIGHT.text,
        'editorSuggestWidget.highlightForeground': LIGHT.accent,
        'editorSuggestWidget.focusHighlightForeground': LIGHT.accent,
        'menu.background':          LIGHT.surface,
        'menu.foreground':          LIGHT.text,
        'menu.selectionBackground': LIGHT.accent + '18',
        'menu.selectionForeground': LIGHT.text,
        'menu.separatorBackground': LIGHT.border,
        'menu.border':              LIGHT.border,
        'dropdown.background':       LIGHT.surface,
        'dropdown.border':           LIGHT.border,
        'dropdown.foreground':       LIGHT.text,
        'input.background':          LIGHT.bg,
        'input.border':              LIGHT.border,
        'input.foreground':          LIGHT.text,
        'input.placeholderForeground': LIGHT.subtle,
        'list.hoverBackground':            LIGHT.accent + '12',
        'list.activeSelectionBackground':  LIGHT.accent + '18',
        'list.activeSelectionForeground':  LIGHT.text,
        'list.focusBackground':            LIGHT.accent + '18',
        'scrollbarSlider.background':      LIGHT.subtle + '44',
        'scrollbarSlider.hoverBackground': LIGHT.subtle + '66',
        'scrollbarSlider.activeBackground':LIGHT.subtle + '88',
        'editorBracketMatch.background':   LIGHT.accent + '18',
        'editorBracketMatch.border':       LIGHT.accent + '55',
        'editorError.foreground':   '#d93025',
        'editorWarning.foreground': '#e67700',
        'editorInfo.foreground':    LIGHT.accent,
        'focusBorder': LIGHT.accent + '55',
      },
      rules: [
        { token: 'comment',    foreground: 'a0968a', fontStyle: 'italic' },
        { token: 'string',     foreground: '7b4f1e' },
        { token: 'number',     foreground: 'a0522d' },
        { token: 'keyword',    foreground: '1d52f1' },
        { token: 'type',       foreground: '5a3e8a' },
        { token: 'class',      foreground: '5a3e8a' },
        { token: 'function',   foreground: '1740c8' },
        { token: 'variable',   foreground: '2f2f31' },
        { token: 'identifier', foreground: '2f2f31' },
        { token: 'delimiter',  foreground: '5a5450' },
        { token: 'operator',   foreground: '5a5450' },
      ],
    });
  };

  const onMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    // If a reveal was requested before the editor mounted (e.g. clicking an
    // issue while the file was loading), apply it now.
    if (revealLine && revealLine >= 1) {
      editor.revealLineInCenter(revealLine);
      editor.setPosition({ lineNumber: revealLine, column: 1 });
    }
    // ── Tailwind: suppress false-positive CSS diagnostics ──────────────────
    // @tailwind, @apply, @layer, @screen are all unknown to the CSS spec parser
    const tailwindLintOptions = {
      validate: true,
      lint: {
        unknownAtRules: 'ignore' as const,
        // @apply writes utility class names as property-like values
        unknownProperties: 'ignore' as const,
      },
    };
    monaco.languages.css.cssDefaults.setOptions(tailwindLintOptions);
    monaco.languages.css.scssDefaults.setOptions(tailwindLintOptions);
    monaco.languages.css.lessDefaults.setOptions(tailwindLintOptions);

    // ── TypeScript: path aliases + Next.js JSX, suppress non-actionable errors ──
    const sharedDiagnostics = {
      noSemanticValidation: false,
      noSyntaxValidation: false,
      diagnosticCodesToIgnore: [
        2307, // Cannot find module '@/...' (path alias not resolved in-browser)
        7016, // Could not find declaration file for module
        2305, // Module has no exported member (stale type cache)
      ],
    };
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions(sharedDiagnostics);
    monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions(sharedDiagnostics);

    const sharedCompilerOptions = {
      jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
      target: monaco.languages.typescript.ScriptTarget.ESNext,
      module: monaco.languages.typescript.ModuleKind.ESNext,
      allowSyntheticDefaultImports: true,
      esModuleInterop: true,
      allowJs: true,
      skipLibCheck: true,
      strict: false,
      baseUrl: '.',
      paths: { '@/*': ['./src/*'] },
    };
    monaco.languages.typescript.typescriptDefaults.setCompilerOptions(sharedCompilerOptions);
    monaco.languages.typescript.javascriptDefaults.setCompilerOptions(sharedCompilerOptions);
  };

  const handleChange = (value: string | undefined) => {
    onChange(value || '');
  };

  if (!filename) {
    return (
      <div className="flex h-full items-center justify-center bg-bg">
        <EmptyState
          icon={FileCode2}
          title="No file open"
          description="Pick a file from the explorer to view or edit it."
        />
      </div>
    );
  }

  return (
    <Editor
      height="100%"
      language={language}
      value={value}
      onChange={disabled ? undefined : handleChange}
      theme={themeName}
      beforeMount={beforeMount}
      onMount={onMount}
      options={{
        minimap: { enabled: false },
        fontSize: 14,
        lineNumbers: 'on',
        roundedSelection: false,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        insertSpaces: true,
        wordWrap: 'on',
        bracketPairColorization: { enabled: true },
        readOnly: disabled,
        guides: {
          bracketPairs: true,
          bracketPairsHorizontal: true,
          highlightActiveBracketPair: true,
          indentation: true,
        },
        quickSuggestions: disabled ? false : {
          other: true,
          comments: true,
          strings: true,
        },
        acceptSuggestionOnCommitCharacter: !disabled,
        acceptSuggestionOnEnter: disabled ? 'off' : 'on',
        accessibilitySupport: 'off',
        renderLineHighlight: 'line',
        colorDecorators: true,
        contextmenu: !disabled,
        copyWithSyntaxHighlighting: true,
        cursorBlinking: disabled ? 'solid' : 'blink',
        cursorSmoothCaretAnimation: disabled ? 'off' : 'on',
        cursorStyle: 'line',
        dragAndDrop: !disabled,
        emptySelectionClipboard: false,
        foldingHighlight: true,
        formatOnPaste: !disabled,
        formatOnType: !disabled,
        matchBrackets: 'always',
        occurrencesHighlight: 'singleFile',
        overviewRulerBorder: false,
        overviewRulerLanes: 3,
        padding: { top: 12, bottom: 12 },
        parameterHints: { enabled: !disabled },
        quickSuggestionsDelay: 10,
        renderControlCharacters: false,
        renderValidationDecorations: 'on',
        renderWhitespace: 'none',
        scrollbar: {
          vertical: 'visible',
          horizontal: 'visible',
          arrowSize: 11,
          useShadows: true,
          verticalHasArrows: false,
          horizontalHasArrows: false,
          horizontalScrollbarSize: 12,
          verticalScrollbarSize: 12,
          verticalSliderSize: 12,
          horizontalSliderSize: 12,
        },
        selectionHighlight: !disabled,
        smoothScrolling: true,
        snippetSuggestions: disabled ? 'none' : 'top',
      }}
    />
  );
}
