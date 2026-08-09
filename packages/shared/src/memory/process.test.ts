import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation, User } from "../db/schemas";

const updateOne = vi.fn();
const extractCandidates = vi.fn<(...args: unknown[]) => Promise<never[]>>(
  async () => [],
);

vi.mock("../db/client", () => ({
  getDb: vi.fn(async () => ({})),
  getClient: () => Promise.resolve({}),
  DB_NAME: "claudius",
}));
vi.mock("../db/collections", () => ({
  conversationsCol: async () => ({ updateOne }),
}));
vi.mock("../tiers", () => ({
  loadTier: async () => ({ memoryCap: 100 }),
}));
vi.mock("./extract", () => ({
  extractCandidates: (...args: unknown[]) => extractCandidates(...args),
}));
vi.mock("./persist", () => ({
  persistCandidate: vi.fn(),
}));

const { processConversationMemories } = await import("./process");

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    _id: new ObjectId(),
    userId: new ObjectId(),
    title: "A chat",
    modelId: "m",
    createdAt: new Date(),
    updatedAt: new Date(),
    archived: false,
    ...overrides,
  };
}

const user = {
  _id: new ObjectId(),
  role: "member",
  memoryEnabled: true,
} as unknown as User;

const messages = [
  new HumanMessage("I moved to Montreal last year."),
  new AIMessage("Noted."),
];

/**
 * The worker claims extraction jobs straight out of Mongo, so it cannot assume
 * the enqueuer filtered incognito threads out. This is the second of the two
 * guards: whatever reaches the orchestrator, an incognito transcript is never
 * sent to the extraction model.
 */
describe("processConversationMemories on an incognito thread", () => {
  beforeEach(() => {
    updateOne.mockClear();
    extractCandidates.mockClear();
  });

  it("extracts nothing", async () => {
    const summary = await processConversationMemories({
      user,
      conversation: conversation({ incognito: true }),
      messages,
    });
    expect(summary.status).toBe("disabled");
    expect(summary.created).toBe(0);
    expect(extractCandidates).not.toHaveBeenCalled();
  });

  it("leaves the watermark untouched, so no turn is ever marked processed", async () => {
    await processConversationMemories({
      user,
      conversation: conversation({ incognito: true }),
      messages,
    });
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("still extracts from an ordinary thread", async () => {
    await processConversationMemories({
      user,
      conversation: conversation(),
      messages,
    });
    expect(extractCandidates).toHaveBeenCalledTimes(1);
  });
});
