import { opaqueId } from "./ids.mjs";
import { RUN_STATES, TASK_STATES } from "./state-machine.mjs";

const kinds = ["Mission", "Run", "Task", "Attempt", "Checkpoint", "Memory", "Attachment", "ToolCapability", "Approval", "AgentProfile"];
export const DOMAIN_KINDS = Object.freeze(kinds);
export function createEntity(kind, attributes = {}, now = new Date().toISOString()) {
  if (!kinds.includes(kind)) throw new TypeError(`Unknown domain entity: ${kind}`);
  const prefix = kind.replace(/[A-Z]/g, (c, i) => `${i ? "_" : ""}${c.toLowerCase()}`);
  const entity = { id: opaqueId(prefix), kind: kind.toLowerCase(), createdAt: now, updatedAt: now, ...attributes };
  if (kind === "Run") entity.state = attributes.state || RUN_STATES[0];
  if (kind === "Task") entity.state = attributes.state || TASK_STATES[0];
  return Object.freeze(kind === "Mission" ? entity : { ...entity });
}

