import type{Env}from"../types";import{repositoryToken}from"./github";
export async function checkoutCredential(env:Env,repository:string){return repositoryToken(env,repository)}
export function providerDiagnostic(env:Record<string,unknown>){const names=["GEMINI_API_KEYS","GROQ_API_KEYS","CEREBRAS_API_KEYS","OPENROUTER_API_KEYS"].filter(k=>Boolean(env[k]));return{providers:names.map(x=>x.replace("_API_KEYS","").toLowerCase()),models:[],degradedMode:false}}

export function providerCredential(env:Env){const names=["GEMINI_API_KEYS","GROQ_API_KEYS","CEREBRAS_API_KEYS","OPENROUTER_API_KEYS","NVIDIA_API_KEYS"]as const,credentials=Object.fromEntries(names.filter(name=>env[name]).map(name=>[name,env[name]]));if(!Object.keys(credentials).length)throw new Error("No model provider is configured");return{credentials}}
