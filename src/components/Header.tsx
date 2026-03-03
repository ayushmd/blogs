import Link from "next/link";
import { ThemeToggle } from "./ThemeToggle";

export function Header() {
  return (
    <header className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--background)]/90 backdrop-blur">
      <div className="mx-auto flex h-14 min-w-0 max-w-3xl items-center justify-between px-3">
        <Link
          href="/"
          className="text-xl font-semibold text-[var(--foreground)] hover:text-[var(--accent)]"
        >
          ayush.md
        </Link>
        <ThemeToggle />
      </div>
    </header>
  );
}
