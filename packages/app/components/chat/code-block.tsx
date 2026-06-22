"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { cn } from "@/lib/utils";

/**
 * A fenced code block with a language label and a copy button. Syntax
 * highlighting uses Prism via react-syntax-highlighter (design.md). Inline code
 * is handled separately in the markdown renderer; this is for block code only.
 */
export function CodeBlock({
  language,
  value,
}: {
  language: string;
  value: string;
}): React.ReactNode {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="my-3 overflow-hidden rounded-lg border border-border bg-[#282c34]">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5">
        <span className="font-mono text-xs text-white/60">
          {language || "text"}
        </span>
        <button
          type="button"
          onClick={copy}
          className="flex items-center gap-1 text-xs text-white/60 transition-colors hover:text-white"
          aria-label="Copy code"
        >
          {copied ? (
            <Check className="size-3.5" />
          ) : (
            <Copy className="size-3.5" />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <SyntaxHighlighter
        language={language || "text"}
        style={oneDark}
        customStyle={{
          margin: 0,
          background: "transparent",
          padding: "0.85rem 1rem",
          fontSize: "0.8125rem",
        }}
        codeTagProps={{ className: cn("font-mono") }}
      >
        {value}
      </SyntaxHighlighter>
    </div>
  );
}
