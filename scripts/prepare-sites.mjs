import { copyFile, mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";

const dist = new URL("../dist/", import.meta.url);
const client = new URL("../dist/client/", import.meta.url);
const server = new URL("../dist/server/", import.meta.url);
const vendor = new URL("../dist/client/vendor/", import.meta.url);

await mkdir(client, { recursive: true });
for (const entry of await readdir(dist, { withFileTypes: true })) {
  if (entry.name === "client" || entry.name === "server") continue;
  await rename(join(dist.pathname, entry.name), join(client.pathname, entry.name));
}

await mkdir(server, { recursive: true });
await mkdir(vendor, { recursive: true });
await Promise.all([
  copyFile(new URL("../src/worker.js", import.meta.url), new URL("index.js", server)),
  copyFile(new URL("../src/domain.mjs", import.meta.url), new URL("domain.mjs", server)),
  copyFile(new URL("../node_modules/pdfjs-dist/build/pdf.min.mjs", import.meta.url), new URL("pdf.mjs", vendor)),
  copyFile(new URL("../node_modules/pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url), new URL("pdf.worker.mjs", vendor)),
]);
