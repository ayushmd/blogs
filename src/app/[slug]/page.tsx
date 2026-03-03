import { notFound } from "next/navigation";
import Link from "next/link";
import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getPostBySlug, getAllSlugs } from "@/lib/posts";
import { CodeBlock } from "@/components/CodeBlock";
import { TagChips } from "@/components/TagChips";
import type { Metadata } from "next";

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams() {
  const slugs = getAllSlugs();
  return slugs.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const post = getPostBySlug(slug);
  if (!post) return { title: "Post not found" };
  return {
    title: post.title,
    description: post.description,
    openGraph: {
      title: post.title,
      description: post.description,
    },
  };
}

export default async function BlogPost({ params }: Props) {
  const { slug } = await params;
  const post = getPostBySlug(slug);
  if (!post) notFound();

  return (
    <main className="mx-auto min-w-0 max-w-3xl px-3 py-10">
      <Link
        href="/"
        className="mb-6 inline-block text-sm text-[var(--muted)] hover:text-[var(--foreground)]"
      >
        ← Back to posts
      </Link>
      <article>
        <header className="mb-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <h1 className="text-3xl font-bold tracking-tight text-[var(--foreground)]">
              {post.title}
            </h1>
            {post.github && (
              <a
                href={post.github}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium text-[var(--foreground)] transition hover:border-[var(--muted)] hover:bg-[var(--border)]"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden className="shrink-0">
                  <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                </svg>
                GitHub
              </a>
            )}
          </div>
          <time
            dateTime={post.date}
            className="mt-2 block text-sm text-[var(--muted)]"
          >
            {new Date(post.date).toLocaleDateString("en-US", {
              year: "numeric",
              month: "long",
              day: "numeric",
            })}
          </time>
          <TagChips tags={post.tags} />
        </header>
        <div className="prose prose-base min-w-0 max-w-none">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              pre: ({ children }) => {
                const child = React.Children.only(children);
                const props = React.isValidElement(child)
                  ? (child.props as { className?: string; children?: React.ReactNode })
                  : null;
                if (props?.className?.startsWith("language-")) {
                  const lang = props.className.replace("language-", "").trim();
                  const code = String(props.children ?? "").trim();
                  return <CodeBlock language={lang} code={code} />;
                }
                return <pre>{children}</pre>;
              },
              a: ({ href, children }) => {
                if (!href) return <>{children}</>;
                const isExternal = href.startsWith("http://") || href.startsWith("https://") || href.startsWith("//");
                return (
                  <a
                    href={href}
                    target={isExternal ? "_blank" : undefined}
                    rel={isExternal ? "noopener noreferrer" : undefined}
                    className="text-[var(--accent)] underline hover:text-[var(--accent-hover)]"
                  >
                    {children}
                  </a>
                );
              },
              table: ({ children }) => (
                <div className="table-wrapper">
                  <table>{children}</table>
                </div>
              ),
              img: ({ src, alt }) => {
                if (!src || typeof src !== "string") return null;
                const isProd = process.env.NODE_ENV === "production";
                const resolvedSrc =
                  !isProd && src.startsWith("/blogs/")
                    ? src.slice(6)
                    : src;
                return (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={resolvedSrc}
                    alt={alt ?? ""}
                    className="my-4 max-w-full rounded-lg border border-[var(--border)]"
                  />
                );
              },
              ul: ({ children }) => (
                <ul
                  className="my-4 pl-6"
                  style={{ listStyleType: "disc", listStylePosition: "outside" }}
                >
                  {children}
                </ul>
              ),
              ol: ({ children }) => (
                <ol
                  className="my-4 pl-6"
                  style={{ listStyleType: "decimal", listStylePosition: "outside" }}
                >
                  {children}
                </ol>
              ),
              li: ({ children }) => (
                <li className="mb-1" style={{ display: "list-item" }}>
                  {children}
                </li>
              ),
            }}
          >
            {post.content}
          </ReactMarkdown>
        </div>
      </article>
    </main>
  );
}
