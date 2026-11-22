/**
 * hosts/cloudflare/worker.ts — the Worker's `main` (src/support-worker.ts in wrangler.toml), with
 * agent.ts beside it as src/support-agent.ts (so the import is './support-agent'). The handler and
 * the Durable Object class, and nothing else: workerd refuses to start a main module that also
 * exports a constant.
 */
import { supportWorker } from './agent';

export { SupportTask } from './agent';
export default supportWorker();
