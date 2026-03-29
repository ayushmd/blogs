import fs from "fs";
import path from "path";
import matter from "gray-matter";

const postsDirectory = path.join(process.cwd(), "content/posts");

export interface PostMeta {
  slug: string;
  title: string;
  subtitle?: string;
  date: string;
  description: string;
  tags: string[];
  github?: string;
}

export interface Post extends PostMeta {
  content: string;
}

function parseTags(data: { tags?: unknown }): string[] {
  const raw = data.tags;
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === "string");
  if (typeof raw === "string") return raw.split(",").map((t) => t.trim()).filter(Boolean);
  return [];
}

function parseSubtitle(data: { subtitle?: unknown; subTitle?: unknown }): string | undefined {
  if (typeof data.subtitle === "string") return data.subtitle;
  if (typeof data.subTitle === "string") return data.subTitle;
  return undefined;
}

export function getAllPosts(): PostMeta[] {
  if (!fs.existsSync(postsDirectory)) return [];
  const fileNames = fs.readdirSync(postsDirectory);
  const posts = fileNames
    .filter((name) => name.endsWith(".md"))
    .map((fileName) => {
      const slug = fileName.replace(/\.md$/, "");
      const fullPath = path.join(postsDirectory, fileName);
      const fileContents = fs.readFileSync(fullPath, "utf8");
      const { data } = matter(fileContents);
      return {
        slug,
        title: (data.title as string) ?? slug,
        subtitle: parseSubtitle(data),
        date: (data.date as string) ?? "",
        description: (data.description as string) ?? "",
        tags: parseTags(data),
        github: typeof data.github === "string" ? data.github : undefined,
      };
    })
    .sort((a, b) => {
      const aHasDate = Boolean(a.date);
      const bHasDate = Boolean(b.date);
      if (aHasDate !== bHasDate) return aHasDate ? 1 : -1;
      if (!aHasDate && !bHasDate) return a.title.localeCompare(b.title);
      return b.date.localeCompare(a.date);
    });
  return posts;
}

export function getPostBySlug(slug: string): Post | null {
  const fullPath = path.join(postsDirectory, `${slug}.md`);
  if (!fs.existsSync(fullPath)) return null;
  const fileContents = fs.readFileSync(fullPath, "utf8");
  const { data, content } = matter(fileContents);
  return {
    slug,
    title: (data.title as string) ?? slug,
    subtitle: parseSubtitle(data),
    date: (data.date as string) ?? "",
    description: (data.description as string) ?? "",
    tags: parseTags(data),
    github: typeof data.github === "string" ? data.github : undefined,
    content,
  };
}

export function getAllSlugs(): string[] {
  if (!fs.existsSync(postsDirectory)) return [];
  return fs
    .readdirSync(postsDirectory)
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.replace(/\.md$/, ""));
}
