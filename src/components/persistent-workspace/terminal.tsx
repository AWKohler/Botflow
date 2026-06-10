"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface PersistentTerminalProps {
  projectId: string;
  ready: boolean;
  cwd?: string;
}

const PROMPT = "\x1b[1;32m$\x1b[0m ";
const HISTORY_MAX = 200;

export function PersistentTerminal({ projectId, ready, cwd = "/vercel/sandbox" }: PersistentTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const inputRef = useRef<string>("");
  const cursorRef = useRef<number>(0);
  const runningRef = useRef<boolean>(false);
  const abortRef = useRef<AbortController | null>(null);
  const cwdRef = useRef<string>(cwd);
  const historyRef = useRef<string[]>([]);
  const historyIdxRef = useRef<number>(-1);
  const [mounted, setMounted] = useState(false);

  // Initialize xterm once
  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      theme: {
        background: getComputedStyle(document.documentElement).getPropertyValue("--sand-elevated").trim() || "#2b2722",
        foreground: getComputedStyle(document.documentElement).getPropertyValue("--sand-text").trim() || "#ede6db",
        cursor: "#c07a4c",
        selectionBackground: "#c07a4c40",
      },
      fontSize: 13,
      fontFamily: 'Monaco, Menlo, "Ubuntu Mono", monospace',
      cursorBlink: true,
      convertEol: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    xtermRef.current = term;
    fitRef.current = fit;
    setMounted(true);

    const onResize = () => fit.fit();
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(containerRef.current);

    term.writeln("\x1b[2mEach command runs in a fresh shell. Use `cd <dir>` to change the working directory.\x1b[0m");
    term.writeln("");

    return () => {
      window.removeEventListener("resize", onResize);
      ro.disconnect();
      term.dispose();
      xtermRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // Wire input handlers once xterm is mounted
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;

    const writePrompt = () => {
      const cwdLabel = cwdRef.current.replace(/^\/vercel\/sandbox/, "") || "/";
      term.write(`\r\n\x1b[2m${cwdLabel}\x1b[0m ${PROMPT}`);
      inputRef.current = "";
      cursorRef.current = 0;
    };

    const renderInput = () => {
      // Clear current line back to prompt and rewrite buffer
      term.write("\x1b[2K\r" + PROMPT + inputRef.current);
      const tail = inputRef.current.length - cursorRef.current;
      if (tail > 0) term.write(`\x1b[${tail}D`);
    };

    const submit = async (raw: string) => {
      const cmd = raw.trim();
      term.write("\r\n");
      if (!cmd) {
        writePrompt();
        return;
      }

      historyRef.current.push(cmd);
      if (historyRef.current.length > HISTORY_MAX) {
        historyRef.current = historyRef.current.slice(-HISTORY_MAX);
      }
      historyIdxRef.current = historyRef.current.length;

      // Handle `cd` locally so subsequent commands inherit the cwd
      if (cmd === "cd" || cmd === "cd ~") {
        cwdRef.current = "/vercel/sandbox";
        writePrompt();
        return;
      }
      const cdMatch = cmd.match(/^cd\s+(.+)$/);
      if (cdMatch) {
        const target = cdMatch[1].trim().replace(/^['"]|['"]$/g, "");
        const next = target.startsWith("/") ? target : `${cwdRef.current.replace(/\/$/, "")}/${target}`;
        // Verify it exists via a quick test
        try {
          const res = await fetch(`/api/projects/${projectId}/sandbox/exec`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cmd: "test", args: ["-d", next], cwd: "/vercel/sandbox" }),
          });
          // Drain stream + read exit code
          let exit = 1;
          if (res.body) {
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = "";
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              const parts = buf.split("\n\n");
              buf = parts.pop() ?? "";
              for (const part of parts) {
                const lines = part.split("\n");
                let event = "";
                let data = "";
                for (const line of lines) {
                  if (line.startsWith("event: ")) event = line.slice(7).trim();
                  else if (line.startsWith("data: ")) {
                    try { data = JSON.parse(line.slice(6)); } catch { data = line.slice(6); }
                  }
                }
                if (event === "exit") exit = Number(data) || 0;
              }
            }
          }
          if (exit === 0) {
            // Normalize path (remove trailing /, collapse ..)
            cwdRef.current = next.replace(/\/+$/, "") || "/vercel/sandbox";
          } else {
            term.writeln(`\x1b[31mcd: no such directory: ${target}\x1b[0m`);
          }
        } catch (e) {
          term.writeln(`\x1b[31mcd failed: ${e instanceof Error ? e.message : "unknown"}\x1b[0m`);
        }
        writePrompt();
        return;
      }

      if (cmd === "clear") {
        term.clear();
        writePrompt();
        return;
      }

      runningRef.current = true;
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      try {
        const res = await fetch(`/api/projects/${projectId}/sandbox/exec`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cmd: "bash", args: ["-lc", cmd], cwd: cwdRef.current }),
          signal: ctrl.signal,
        });

        if (!res.body) {
          term.writeln("\x1b[31mNo response stream\x1b[0m");
        } else {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const parts = buf.split("\n\n");
            buf = parts.pop() ?? "";
            for (const part of parts) {
              const lines = part.split("\n");
              let event = "stdout";
              let data = "";
              for (const line of lines) {
                if (line.startsWith("event: ")) event = line.slice(7).trim();
                else if (line.startsWith("data: ")) {
                  try { data = JSON.parse(line.slice(6)); } catch { data = line.slice(6); }
                }
              }
              if (!data) continue;
              if (event === "stderr") term.write(`\x1b[31m${data}\x1b[0m`);
              else if (event === "exit") {
                const code = Number(data);
                if (code !== 0) term.write(`\r\n\x1b[2m[exit ${code}]\x1b[0m`);
              } else if (event === "error") {
                term.write(`\r\n\x1b[31m${data}\x1b[0m`);
              } else {
                term.write(data);
              }
            }
          }
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          term.write("\r\n\x1b[33m^C\x1b[0m");
        } else {
          term.write(`\r\n\x1b[31m${err instanceof Error ? err.message : "Command failed"}\x1b[0m`);
        }
      } finally {
        runningRef.current = false;
        abortRef.current = null;
        writePrompt();
      }
    };

    const onData = term.onData((data) => {
      if (runningRef.current) {
        // Allow Ctrl+C to abort the running command
        if (data === "\u0003" && abortRef.current) {
          abortRef.current.abort();
        }
        return;
      }

      // Handle paste (multiple chars at once)
      if (data.length > 1 && !data.startsWith("\x1b")) {
        const sanitized = data.replace(/\r/g, "");
        const before = inputRef.current.slice(0, cursorRef.current);
        const after = inputRef.current.slice(cursorRef.current);
        inputRef.current = before + sanitized + after;
        cursorRef.current += sanitized.length;
        renderInput();
        return;
      }

      switch (data) {
        case "\r": // Enter
          submit(inputRef.current);
          break;
        case "\u0003": // Ctrl+C
          term.write("^C");
          inputRef.current = "";
          cursorRef.current = 0;
          writePrompt();
          break;
        case "\u007F": { // Backspace
          if (cursorRef.current > 0) {
            const before = inputRef.current.slice(0, cursorRef.current - 1);
            const after = inputRef.current.slice(cursorRef.current);
            inputRef.current = before + after;
            cursorRef.current -= 1;
            renderInput();
          }
          break;
        }
        case "\x1b[A": { // Up arrow → history prev
          if (historyRef.current.length === 0) break;
          historyIdxRef.current = Math.max(0, historyIdxRef.current - 1);
          inputRef.current = historyRef.current[historyIdxRef.current] ?? "";
          cursorRef.current = inputRef.current.length;
          renderInput();
          break;
        }
        case "\x1b[B": { // Down arrow → history next
          if (historyRef.current.length === 0) break;
          historyIdxRef.current = Math.min(historyRef.current.length, historyIdxRef.current + 1);
          inputRef.current = historyRef.current[historyIdxRef.current] ?? "";
          cursorRef.current = inputRef.current.length;
          renderInput();
          break;
        }
        case "\x1b[C": { // Right arrow
          if (cursorRef.current < inputRef.current.length) {
            cursorRef.current += 1;
            term.write("\x1b[C");
          }
          break;
        }
        case "\x1b[D": { // Left arrow
          if (cursorRef.current > 0) {
            cursorRef.current -= 1;
            term.write("\x1b[D");
          }
          break;
        }
        case "\x1b[H": // Home
        case "\x01": { // Ctrl+A
          if (cursorRef.current > 0) {
            term.write(`\x1b[${cursorRef.current}D`);
            cursorRef.current = 0;
          }
          break;
        }
        case "\x1b[F": // End
        case "\x05": { // Ctrl+E
          const tail = inputRef.current.length - cursorRef.current;
          if (tail > 0) {
            term.write(`\x1b[${tail}C`);
            cursorRef.current = inputRef.current.length;
          }
          break;
        }
        case "\u000C": { // Ctrl+L → clear
          term.clear();
          term.write(PROMPT + inputRef.current);
          if (cursorRef.current < inputRef.current.length) {
            term.write(`\x1b[${inputRef.current.length - cursorRef.current}D`);
          }
          break;
        }
        default: {
          // Printable
          const code = data.charCodeAt(0);
          if (code < 32 || code === 127) break;
          const before = inputRef.current.slice(0, cursorRef.current);
          const after = inputRef.current.slice(cursorRef.current);
          inputRef.current = before + data + after;
          cursorRef.current += data.length;
          if (after.length === 0) {
            term.write(data);
          } else {
            renderInput();
          }
        }
      }
    });

    return () => onData.dispose();
  }, [mounted, projectId]);

  // Render an initial prompt once the sandbox is ready
  const initialPromptShownRef = useRef(false);
  useEffect(() => {
    const term = xtermRef.current;
    if (!term || !ready || initialPromptShownRef.current) return;
    initialPromptShownRef.current = true;
    const cwdLabel = cwdRef.current.replace(/^\/vercel\/sandbox/, "") || "/";
    term.write(`\x1b[2m${cwdLabel}\x1b[0m ${PROMPT}`);
  }, [ready]);

  return (
    <div className="h-full w-full flex flex-col bg-elevated">
      <div ref={containerRef} className="flex-1 p-2" style={{ minHeight: 0 }} />
    </div>
  );
}
