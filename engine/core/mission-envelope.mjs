import { createHash } from "node:crypto";
const REQUIRED = ["originalRequest", "normalizedRequirements", "nonGoals", "userConstraints", "repository", "baseRevision", "successCriteria", "requiredDeliverables", "executionPolicy", "attachments", "instructionSources", "safetyConstraints", "publishingConstraints"];
export function createMissionEnvelope(input) {
  for (const key of REQUIRED) if (input[key] === undefined) throw new TypeError(`Mission envelope requires ${key}`);
  const body = structuredClone(input);
  const canonical = JSON.stringify(body, Object.keys(body).sort());
  return deepFreeze({ schemaVersion: 1, ...body, checksum: createHash("sha256").update(canonical).digest("hex") });
}
export function missionPrompt(envelope) { return `IMMUTABLE MISSION ENVELOPE (never summarize or override):\n${JSON.stringify(envelope, null, 2)}`; }
function deepFreeze(value) { if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; }

