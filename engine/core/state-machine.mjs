export const RUN_STATES = Object.freeze(["queued", "provisioning", "planning", "plan_review", "running", "waiting_for_approval", "compacting", "verifying", "merging", "cancelling", "cancelled", "completed", "failed", "recovery_required"]);
export const TASK_STATES = Object.freeze(["pending", "ready", "running", "blocked", "waiting_for_approval", "verifying", "completed", "failed", "cancelled", "superseded"]);

const runEdges = {
  queued: ["provisioning", "cancelling", "failed"], provisioning: ["planning", "recovery_required", "cancelling", "failed"],
  planning: ["plan_review", "cancelling", "failed"], plan_review: ["planning", "running", "cancelling", "failed"],
  running: ["waiting_for_approval", "compacting", "verifying", "cancelling", "recovery_required", "failed"],
  waiting_for_approval: ["running", "cancelling", "failed"], compacting: ["running", "recovery_required", "cancelling", "failed"],
  verifying: ["running", "merging", "recovery_required", "cancelling", "failed"], merging: ["completed", "recovery_required", "cancelling", "failed"],
  cancelling: ["cancelled", "failed"], cancelled: [], completed: [], failed: ["provisioning", "recovery_required"], recovery_required: ["provisioning", "cancelling", "failed"]
};
const taskEdges = {
  pending: ["ready", "blocked", "cancelled", "superseded"], ready: ["running", "blocked", "cancelled", "superseded"],
  running: ["blocked", "waiting_for_approval", "verifying", "failed", "cancelled", "superseded"], waiting_for_approval: ["running", "cancelled", "failed"],
  verifying: ["running", "completed", "failed", "cancelled"], blocked: ["ready", "cancelled", "superseded"], failed: ["ready", "superseded"],
  completed: [], cancelled: [], superseded: []
};

export function transition(entity, to, { idempotencyKey, now = new Date().toISOString(), emit } = {}) {
  if (!idempotencyKey) throw new TypeError("idempotencyKey is required");
  const edges = entity.kind === "task" ? taskEdges : runEdges;
  if (!edges[to]) throw new TypeError(`Unknown ${entity.kind || "run"} state: ${to}`);
  entity.transitionKeys ||= [];
  if (entity.transitionKeys.includes(idempotencyKey)) return { entity, event: null, replayed: true };
  if (entity.state === to) return { entity, event: null, replayed: true };
  if (!edges[entity.state]?.includes(to)) throw new Error(`Invalid transition: ${entity.state} -> ${to}`);
  const event = { type: `${entity.kind || "run"}.state_changed`, entityId: entity.id, from: entity.state, to, timestamp: now, idempotencyKey };
  entity.state = to; entity.updatedAt = now; entity.transitionKeys.push(idempotencyKey);
  emit?.(event);
  return { entity, event, replayed: false };
}

