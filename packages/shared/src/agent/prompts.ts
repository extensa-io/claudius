/**
 * The system prompt for the chat agent. Identity, a grounding principle (live
 * sources beat frozen training), web-search and document-citation behavior. The
 * per-turn context — the current date, retrieved user memories, and any attached
 * documents — is assembled in the `agent` node and prepended to this text, so
 * this string stays focused on behavior rather than on the moment.
 *
 * The grounding paragraph refers to "the current date and time above": the
 * `agent` node prepends `currentDateLine(...)` as the first section, so that
 * reference resolves at runtime.
 */
export const SYSTEM_PROMPT = `You are Claudius, a helpful AI assistant.

You are knowledgeable, direct, and concise. Prefer clear explanations over
padding. Use Markdown for structure: code blocks for code, tables where they aid
comparison.

Your training data is a frozen snapshot, not the present. You are grounded in the
current moment by live sources instead: the current date and time above, your
long-term memory of the user, any documents attached to the conversation, and
your web_search tool. Trust these live sources over your training for anything
that can change — the date, recent events, prices, releases, versions, current
affairs. Never state such a fact from training as though it were current; if no
live source covers it and it matters to the answer, use web_search or say you
don't have it rather than guessing. This applies to the user too: your memory
reaches you as a <user_profile> block of who the user is (present every turn) and
a <recalled_memory> block of facts relevant to this turn. Treat both as things
you already know about this user — recall is imperfect, so when asked what you
know about them, answer from whatever those blocks contain rather than denying
knowledge, and if a detail isn't present say it may not be stored yet rather than
claiming you know nothing about them. Separately, the user may give you explicit
instructions of their own — a preferred name and a <user_instructions> block of
how they want you to respond. That is authored by the user, not inferred, so
follow it; when it conflicts with a recalled memory, the instructions win.

You have a web_search tool. Use it when a question depends on current events,
recent releases, prices, or any fact that may have changed since your training
data. When you answer from search results, mention the sources you relied on. Do
not invent URLs or citations.

When the user has attached documents to the conversation, you also have a
retrieve_documents tool that searches those documents. Use it whenever the
question could be answered from the attached material. When you answer from
retrieved excerpts, cite the document name and its location (for example the page
number) so the user can verify the source. Only cite documents and locations
that appear in the retrieved results; never invent them.`;

/**
 * The current-moment line prepended to the system prompt as its FIRST section,
 * every turn. The model has no clock and no reliable current date of its own —
 * left ungrounded it answers "what day is it?" from a date baked into its
 * training data, stated with false confidence. The server knows the real date,
 * so we simply tell it. UTC and explicitly labeled, because the user may be in
 * any timezone and the server can't know theirs; the model can caveat local time
 * if asked. Kept pure (takes `now`) so it's deterministic and testable; the
 * `agent` node passes `new Date()`. Never checkpointed, so it can't go stale.
 */
export function currentDateLine(now: Date): string {
  // e.g. "Monday, 6 July 2026, 14:03 UTC"
  const formatted = now.toLocaleString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
  return `The current date and time is ${formatted} UTC. Trust this over any date or time from your training data.`;
}

/**
 * Appended to the system prompt for a turn when the conversation has attached,
 * embedded documents. Without this, the model has no signal that files are
 * present — it only sees the tool definition — so it tends to ask the user to
 * upload a document that is already attached instead of calling the tool. Naming
 * the files explicitly is what makes the model reliably reach for retrieval.
 */
export function attachedDocumentsNote(filenames: string[]): string {
  const list = filenames.length > 0 ? filenames.join(", ") : "one or more files";
  return `The user has already attached the following document(s) to THIS conversation: ${list}. They are available to you right now through the retrieve_documents tool. When the user's question may relate to them, call retrieve_documents to read the relevant passages before answering, and cite the document name and location. Never claim that no document is attached, and never ask the user to upload a document that is already listed here.`;
}

/**
 * The user-AUTHORED settings block, prepended to the system prompt after the
 * base identity and BEFORE the memory block. This is the layer the user typed
 * themselves — a preferred name and freeform instructions — as opposed to the
 * memory blocks the system inferred from past conversations. It therefore
 * outranks memory: the closing line tells the model that when a recalled memory
 * contradicts these instructions, the instructions win. Precedence is
 * prompt-level only; it cannot loosen a tier, unlock a model, or reach another
 * user's data, since those are enforced in code, not in this text.
 *
 * Kept pure and returning `null` when the user has authored nothing, so the
 * agent node omits the section entirely rather than injecting an empty shell.
 */
export function userSettingsNote(params: {
  preferredName: string | null;
  instructions: string | null;
}): string | null {
  const preferredName = params.preferredName?.trim() || null;
  const instructions = params.instructions?.trim() || null;
  if (!preferredName && !instructions) return null;

  const sections: string[] = [
    "The user has set the following personal instructions for you. Unlike your memory, which you inferred from past conversations, this is what the user has explicitly told you about themselves and how they want you to respond. Follow it. When it conflicts with a recalled memory, these instructions take precedence.",
  ];

  if (preferredName) {
    sections.push(`The user prefers to be called ${preferredName}.`);
  }

  if (instructions) {
    sections.push(`<user_instructions>\n${instructions}\n</user_instructions>`);
  }

  return sections.join("\n\n");
}

interface NoteMemory {
  content: string;
  category: string;
}

/**
 * The delimited memory section prepended to the system prompt when
 * `load_context` assembled memories for this turn. Built fresh each turn and
 * never checkpointed, so it can't accumulate across the thread.
 *
 * Phase 6 splits it into two blocks. `<user_profile>` is the always-on resident
 * identity block (role, location, languages, core context): stable background
 * that should quietly shape tone and framing on every turn, whether or not the
 * user asked about themselves. `<recalled_memory>` is what this specific turn
 * retrieved, task-relevant and use-if-relevant. The instruction stays soft: use
 * what fits, ignore the rest, and don't announce the mechanism — the "used N
 * memories" chip is where recall is surfaced to the user, not the prose.
 */
export function memoriesNote(params: {
  profile: NoteMemory[];
  retrieved: NoteMemory[];
}): string {
  const { profile, retrieved } = params;
  const sections: string[] = [
    "Here is what you know about this user from past conversations. Use anything relevant to personalize your answer; ignore anything that isn't. Do not mention that you are drawing on stored memories unless the user asks.",
  ];

  if (profile.length > 0) {
    const lines = profile
      .map((m) => `- (${m.category}) ${m.content}`)
      .join("\n");
    sections.push(
      `This is who the user is — durable background that holds across every conversation. Let it shape your tone and framing even when the current message isn't about them.

<user_profile>
${lines}
</user_profile>`,
    );
  }

  if (retrieved.length > 0) {
    const lines = retrieved
      .map((m) => `- (${m.category}) ${m.content}`)
      .join("\n");
    sections.push(
      `These memories looked relevant to the current turn specifically.

<recalled_memory>
${lines}
</recalled_memory>`,
    );
  }

  return sections.join("\n\n");
}
