import type{Env,Owner}from"../types";
import{json}from"../types";
import{readJson,ApiError}from"../middleware/errors";
import{providerDefinitions,providerStatuses,removeProvider,storeProvider,type Provider}from"../services/credentials";
import{readiness}from"../services/setup";

export async function settingsRoutes(req:Request,env:Env,o:Owner){
 const p=new URL(req.url).pathname;
 if(p==="/api/settings/providers"&&req.method==="GET")return json({providers:await providerStatuses(env),supported:Object.keys(providerDefinitions)});
 const match=p.match(/^\/api\/settings\/providers\/([^/]+)$/),provider=match?.[1]as Provider;
 if(match&&!Object.hasOwn(providerDefinitions,provider))throw new ApiError(404,"provider_unknown","This provider is not supported.");
 if(match&&req.method==="PUT"){
  const ip=req.headers.get("cf-connecting-ip")||"unknown",bucket=`provider:${o.user_id}:${ip}`,n=Date.now(),rate=await env.DB.prepare("SELECT * FROM setup_rate_limits WHERE key=?").bind(bucket).first<any>();
  if(rate&&rate.window_started_at>n-60000&&rate.attempts>=5)throw new ApiError(429,"rate_limited","Wait before submitting another credential.");
  await env.DB.prepare("INSERT INTO setup_rate_limits(key,window_started_at,attempts) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET window_started_at=CASE WHEN window_started_at<? THEN excluded.window_started_at ELSE window_started_at END,attempts=CASE WHEN window_started_at<? THEN 1 ELSE attempts+1 END").bind(bucket,n,n-60000,n-60000).run();
  const body=await readJson(req)as any,keyInput=String(body.keys||"");
  try{return json(await storeProvider(env,provider,keyInput),201)}finally{body.keys=undefined}
 }
 if(match&&req.method==="DELETE")return json(await removeProvider(env,provider));
 if(p==="/api/settings/routing"&&req.method==="PUT"){const b=await readJson(req)as any,n=Date.now();await env.DB.prepare("INSERT INTO model_routing(id,primary_planner,fallback_planner,primary_worker,fallback_worker,compaction_model,maximum_tokens,maximum_estimated_cost,degraded_policy,updated_at) VALUES(1,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET primary_planner=excluded.primary_planner,fallback_planner=excluded.fallback_planner,primary_worker=excluded.primary_worker,fallback_worker=excluded.fallback_worker,compaction_model=excluded.compaction_model,maximum_tokens=excluded.maximum_tokens,maximum_estimated_cost=excluded.maximum_estimated_cost,degraded_policy=excluded.degraded_policy,updated_at=excluded.updated_at").bind(b.primaryPlanner,b.fallbackPlanner,b.primaryWorker,b.fallbackWorker,b.compactionModel,Math.max(1,Number(b.maximumTokens||100000)),Math.max(0,Number(b.maximumEstimatedCost||0)),b.degradedPolicy||"disabled",n).run();return json(await readiness(env))}
 if(p==="/api/settings/storage"&&req.method==="GET"){const d=new Date().toISOString().slice(0,10),kv=await env.DB.prepare("SELECT value FROM usage_counters WHERE key=?").bind(`kv_writes:${d}`).first<any>();return json({freeOnly:env.FREE_ONLY_MODE!=="false",stores:{metadata:"D1",documents:"Workers KV"},estimated:{kvWritesToday:Number(kv?.value||0),kvWriteLimit:Number(env.MAX_KV_WRITES_PER_DAY||800)},retention:{eventsDays:30,temporaryDocumentsDays:Number(env.TEMP_DOCUMENT_DAYS||10),githubArtifactsDays:"3–7",checkpointsPerRun:5},usageAuthority:"Cloudflare"})}
 if(p==="/api/settings/storage/cleanup"&&req.method==="POST"){const n=Date.now(),expired=await env.DB.prepare("SELECT id,kv_key FROM documents WHERE owner_id=? AND expires_at IS NOT NULL AND expires_at<?").bind(o.user_id,n).all<any>();await Promise.all(expired.results.map(x=>env.DOCUMENTS.delete(x.kv_key)));await env.DB.batch([env.DB.prepare("DELETE FROM documents WHERE owner_id=? AND expires_at IS NOT NULL AND expires_at<?").bind(o.user_id,n),env.DB.prepare("DELETE FROM events WHERE timestamp<? AND run_id IN (SELECT id FROM runs WHERE user_id=?)").bind(n-30*86400000,o.user_id),env.DB.prepare("DELETE FROM runs WHERE user_id=? AND finished_at IS NOT NULL AND finished_at<? AND status IN ('completed','failed','cancelled')").bind(o.user_id,n-30*86400000,o.user_id)]);return json({deletedDocuments:expired.results.length,eventsBefore:n-30*86400000})}
 return null;
}
