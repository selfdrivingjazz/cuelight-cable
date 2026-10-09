// Refreshes vendor/cuelight-openapi.yaml from a Cuelight checkout or server,
// then regenerates src/cuelight-api.d.ts.
//
//   pnpm sync:cuelight-api                         # $CUELIGHT_URL/api/v1/openapi.yaml
//   pnpm sync:cuelight-api ../cable/api/openapi.yaml
//   pnpm sync:cuelight-api https://cuelight.example:8454/api/v1/openapi.yaml
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const target = resolve(root, "vendor/cuelight-openapi.yaml");
const fromEnv = process.env.CUELIGHT_URL ? `${process.env.CUELIGHT_URL.replace(/\/+$/, "")}/api/v1/openapi.yaml` : undefined;
const source = process.argv[2] ?? fromEnv;
if (!source) {
  console.error("usage: pnpm sync:cuelight-api [path-or-url] (or set CUELIGHT_URL)");
  process.exit(2);
}

let spec: string;
if (/^https?:\/\//.test(source)) {
  const response = await fetch(source);
  if (!response.ok) throw new Error(`${source} returned HTTP ${response.status}`);
  spec = await response.text();
} else {
  spec = readFileSync(resolve(process.cwd(), source), "utf8");
}
if (!/^openapi:\s*3\./m.test(spec)) throw new Error(`${source} is not an OpenAPI 3 document`);
writeFileSync(target, spec);
console.log(`vendored ${source} → ${target}`);
execFileSync("pnpm", ["run", "generate:cuelight-api"], { cwd: root, stdio: "inherit" });
