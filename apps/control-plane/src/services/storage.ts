import type{Env}from"../types";import{sha256}from"../security";
export async function putVerified(env:Env,key:string,data:ArrayBuffer|ReadableStream,metadata:Record<string,string>={}){const bytes=data instanceof ArrayBuffer?data:await new Response(data).arrayBuffer(),checksum=await sha256(bytes);await env.OBJECTS.put(key,bytes,{customMetadata:{...metadata,checksum}});return{key,checksum,size:bytes.byteLength}}
export async function getObject(env:Env,key:string){return env.OBJECTS.get(key)}
