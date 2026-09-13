import {json} from "../types";
export class ApiError extends Error { constructor(public status:number,public code:string,message:string){super(message)} }
export async function errors(fn:()=>Promise<Response>,production=true){try{return await fn()}catch(e){if(e instanceof ApiError)return json({error:{code:e.code,message:e.message}},e.status);if(e instanceof Response)return e;console.error(e);return json({error:{code:"internal_error",message:"The request could not be completed."}},500,production?{}:{"x-debug-error":String(e)})}}
export async function readJson(request:Request){try{return await request.json()}catch{throw new ApiError(400,"invalid_json","The request body must be valid JSON.")}}
