import { TRANSLATE_LANG_CODES, type Role } from "@claudius/shared";

/**
 * The `/help` command: a client-only cheat sheet for everything the chat surface
 * can do. Claudius has accumulated a set of *typed* shortcuts (`!bang`, `?word`,
 * `&lang`, `$SYMBOL`) and UI toggles that are discoverable only if you already know they
 * exist, so this is the one place that names them all.
 *
 * Two deliberate choices:
 *
 *   - It is intercepted in the browser and never reaches /api/chat. Help text is
 *     static, so a model call, a tier charge, a usage_event, and a checkpoint
 *     write would all be waste. The message is also never persisted, which keeps
 *     help out of the thread the model reads on the next turn.
 *   - It is role-aware. Quote mode, URL reading, uploads, research, and
 *     incognito are member/admin features; showing a guest a shortcut that the
 *     server will refuse is worse than not mentioning it.
 *
 * This module is pure (text in, text out) so it is testable without a browser.
 */

/** A bang as the client renders it: the merged table, flattened for display. */
export interface BangView {
  token: string;
  /** Host of the resolved template, e.g. `github.com` — what the user cares about. */
  host: string;
}

/**
 * True when the input is the help command. Accepts `/help` and `/?`, with any
 * surrounding whitespace and any casing. Deliberately exact: `/help me write a
 * function` is a real question about the word "help" and must reach the model.
 */
export function isHelpCommand(raw: string): boolean {
  return /^\/(help|\?)$/i.test(raw.trim());
}

/** Reduce a bang URL template to its host, for a compact display list. */
export function bangHost(urlTemplate: string): string {
  try {
    return new URL(urlTemplate).hostname.replace(/^www\./, "");
  } catch {
    return urlTemplate;
  }
}

interface HelpOptions {
  role: Role;
  /** The merged bang table (custom over built-in), already flattened. */
  bangs: BangView[];
  /** Whether the role gets any image service at all (Phase 12 tier policy). */
  canAttachImages: boolean;
}

/**
 * Build the help text as markdown. The transcript already renders markdown, so
 * the returned string needs no special renderer.
 */
export function buildHelpText({
  role,
  bangs,
  canAttachImages,
}: HelpOptions): string {
  const isMember = role !== "guest";
  const sections: string[] = [];

  sections.push(
    "## Claudius quick reference\n\nJust type a question to chat normally. These shortcuts take a faster path: `!bang` and a bare URL skip the model entirely, and `?` and `&` run one quick lookup that's free the second time anyone asks for the same thing.",
  );

  const shortcuts: string[] = [
    "**`?word`** — dictionary. `?ephemeral` returns the definition, pronunciation, and examples. Type `??` if you actually want a literal question mark first.",
    `**\`&lang\`** — translate. \`&it good morning\` gives the Italian plus register and usage notes; \`& buon giorno\` with a space translates into English. Add a source to be explicit: \`&es>it buenos dias\`. Languages: ${TRANSLATE_LANG_CODES.map((c) => `\`${c}\``).join(", ")}.`,
    "**`!bang`** — jump straight to a site's own search. `!gh langgraph` opens GitHub results in a new tab. Works leading or trailing: `langgraph !gh`.",
    "**a bare URL** — paste `https://example.com` on its own and Claudius just opens it.",
  ];
  if (isMember) {
    shortcuts.push(
      "**`$SYMBOL`** — stock, index, commodity, and crypto quotes. `$MDB`, `$gold`, `$btc`, `$sp500`. Index requests are quoted through their tracking ETF, and the answer says so. `$$` escapes.",
    );
  }
  sections.push(`### Typed shortcuts\n\n${bullets(shortcuts)}`);

  if (bangs.length > 0) {
    sections.push(
      `### Available bangs\n\n${bangs
        .map((b) => `\`!${b.token}\` ${b.host}`)
        .join(" · ")}`,
    );
  }

  const buttons: string[] = [
    "**Model picker** (top left) — switch models mid-conversation. Your choice is remembered for new chats.",
  ];
  if (isMember) {
    buttons.push(
      "**Research** (telescope, in the composer) — runs a long, multi-source, cited investigation in the background. Keep using the app while it works; the report lands in the thread and can be downloaded or refined with a follow-up instruction.",
      "**Attach** (paperclip) — upload PDFs, text, and Office files. Once processed, Claudius searches inside them to answer, and cites the file and page.",
      "**New incognito chat** (sidebar) — a thread that runs without your saved memories or custom instructions, and adds nothing to memory. The transcript is still saved until you delete it.",
    );
  }
  if (canAttachImages) {
    buttons.push(
      "**Images** — attach a picture and ask about it. Images last for a single turn, and only vision-capable models accept them.",
    );
  }
  sections.push(`### Buttons and toggles\n\n${bullets(buttons)}`);

  const abilities: string[] = [
    "**Web search** — searched automatically when a question needs current information, with source links.",
  ];
  if (isMember) {
    abilities.push(
      "**Reading pages** — give it a link and ask a question about it; it fetches the page (or a GitHub repo) and reads it.",
      "**Your documents** — anything attached to the conversation is searchable by meaning, not just keywords.",
      "**Memory** — durable facts about your preferences and projects carry across conversations. A chip on the reply shows when memory was used.",
    );
  }
  sections.push(`### What it does on its own\n\n${bullets(abilities)}`);

  const admin: string[] = [];
  if (role === "admin") {
    admin.push(
      "**`/admin`** — model catalog and pricing, tier limits, allowlist and user management, search and cache settings, custom bangs, and aggregate usage. Custom bangs you add there show up in this list.",
    );
    sections.push(`### Admin\n\n${bullets(admin)}`);
  }

  if (!isMember) {
    sections.push(
      "### Guest access\n\nYou're on the guest tier: one model, a small daily message cap, and no uploads, research, or memory. Sign in with an allowlisted account for the full set.",
    );
  }

  sections.push("_Type `/help` any time to see this again._");

  return sections.join("\n\n");
}

function bullets(items: string[]): string {
  return items.map((i) => `- ${i}`).join("\n");
}
