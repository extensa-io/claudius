// The Auth.js MongoDB adapter needs a Promise<MongoClient>. We reuse the single
// client created in @claudius/shared rather than opening a second one, so the
// adapter and the app share one connection pool.
export { clientPromise } from "@claudius/shared";
