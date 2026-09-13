const enc = new TextEncoder();
export const randomId = (prefix:string) => `${prefix}_${crypto.randomUUID().replaceAll("-","")}`;
export async function sha256(value:string|ArrayBuffer){const data=typeof value==="string"?enc.encode(value):value;return [...new Uint8Array(await crypto.subtle.digest("SHA-256",data))].map(x=>x.toString(16).padStart(2,"0")).join("");}
export function sanitize(value:unknown, secrets:string[]=[]):unknown {
  const sensitive=/token|secret|authorization|password|credential|api.?key/i;
  if(Array.isArray(value)) return value.map(v=>sanitize(v,secrets));
  if(value&&typeof value==="object") return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,sensitive.test(k)?"[REDACTED]":sanitize(v,secrets)]));
  if(typeof value==="string") return secrets.filter(Boolean).reduce((v,s)=>v.split(s).join("[REDACTED]"),value).replace(/Bearer\s+[A-Za-z0-9._~-]+/gi,"Bearer [REDACTED]");
  return value;
}
export function safeFilename(name:string){return name.normalize("NFKC").replace(/[^a-zA-Z0-9._ -]/g,"_").replace(/^\.+/,"").slice(0,255)||"attachment";}
export async function validateGithubClaims(token:string, expected:{audience:string;repository:string;owner:string;workflowRef:string;githubRunId:string;environment?:string}, fetcher:typeof fetch=fetch){
  const parts=token.split("."); if(parts.length!==3) throw new Error("Malformed OIDC token");
  const decode=(x:string)=>JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(x.replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(x.length/4)*4,"=")),c=>c.charCodeAt(0))));
  const header=decode(parts[0]), claims=decode(parts[1]);
  if(claims.iss!=="https://token.actions.githubusercontent.com"||claims.aud!==expected.audience||claims.exp*1000<=Date.now()) throw new Error("Invalid OIDC issuer, audience, or expiry");
  if(claims.repository!==expected.repository||claims.repository_owner!==expected.owner||claims.job_workflow_ref!==expected.workflowRef||String(claims.run_id)!==expected.githubRunId) throw new Error("OIDC workflow identity mismatch");
  if(expected.environment&&claims.environment!==expected.environment) throw new Error("OIDC environment mismatch");
  const jwks=await (await fetcher("https://token.actions.githubusercontent.com/.well-known/jwks")).json() as {keys:JsonWebKey[]}; const jwk=jwks.keys.find((k:any)=>k.kid===header.kid); if(!jwk) throw new Error("Unknown OIDC signing key");
  const key=await crypto.subtle.importKey("jwk",jwk,{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["verify"]); const sig=Uint8Array.from(atob(parts[2].replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(parts[2].length/4)*4,"=")),c=>c.charCodeAt(0));
  if(!await crypto.subtle.verify("RSASSA-PKCS1-v1_5",key,sig,enc.encode(`${parts[0]}.${parts[1]}`))) throw new Error("Invalid OIDC signature"); return claims;
}
