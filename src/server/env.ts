import * as cf from "cloudflare:workers";
import type { WebsiteEnv } from "../../alchemy.run.ts";
// Defer binding access: TanStack dev evaluates route modules outside a Worker request.
export const env = new Proxy({} as WebsiteEnv, {
  get(_target, property) { return cf.env[property as keyof typeof cf.env]; },
});
