// Public surface of the answer engine (Phase 7). Runtime-agnostic: no Next.js,
// React, or Auth.js dependencies, so the Phase 5 worker could reuse it later.
export { answerSearch } from "./search";
export { braveSearch, BraveSearchError } from "./brave";
export { tavilySearch } from "./tavily";
export {
  SearchResultSchema,
  type SearchResult,
  type SearchSource,
  type SelectionReason,
  type AnswerSearchRequest,
  type AnswerSearchResult,
} from "./types";
