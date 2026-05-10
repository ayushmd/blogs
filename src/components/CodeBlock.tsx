"use client";

import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { useTheme } from "next-themes";
import { useMemo, useState, useEffect } from "react";

interface CodeBlockProps {
  language: string;
  code: string;
}

const languageLabels: Record<string, string> = {
  go: "Go",
  js: "JavaScript",
  javascript: "JavaScript",
  ts: "TypeScript",
  typescript: "TypeScript",
  py: "Python",
  python: "Python",
  bash: "Bash",
  shell: "Shell",
  json: "JSON",
  yaml: "YAML",
  html: "HTML",
  css: "CSS",
  sql: "SQL",
  rust: "Rust",
  java: "Java",
  c: "C",
  cpp: "C++",
};

/** Show expand/collapse when code has more lines than this. */
const COLLAPSE_LINE_THRESHOLD = 20;

export function CodeBlock({ language, code }: CodeBlockProps) {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [copied, setCopied] = useState(false);
  const [codeExpanded, setCodeExpanded] = useState(false);
  useEffect(() => setMounted(true), []);

  const style = useMemo(() => {
    if (!mounted) return oneLight;
    return resolvedTheme === "dark" ? oneDark : oneLight;
  }, [mounted, resolvedTheme]);

  const label = languageLabels[language.toLowerCase()] ?? language;

  const lineCount = code.split("\n").length;
  const needsCollapse = lineCount > COLLAPSE_LINE_THRESHOLD;
  /** Matches SyntaxHighlighter: fontSize 0.8125rem, lineHeight 1.65, vertical padding 2rem total */
  const collapsedMaxHeight =
    "calc(2rem + " + COLLAPSE_LINE_THRESHOLD + " * (0.8125rem * 1.65))";

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  return (
    <div className="not-prose my-6 min-w-0 overflow-hidden rounded-xl border border-[var(--border)] shadow-sm">
      <div className="flex min-w-0 items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-1.5">
        <span className="text-xs font-semibold uppercase tracking-wider text-[var(--foreground)]">
          {label}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-[var(--muted)] transition hover:bg-[var(--border)] hover:text-[var(--foreground)]"
          aria-label={copied ? "Copied" : "Copy code"}
        >
          {copied ? (
            <>
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="20 6 9 17 4 12" />
              </svg>
              Copied
            </>
          ) : (
            <>
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
              </svg>
              Copy
            </>
          )}
        </button>
      </div>
      <div className="relative bg-[var(--code-bg)]">
        <div
          className="code-block-content min-w-0 max-w-full overflow-x-auto bg-[var(--code-bg)]"
          style={
            needsCollapse && !codeExpanded
              ? { maxHeight: collapsedMaxHeight, overflowY: "hidden" }
              : undefined
          }
        >
          <SyntaxHighlighter
            language={language}
            style={style}
            customStyle={{
              margin: 0,
              padding: "1rem 1.25rem",
              fontSize: "0.8125rem",
              lineHeight: 1.65,
              border: "none",
              background: "var(--code-bg)",
              /* Single scroll parent: .code-block-content (avoids mobile WebKit indent/scroll bugs) */
              overflowX: "visible",
              overflowY: "visible",
            }}
            codeTagProps={{
              style: {
                fontFamily: "var(--font-mono), ui-monospace, monospace",
                tabSize: 4,
                whiteSpace: "pre",
                wordBreak: "normal",
                overflowWrap: "normal",
              },
            }}
            showLineNumbers={lineCount > 4}
            lineNumberStyle={{
              minWidth: "2.25em",
              paddingRight: "1em",
              opacity: 0.6,
              userSelect: "none",
            }}
            PreTag="div"
            useInlineStyles={true}
          >
            {code}
          </SyntaxHighlighter>
        </div>
        {needsCollapse && !codeExpanded && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-28 flex-col justify-end">
            <div
              className="absolute inset-0"
              style={{
                background:
                  "linear-gradient(to top, var(--code-bg) 0%, color-mix(in srgb, var(--code-bg) 82%, transparent) 42%, transparent 100%)",
              }}
              aria-hidden
            />
            <div className="relative z-10 flex justify-center pb-3 pt-6">
              <button
                type="button"
                onClick={() => setCodeExpanded(true)}
                className="pointer-events-auto cursor-pointer text-xs font-medium text-[var(--accent)] underline-offset-2 transition hover:text-[var(--accent-hover)] hover:underline"
                aria-expanded={false}
              >
                Read more
              </button>
            </div>
          </div>
        )}
      </div>
      {needsCollapse && codeExpanded && (
        <div className="flex justify-center bg-[var(--code-bg)] px-3 pb-3 pt-1">
          <button
            type="button"
            onClick={() => setCodeExpanded(false)}
            className="cursor-pointer text-xs font-medium text-[var(--accent)] underline-offset-2 transition hover:text-[var(--accent-hover)] hover:underline"
            aria-expanded={true}
          >
            Read less
          </button>
        </div>
      )}
    </div>
  );
}
