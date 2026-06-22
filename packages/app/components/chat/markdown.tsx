"use client";

import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./code-block";

/**
 * Renders assistant (and user) message text as GitHub-flavored Markdown. Block
 * code is delegated to CodeBlock (highlight + copy); everything else gets quiet,
 * readable defaults tuned for the ~760px reading column. Memoized because a
 * streaming message re-renders on every token and re-parsing is the hot path.
 */
const components: Components = {
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className ?? "");
    const text = String(children).replace(/\n$/, "");
    // No language class and single-line => inline code.
    if (!match && !text.includes("\n")) {
      return (
        <code
          className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]"
          {...props}
        >
          {children}
        </code>
      );
    }
    return <CodeBlock language={match?.[1] ?? ""} value={text} />;
  },
  a({ children, ...props }) {
    return (
      <a
        className="text-primary underline underline-offset-2 hover:opacity-80"
        target="_blank"
        rel="noreferrer"
        {...props}
      >
        {children}
      </a>
    );
  },
  ul({ children }) {
    return <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>;
  },
  p({ children }) {
    return <p className="my-2 leading-7 first:mt-0 last:mb-0">{children}</p>;
  },
  h1({ children }) {
    return <h1 className="mt-4 mb-2 text-2xl font-semibold">{children}</h1>;
  },
  h2({ children }) {
    return <h2 className="mt-4 mb-2 text-xl font-semibold">{children}</h2>;
  },
  h3({ children }) {
    return <h3 className="mt-3 mb-1.5 text-lg font-semibold">{children}</h3>;
  },
  blockquote({ children }) {
    return (
      <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground italic">
        {children}
      </blockquote>
    );
  },
  table({ children }) {
    return (
      <div className="my-3 overflow-x-auto">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    );
  },
  th({ children }) {
    return (
      <th className="border border-border bg-muted px-2 py-1 text-left font-medium">
        {children}
      </th>
    );
  },
  td({ children }) {
    return <td className="border border-border px-2 py-1">{children}</td>;
  },
};

function MarkdownImpl({ children }: { children: string }): React.ReactNode {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {children}
    </ReactMarkdown>
  );
}

export const Markdown = memo(MarkdownImpl);
