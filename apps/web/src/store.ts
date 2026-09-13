import type { RunEvent } from "@avos/protocol";
export type State={run:any;events:RunEvent[];tasks:any[];files:any[];approvals:any[];attachments:any[];connected:boolean};
export const initial:State={run:null,events:[],tasks:[],files:[],approvals:[],attachments:[],connected:true};
export function reconcile(state:State,incoming:RunEvent[]):State{const map=new Map(state.events.map(e=>[e.sequence,e]));for(const e of incoming)map.set(e.sequence,e);const events=[...map.values()].sort((a,b)=>a.sequence-b.sequence);const latest=events.at(-1);if(latest)localStorage.setItem(`avos:sequence:${latest.runId}`,String(latest.sequence));return {...state,events};}
