import type { Env } from "../types";
import { ApiError } from "../middleware/errors";
import { randomId, sanitize } from "../security";

const encoder=new TextEncoder(),decoder=new TextDecoder();
const b64=(v:Uint8Array)=>btoa(String.fromCharCode(...v));
const bytes=(v:string)=>Uint8Array.from(atob(v),c=>c.charCodeAt(0));
async function kek(env:Env){
  const raw=bytes(env.CREDENTIAL_KEK);
  if(raw.length!==32)throw new ApiError(503,"credential_vault_unavailable","The credential vault is not initialized.");
  return crypto.subtle.importKey("raw",raw,"AES-GCM",false,["encrypt","decrypt"]);
}
export async function seal(env:Env,type:string,value:string){
  const nonce=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv:nonce,additionalData:encoder.encode(type),tagLength:128},await kek(env),encoder.encode(value)));
  return{id:randomId("cred"),credentialType:type,keyVersion:1,nonce:b64(nonce),ciphertext:b64(encrypted),createdAt:Date.now()};
}
export async function open(env:Env,row:any){
  const clear=await crypto.subtle.decrypt({name:"AES-GCM",iv:bytes(row.nonce),additionalData:encoder.encode(row.credential_type),tagLength:128},await kek(env),bytes(row.ciphertext));
  return decoder.decode(clear);
}
export function redact(value:unknown,secrets:string[]=[]){return sanitize(value,secrets)}
