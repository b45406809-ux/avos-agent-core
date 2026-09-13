import { EventEmitter } from "node:events";
import { ContextManager } from "./context/context-manager.mjs";
import { emergencyCheckpoint, validateCheckpoint } from "./context/checkpoint-schema.mjs";

export class AgentRuntime extends EventEmitter {
  constructor({ mission, modelCapability, execute = async () => ({ summary: "No executor configured" }) }) {
    super(); this.mission = mission; this.execute = execute; this.context = new ContextManager(modelCapability); this.controller = new AbortController(); this.state = { missionRef: mission.checksum, amendments: [], planVersion: 1, approvalState: [], nextActions: [] }; this.cancelled = false;
  }
  async run(packet) { if (this.cancelled) return; this.emit("progress", { summary: "Executing task", taskId: packet.id }); try { const result = await this.execute(packet, { signal: this.controller.signal, permission: request => this.requestPermission(request) }); if (!this.cancelled) this.emit("result", result); return result; } catch (error) { if (this.cancelled) return; this.emit("failure", { message: String(error) }); throw error; } }
  interrupt(guidance) { this.state.amendments.push({ guidance, at: new Date().toISOString() }); this.emit("safe-boundary-required", { guidance }); }
  cancel() { this.cancelled = true; this.controller.abort(new Error("Run cancelled")); this.emit("cancelled", { summary: "Active operations aborted" }); }
  requestPermission(request) { return new Promise(resolve => { const onDecision = decision => { if (decision.requestId === request.id) { this.off("permission-decision", onDecision); resolve(decision); } }; this.on("permission-decision", onDecision); this.emit("permission-request", request); }); }
  checkpoint(repositoryRevision) { const checkpoint = emergencyCheckpoint({ ...this.state, repositoryRevision, activeTask: this.state.activeTask || null, completionCriteria: this.mission.successCriteria || [], completedSteps: [], hypotheses: [], decisions: [], filesInspected: [], filesChanged: [], commands: [], tests: [], unresolvedErrors: [], dependencyHandoffs: [], gitState: {}, nextActions: this.state.nextActions, factsRequiringRevalidation: [], omittedSourceRefs: [] }); const valid = validateCheckpoint(checkpoint, this.mission.checksum); if (!valid.valid) throw new Error(valid.errors.join(", ")); return checkpoint; }
}
export { ContextManager };
