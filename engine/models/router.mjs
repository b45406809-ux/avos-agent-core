import { HIGH_CAPABILITY_OPERATIONS } from "./registry.mjs";
export function routeModel(registry, operation, requirements = {}, { degraded = false } = {}) {
  const high = HIGH_CAPABILITY_OPERATIONS.has(operation) || requirements.highCapability;
  const candidates = registry.list().filter(m => (!high || ["high","frontier"].includes(m.reasoningTier)) && (!requirements.tools || m.toolCalling) && (!requirements.structured || m.structuredOutput) && (!requirements.multimodal || m.multimodal));
  if (!candidates.length) { if (!degraded) throw new Error(`No qualified model configured for ${operation}; explicitly enable degraded mode to continue`); const fallback=registry.list()[0]; if(!fallback) throw new Error("No models configured"); return {model:fallback,reason:"explicit degraded mode"}; }
  candidates.sort((a,b)=>(a.cost||0)-(b.cost||0) || (a.latencyClass||9)-(b.latencyClass||9));
  return { model:candidates[0], reason:`capabilities matched ${operation}` };
}

