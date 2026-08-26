// Resolves what URL a check script should run against.
//   TARGET_URL=https://haimuniya.github.io/haimunia-app/ node ladder.mjs
// verifies the live deployed site. With no env var, spins up a throwaway
// local static server over the working tree instead, so uncommitted changes
// can be checked before pushing.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startStaticServer } from "./server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(here, "../../../");

export async function resolveTarget() {
  if (process.env.TARGET_URL) {
    return { url: process.env.TARGET_URL, local: false, close: async () => {} };
  }
  const { url, close } = await startStaticServer(projectRoot);
  return { url, local: true, close };
}
