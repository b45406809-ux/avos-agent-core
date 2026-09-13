import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;
const id = z.string().min(8).max(160);
const timestamp = z.string().datetime();
const json = z.unknown();
export const RunStatus = z.enum(["queued","provisioning","runner_booting","checkout","planning","executing","waiting_for_approval","verifying","publishing","warm_idle","cancelling","cancelled","completed","failed","recovery_required"]);
export const TaskStatus = z.enum(["pending","ready","running","blocked","waiting_for_approval","verifying","completed","failed","cancelled"]);
export const Run = z.object({schemaVersion:z.literal(PROTOCOL_VERSION),id,userId:id,organizationId:id,missionId:id,sessionId:id,repositoryId:id,status:RunStatus,latestSequence:z.number().int().nonnegative(),createdAt:timestamp,updatedAt:timestamp});
export const Task = z.object({schemaVersion:z.literal(PROTOCOL_VERSION),id,runId:id,status:TaskStatus,dependencies:z.array(id),packet:json,attempt:z.number().int().nonnegative()});
export const RunCommand = z.object({schemaVersion:z.literal(PROTOCOL_VERSION),id,runId:id,type:z.enum(["cancel","interrupt","follow_up","permission_decision","release_runner"]),idempotencyKey:id,payload:json,createdAt:timestamp,acknowledgedAt:timestamp.nullable().default(null)});
export const RunEvent = z.object({schemaVersion:z.literal(PROTOCOL_VERSION),eventId:id,sequence:z.number().int().positive(),runId:id,taskId:id.nullable().optional(),attemptId:id.nullable().optional(),agentId:id,eventType:z.string().min(1).max(80),timestamp,payload:json});
export const Checkpoint = z.object({schemaVersion:z.literal(PROTOCOL_VERSION),id,runId:id,missionRef:id,objectKey:z.string().min(1),checksum:id,repositoryRevision:z.string().min(1),createdAt:timestamp,retains:z.array(z.enum(["mission","amendments","task","criteria","instructions","plan","files","tests","failures","approval","next_action"]))});
export const PermissionRequest = z.object({schemaVersion:z.literal(PROTOCOL_VERSION),id,runId:id,capability:z.string().min(1),proposedAction:z.string().min(1),risk:z.string().min(1),resource:z.string().min(1),expiresAt:timestamp,reusable:z.boolean()});
export const PermissionDecision = z.object({schemaVersion:z.literal(PROTOCOL_VERSION),id,requestId:id,runId:id,decision:z.enum(["allow","deny"]),idempotencyKey:id,decidedAt:timestamp});
export const Attachment = z.object({schemaVersion:z.literal(PROTOCOL_VERSION),id,ownerId:id,filename:z.string().min(1).max(255),mimeType:z.string().min(1),size:z.number().int().nonnegative(),checksum:id,objectKey:z.string().min(1),scanStatus:z.enum(["pending","clean","quarantined","rejected"])});
export const PromptReference = z.object({schemaVersion:z.literal(PROTOCOL_VERSION),id,objectKey:z.string().min(1),checksum:id,size:z.number().int().positive(),sections:z.array(z.object({id,offset:z.number().int().nonnegative(),length:z.number().int().positive(),requirements:z.array(z.string())}))});
export const RunnerRegistration = z.object({schemaVersion:z.literal(PROTOCOL_VERSION),runId:id,oidcToken:z.string().min(20),githubRunId:z.string().min(1),correlationId:id});
export const RunnerHeartbeat = z.object({schemaVersion:z.literal(PROTOCOL_VERSION),runId:id,leaseToken:z.string().min(20),sequence:z.number().int().nonnegative(),remainingJobSeconds:z.number().int().nonnegative(),timestamp});
export const RunnerLease = z.object({schemaVersion:z.literal(PROTOCOL_VERSION),id,runId:id,token:z.string().min(20),expiresAt:timestamp,githubRunId:z.string().min(1)});
export const UsageLedger = z.object({schemaVersion:z.literal(PROTOCOL_VERSION),id,runId:id,provider:z.string(),model:z.string(),inputTokens:z.number().int().nonnegative(),outputTokens:z.number().int().nonnegative(),costUsd:z.number().nonnegative(),contextLimit:z.number().int().positive(),timestamp});
export type RunEvent = z.infer<typeof RunEvent>; export type RunCommand = z.infer<typeof RunCommand>;
export function parse<T extends z.ZodTypeAny>(schema:T, value:unknown):z.infer<T>{ return schema.parse(value); }
