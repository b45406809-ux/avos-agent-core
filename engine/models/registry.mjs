export class ModelRegistry {
  constructor(models = []) { this.models = new Map(models.map(m => [m.id, Object.freeze({ safeReservePercent:20, ...m })])); }
  register(model) { if (!model.id || !model.contextWindow || !model.maxOutputTokens) throw new TypeError("Incomplete model capability"); this.models.set(model.id,Object.freeze({safeReservePercent:20,...model})); }
  list() { return [...this.models.values()]; }
}
export const HIGH_CAPABILITY_OPERATIONS = new Set(["planning","plan_review","conformance_review","conflict_analysis","checkpoint_validation","failure_diagnosis","security_review"]);

