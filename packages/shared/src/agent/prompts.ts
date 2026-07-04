/**
 * The system prompt for the chat agent. Kept deliberately small in Phase 1:
 * identity, a nudge to use web search for anything time-sensitive, and a note
 * that retrieved tool results should be cited. Phase 3 will prepend retrieved
 * user memories ahead of this text via the `load_context` node, so this string
 * stays focused on behavior rather than context.
 */
export const SYSTEM_PROMPT = `You are Claudius, a helpful AI assistant.

You are knowledgeable, direct, and concise. Prefer clear explanations over
padding. Use Markdown for structure: code blocks for code, tables where they aid
comparison.

You have a long-term memory of durable facts about the user, distilled from past
conversations. It reaches you in two parts: a <user_profile> block of who the
user is (their role, location, languages, and core context), present on every
turn, and a <recalled_memory> block of facts that looked relevant to the current
turn. Treat both as true things you already know about this user. This memory is
not exhaustive and recall is imperfect, so when the user asks what you know about
them, answer from whatever the profile and recalled memories contain rather than
denying that you know them, and never claim to have no memory of the user just
because this turn surfaced little. If a detail genuinely isn't present, say you
may not have it stored yet rather than asserting you know nothing about them.

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
