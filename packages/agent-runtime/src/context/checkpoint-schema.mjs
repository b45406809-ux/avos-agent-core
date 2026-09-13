export const CHECKPOINT_FIELDS = ["missionRef", "planVersion", "activeTask", "completionCriteria", "completedSteps", "hypotheses", "decisions", "filesInspected", "filesChanged", "commands", "tests", "unresolvedErrors", "dependencyHandoffs", "gitState", "nextActions", "factsRequiringRevalidation", "omittedSourceRefs"];
export function validateCheckpoint(value, missionRef) {
  const errors = CHECKPOINT_FIELDS.filter(k => !(k in (value || {}))).map(k => `missing ${k}`);
  if (missionRef && value?.missionRef !== missionRef) errors.push("missionRef invariant changed");
  return { valid: errors.length === 0, errors };
}
export function emergencyCheckpoint(state) {
  const base = Object.fromEntries(CHECKPOINT_FIELDS.map(k => [k, []]));
  return { ...base, ...state, commands: structuredClone(state.telemetry?.commands || state.commands || []), tests: structuredClone(state.telemetry?.tests || state.tests || []), filesChanged: structuredClone(state.telemetry?.filesChanged || state.filesChanged || []), gitState: structuredClone(state.telemetry?.gitState || state.gitState || {}) };
}

