/** OW14-W06: privacy-safe read-only VPS capacity inventory.
 * No environment variables, session profiles, secrets or mounts are exported.
 * No Docker mutation, WhatsApp transport or backup changes.
 */
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { readFileSync, statfsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const MiB=1024**2
const GiB=1024**3
export function classify(container) {
  const s=String(container.Names??'')+' '+String(container.Image??'')
  if(/openwa|whatsapp-web\.js|baileys|whatsapp-gateway/i.test(s))return 'openwa'
  if(/scheduler|selfhost-test-worker/i.test(s))return 'scheduler'
  if(/wacrm|eplu-test-crm|crm-hostinger/i.test(s))return 'wacrm'
  return 'other'
}
export function bytes(input) {
  const match=/^(\d+(?:\.\d+)?)\s*(B|KiB|MiB|GiB|TiB|kB|MB|GB|TB)$/i.exec(String(input??'').trim())
  if(!match)return null
  const unit=match[2].toLowerCase()
  const factors={b:1,kib:1024,mib:MiB,gib:GiB,tib:GiB*1024,
    kb:1000,mb:1e6,gb:1e9,tb:1e12}
  const n=Number(match[1])
  return Number.isFinite(n)?n*factors[unit]:null
}
export function lines(input) {
  return String(input).split(/\r?\n/).filter(Boolean).flatMap(line=>{
    try {const item=JSON.parse(line);return item && typeof item==='object' && !Array.isArray(item)?[item]:[]}
    catch{return []}
  })
}
function execute(cmd,args) {
  return execFileSync(cmd,args,{encoding:'utf8',timeout:12000,maxBuffer:1e6,
    stdio:['ignore','pipe','pipe']})
}
export function dockerSnapshot(run=execute) {
  const roles={wacrm:{count:0,cpu_percent:0,memory_mib:0},
    scheduler:{count:0,cpu_percent:0,memory_mib:0},
    openwa:{count:0,cpu_percent:0,memory_mib:0},
    other:{count:0,cpu_percent:0,memory_mib:0}}
  let list,stats
  try {
    list=lines(run('docker',['ps','--no-trunc','--format','{{json .}}']))
    stats=lines(run('docker',['stats','--no-stream','--format','{{json .}}']))
  }catch {
    return {available:false,error_code:'docker_read_unavailable',roles,
      openwa:{mount_inspection_complete:false,persistent_mount_count:null,
        image_hash_prefixes:[]}}
  }
  const byId=new Map()
  for(const stat of stats) {
    if(stat.ID)byId.set(String(stat.ID),stat)
    if(stat.Container)byId.set(String(stat.Container),stat)
    if(stat.Name)byId.set(String(stat.Name),stat)
  }
  let mountCount=0,complete=true
  const hashes=[]
  for(const container of list) {
    const role=classify(container)
    roles[role].count++
    const stat=byId.get(String(container.ID??''))??byId.get(String(container.Names??''))
    if(stat) {
      const cpu=/^(\d+(?:\.\d+)?)%$/.exec(String(stat.CPUPerc??''))
      const mem=bytes(String(stat.MemUsage??'').split('/')[0])
      if(cpu)roles[role].cpu_percent+=Number(cpu[1])
      if(mem!==null)roles[role].memory_mib+=mem/MiB
    }
    if(role!=='openwa')continue
    const id=String(container.ID??'')
    if(!/^[a-z0-9]{10,64}$/i.test(id)){complete=false;continue}
    try {
      const mounts=JSON.parse(run('docker',['inspect','--format','{{json .Mounts}}',id]))
      if(!Array.isArray(mounts)){complete=false;continue}
      for(const mount of mounts) {
        if(mount?.Type==='bind'||mount?.Type==='volume')mountCount++
      }
      const hash=String(run('docker',['inspect','--format','{{.Image}}',id])).trim()
      if(/^sha256:[0-9a-f]{64}$/i.test(hash))hashes.push(hash.slice(0,19))
    }catch{complete=false}
  }
  for(const r of Object.values(roles)) {
    r.cpu_percent=Number(r.cpu_percent.toFixed(2))
    r.memory_mib=Number(r.memory_mib.toFixed(1))
  }
  return {available:true,roles,openwa:{
    mount_inspection_complete:complete,
    persistent_mount_count:complete?mountCount:null,
    image_hash_prefixes:hashes,
  }}
}
export function hostSnapshot() {
  let available=null
  try{
    const m=/^MemAvailable:\s+(\d+)\s+kB$/m.exec(readFileSync('/proc/meminfo','utf8'))
    if(m)available=Math.round(Number(m[1])*1024/MiB)
  }catch{/* optional Linux metric */}
  let disk=null
  try{
    const s=statfsSync('/')
    disk={root_total_gib:Number((Number(s.blocks)*Number(s.bsize)/GiB).toFixed(1)),
      root_available_gib:Number((Number(s.bavail)*Number(s.bsize)/GiB).toFixed(1))}
  }catch{/* unsupported file system */}
  return {cpu_logical:os.cpus().length,ram_total_mib:Math.round(os.totalmem()/MiB),
    ram_available_mib:available,load_1m:Number(os.loadavg()[0].toFixed(2)),disk}
}
export function snapshot(run=execute,host=hostSnapshot()) {
  return {schema:'ow14-w06-host-capacity-v1',observed_at:new Date().toISOString(),
    scope:'read_only_no_secrets',host,docker:dockerSnapshot(run),
    warning:'single_sample_not_peak_not_restore_proof'}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  try{process.stdout.write(JSON.stringify(snapshot(),null,2)+'\n')}
  catch{process.stderr.write('Capacity inventory failed (redacted)\n');process.exitCode=1}
}
