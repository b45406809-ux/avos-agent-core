export function validatePlan(plan, { maxTasks = 100 } = {}) {
  const errors=[]; const tasks=plan?.tasks||[]; if(!tasks.length) errors.push("plan has no tasks"); if(tasks.length>maxTasks) errors.push("plan exceeds task limit");
  const ids=new Set(); for(const t of tasks){ if(!t.id||ids.has(t.id)) errors.push(`duplicate or missing id: ${t.id}`); ids.add(t.id); for(const k of ["objective","acceptanceCriteria","verificationCommands","expectedFiles"]) if(!t[k]?.length) errors.push(`${t.id}: missing ${k}`); }
  for(const t of tasks) for(const d of t.dependencies||[]) if(!ids.has(d)||d===t.id) errors.push(`${t.id}: invalid dependency ${d}`);
  const visiting=new Set(),done=new Set(); const byId=new Map(tasks.map(t=>[t.id,t])); function visit(id){if(visiting.has(id)){errors.push(`cycle at ${id}`);return;}if(done.has(id))return;visiting.add(id);for(const d of byId.get(id)?.dependencies||[])visit(d);visiting.delete(id);done.add(id);} ids.forEach(visit);
  for(let i=0;i<tasks.length;i++)for(let j=i+1;j<tasks.length;j++){const a=tasks[i],b=tasks[j];const ordered=(a.dependencies||[]).includes(b.id)||(b.dependencies||[]).includes(a.id);if(!ordered&&a.expectedFiles?.some(f=>b.expectedFiles?.includes(f)))errors.push(`${a.id} and ${b.id}: conflicting parallel file ownership`);}
  return {valid:!errors.length,errors};
}

