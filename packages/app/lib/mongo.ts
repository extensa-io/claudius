// We reuse the single client created in @claudius/shared rather than opening a
// second one, so the adapter and the app share one connection pool. The adapter
// is given the accessor function, not an already-connecting promise: that keeps
// the connect out of module scope, which is what the adapter's own docs
// recommend to avoid unhandled rejections when a connect fails.
export { getClient } from "@claudius/shared";
