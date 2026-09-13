import fs from "node:fs"; import path from "node:path"; import { createHash } from "node:crypto";
const FILES = ["AGENTS.md", "CLAUDE.md", ".claude/CLAUDE.md"];
export function loadInstructions(root, { organization = [], user = [], injected = [] } = {}) {
  const revision = gitRevision(root); const sources = [...organization, ...user];
  walk(root, dir => { for (const name of FILES) add(path.join(dir, name)); for (const folder of [".claude/rules", ".avos/rules"]) { const p=path.join(dir,folder); if(fs.existsSync(p)) for(const f of fs.readdirSync(p).sort()) if(f.endsWith(".md")) add(path.join(p,f)); } });
  return [...sources, ...injected].map((s, i) => typeof s === "string" ? record(s, "global", 10 + i, revision, "injected") : s);
  function add(file) { if(fs.existsSync(file)) sources.push(record(fs.readFileSync(file,"utf8"), path.relative(root,path.dirname(file))||".", precedence(file,root), revision, path.relative(root,file))); }
}
function record(content, scope, precedence, revision, sourcePath) { return { content, scope, precedence, revision, sourcePath, checksum:createHash("sha256").update(content).digest("hex"), untrusted:true }; }
function precedence(file,root){ return 100 + path.relative(root,file).split(path.sep).length; }
function walk(root,cb){ for(const dirent of fs.readdirSync(root,{withFileTypes:true})){ if([".git","node_modules",".worktrees"].includes(dirent.name)) continue; if(dirent.isDirectory()) walk(path.join(root,dirent.name),cb); } cb(root); }
function gitRevision(root){ try{return fs.readFileSync(path.join(root,".git/HEAD"),"utf8").trim();}catch{return "unknown";} }

