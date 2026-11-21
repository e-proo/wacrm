// INBOX-0 read-only reproducible inventory. No external calls, credentials or provider events.
// Prints only paths/line numbers/categories, never source text or customer data.
import { execFileSync } from 'node:child_process';
const git = (...args) => execFileSync('git', args, {encoding:'utf8',maxBuffer:64*1024*1024});
const sha = git('rev-parse','HEAD').trim();
const files = git('ls-files','-z','--','src','mcp-server/src','supabase/migrations','supabase/ci').split('\0').filter(p=>/\.(?:ts|tsx|js|mjs|sql)$/.test(p));
const patterns = {
  table: /\b(?:messages|conversations|whatsapp_connections|message_reactions|notifications|broadcast_recipients)\b/i,
  route: /resolveConversationTransport|resolveWhatsAppTransport|sendMessageToConversation|engineSendText|engineSendTemplate|resolveConversationByPhone|correlateInboundTaskReply|buildConversationContext/i,
  identity: /phone_identity|phoneIdentity|provider_message_id|providerMessageId|provider_chat_id|providerChatId|provider_event_id|membership_epoch|outbound_idempotency_key/i,
  sql: /bump_conversation_on_inbound|merge_duplicate_(?:contacts|conversations)|claim_agent_task_outbound_message|reserve_(?:bound_)?agent_task_outbound_message|correlate_agent_task_inbound_reply|requeue_verified_openwa_predispatch_business_event/i,
  connection: /connection_id|connectionId|session_id|sessionId|account_id|accountId/i
};
const counts = Object.fromEntries(Object.keys(patterns).map(k=>[k,0]));
let relevant=0;
console.log('INBOX-CENSUS HEAD='+sha+' tracked_source_files='+files.length);
for(const path of files){
 const src=git('show','HEAD:'+path);
 const lines=src.split(/\r?\n/);
 const hits={};
 for(const [key,re] of Object.entries(patterns)){
  // Generic connection/account hits are useful only with a stronger surface match.
  if(key==='connection'&&!Object.keys(hits).length) continue;
  const loc=[]; for(let i=0;i<lines.length;i++) if(re.test(lines[i]))loc.push(i+1);
  if(loc.length){counts[key]++;hits[key]=loc;}
 }
 if(!Object.keys(hits).length)continue;
 relevant++;
 console.log(JSON.stringify({path,categories:Object.fromEntries(Object.entries(hits).map(([k,v])=>[k,{count:v.length,lines:v}]))}));
}
console.log('INBOX-CENSUS SUMMARY '+JSON.stringify({sha,trackedSourceFiles:files.length,candidateFiles:relevant,categories:counts}));
if(!files.length||!relevant)process.exitCode=1;
