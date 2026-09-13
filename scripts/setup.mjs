import { spawn } from "node:child_process";

if (Number(process.versions.node.split(".")[0]) < 20) throw Error("Node.js 20 or newer is required");
const allowed = new Set(["--dry-run", "--resume"]);
const args = process.argv.slice(2);
const unknown = args.filter(argument => !allowed.has(argument));
if (unknown.length) throw Error(`Unknown setup option: ${unknown.join(", ")}`);

console.log(`AVOS setup ${args.includes("--dry-run") ? "dry-run: discovering resources without mutations" : "validates access and idempotently deploys free-only Cloudflare resources"}.`);
const child = spawn(process.execPath, ["scripts/cloudflare-deploy.mjs", ...args], { stdio: "inherit", env: process.env });
child.on("exit", code => {
  if (code) process.exitCode = code;
  else if (!args.includes("--dry-run")) console.log("Deployment complete. Secrets were never printed or stored in deployment metadata.");
});
