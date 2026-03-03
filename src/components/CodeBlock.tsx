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

export function CodeBlock({ language, code }: CodeBlockProps) {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => setMounted(true), []);

  const style = useMemo(() => {
    if (!mounted) return oneLight;
    return resolvedTheme === "dark" ? oneDark : oneLight;
  }, [mounted, resolvedTheme]);

  const label = languageLabels[language.toLowerCase()] ?? language;

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
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-[var(--muted)] transition hover:bg-[var(--border)] hover:text-[var(--foreground)]"
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
      <div className="code-block-content min-w-0 max-w-full overflow-x-auto bg-[var(--code-bg)]">
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
            overflowX: "auto",
            minWidth: "min-content",
          }}
          codeTagProps={{
            style: {
              fontFamily: "var(--font-mono), ui-monospace, monospace",
              tabSize: 4,
            },
          }}
          showLineNumbers={code.split("\n").length > 4}
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
    </div>
  );
}
