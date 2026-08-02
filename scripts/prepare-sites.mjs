import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const dist = new URL("../dist/", import.meta.url);
const client = new URL("../dist/client/", import.meta.url);
const server = new URL("../dist/server/", import.meta.url);

await mkdir(client, { recursive: true });
for (const entry of await readdir(dist, { withFileTypes: true })) {
  if (entry.name === "client" || entry.name === "server") continue;
  await rename(join(dist.pathname, entry.name), join(client.pathname, entry.name));
}

await mkdir(server, { recursive: true });
await writeFile(
  new URL("index.js", server),
  `export default {
  async fetch(request, env) {
    if (env?.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Static asset binding unavailable", { status: 500 });
  },
};
`,
);
