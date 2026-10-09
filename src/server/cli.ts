import { dbPathFromEnv } from "./config.ts";
import { importExport } from "./importer.ts";
import { Store } from "./store.ts";

const usage = `usage: pnpm cable import <export-dir>

Imports json_agg exports (cable_deployments.json, cable_channels.json,
cable_blocks.json, cable_program_entries.json) into CABLE_DB_PATH, keeping ids.`;

const [command, dir] = process.argv.slice(2);
if (command !== "import" || !dir) {
  console.error(usage);
  process.exit(2);
}
const dbPath = dbPathFromEnv();
const store = new Store(dbPath);
try {
  const counts = importExport(store, dir);
  console.log(`imported into ${dbPath}: ${counts.deployments} deployments, ${counts.channels} channels, ${counts.blocks} blocks, ${counts.programs} program entries`);
} finally {
  store.close();
}
