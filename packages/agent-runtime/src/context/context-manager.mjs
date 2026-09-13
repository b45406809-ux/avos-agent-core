import { validateCheckpoint, emergencyCheckpoint } from "./checkpoint-schema.mjs";
export class ContextManager {
  constructor(capability, reserve = capability.safeReservePercent ?? 20) { this.capability = capability; this.reserve = reserve; }
  estimate(value) { return Math.ceil(JSON.stringify(value ?? "").length / 4); }
  allocate(parts) {
    const total = this.capability.contextWindow; const output = Math.min(this.capability.maxOutputTokens, Math.floor(total * this.reserve / 100));
    const available = total - output; const required = this.estimate(parts.mission) + this.estimate(parts.instructions) + this.estimate(parts.task);
    if (required > available) throw new Error(`Immutable context requires ${required} tokens but model has ${available}`);
    const remaining = available - required; const optional = ["memories", "evidence", "tools", "recentTurns"];
    const allocations = { mission: this.estimate(parts.mission), instructions: this.estimate(parts.instructions), task: this.estimate(parts.task), outputReserve: output };
    optional.forEach(k => allocations[k] = Math.min(this.estimate(parts[k]), Math.floor(remaining / optional.length)));
    return { total, allocations };
  }
  async compact(state, summarize) {
    let candidate;
    try { candidate = await summarize(state); } catch { candidate = emergencyCheckpoint(state); }
    const checked = validateCheckpoint(candidate, state.missionRef);
    return checked.valid ? candidate : emergencyCheckpoint(state);
  }
}
