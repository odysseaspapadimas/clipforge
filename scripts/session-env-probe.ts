// Child of direnv exec: emit only non-secret local port metadata.
import { localEnvIsSafe } from "./session-preflight.ts";
if (!localEnvIsSafe(process.env)) process.exit(2);
console.log(JSON.stringify({ devPort: Number(process.env.CLIPFORGE_DEV_PORT), rendererPort: Number(process.env.CLIPFORGE_RENDERER_PORT) }));
