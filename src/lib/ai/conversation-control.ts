// Shared CRM-parent state transition for the original and scoped inbox.
export function aiConversationPatch(paused:boolean,userId:string,assignToMe=true):Record<string,unknown>{
 if(paused)return {ai_autoreply_disabled:true,...(assignToMe?{assigned_agent_id:userId}:{})}
 return {ai_autoreply_disabled:false,assigned_agent_id:null,ai_reply_count:0,ai_handoff_summary:null}
}
