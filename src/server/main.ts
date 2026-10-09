import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { configFromEnv } from "./config.ts";
import { CachedCatalog, CuelightClient } from "./cuelight.ts";
import { Store } from "./store.ts";

const config = configFromEnv();
const store = new Store(config.dbPath);
const cuelight = new CuelightClient({ url: config.cuelightUrl, token: config.cuelightToken, caFile: config.cuelightCaFile });
const app = createApp({ store, cuelight, catalog: new CachedCatalog(cuelight), publicUrl: config.publicUrl, distDir: resolve(import.meta.dirname, "../../dist") });

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`Cuelight Cable listening on http://${info.address}:${info.port} (public ${config.publicUrl}, Cuelight ${config.cuelightUrl}, db ${config.dbPath})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    store.close();
    process.exit(0);
  });
}
