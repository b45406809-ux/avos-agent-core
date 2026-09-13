import path from "node:path";
export function resolveInstructions(sources, filePath) {
  const normalized = path.normalize(filePath).replaceAll("\\", "/");
  return sources.filter(s => s.scope === "global" || s.scope === "." || normalized === s.scope || normalized.startsWith(`${s.scope}/`)).sort((a,b)=>a.precedence-b.precedence);
}

