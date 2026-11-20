import {test} from 'node:test'
import assert from 'node:assert/strict'
import {classify,bytes,lines,dockerSnapshot,snapshot} from './hostinger-capacity-baseline.mjs'

test('classifies WACRM, OpenWA and scheduler without emitting their names',()=>{
  assert.equal(classify({Names:'openwa-gateway-1'}),'openwa')
  assert.equal(classify({Image:'wacrm-hostinger:local'}),'wacrm')
  assert.equal(classify({Names:'my-scheduler'}),'scheduler')
  assert.equal(classify({Image:'postgres'}),'other')
})
test('handles Docker binary sizes and malformed metrics',()=>{
  assert.equal(bytes('1GiB'),1024**3)
  assert.equal(bytes('1GB'),10**9)
  assert.equal(bytes('invalid'),null)
  assert.equal(lines('oops\n{"Name":"hi"}\n').length,1)
})
test('collector invokes fixed Docker read-only calls and never exposes secrets, container names or volume paths',()=>{
  const secret='PRIVATE_WA_PHONE_SECRET'
  const openId='a'.repeat(12)
  const imageHash='sha256:'+'f'.repeat(64)
  const calls=[]
  const run=(command,args)=>{
    calls.push([command,args])
    if(args[0]==='ps')return JSON.stringify({ID:openId,Names:'openwa-'+secret,
      Image:'openwa.private:'+secret})
    if(args[0]==='stats')return JSON.stringify({
      ID:openId,Name:'openwa-'+secret,CPUPerc:'12.5%',MemUsage:'1.3GiB / 12GiB',
    })
    if(args[0]==='inspect'&&args[2]==='{{json .Mounts}}')
      return JSON.stringify([{Type:'bind',Source:'/root/.ssh/'+secret,
        Destination:'/auth/'+secret},{Type:'tmpfs',Source:secret}])
    if(args[0]==='inspect'&&args[2]==='{{.Image}}')return imageHash
    throw Error(secret)
  }
  const x=dockerSnapshot(run)
  assert.equal(x.available,true)
  assert.equal(x.roles.openwa.count,1)
  assert.equal(x.roles.openwa.memory_mib,1331.2)
  assert.equal(x.openwa.persistent_mount_count,1)
  assert.deepEqual(x.openwa.image_hash_prefixes,[imageHash.slice(0,19)])
  const output=JSON.stringify(snapshot(run,{cpu_logical:4,ram_total_mib:12288}))
  assert.equal(output.includes(secret),false)
  assert.equal(output.includes('/root/.ssh'),false)
  assert.equal(calls.every(([command,args])=>command==='docker' &&
    ['ps','stats','inspect'].includes(args[0])),true)
  assert.equal(calls.some(([,args])=>args.some(arg=>/\.Env|\.Config\.Env|--env/i.test(arg))),false)
})
test('missing docker is unavailable, not a falsely green zero',()=>{
  const x=dockerSnapshot(()=>{throw Error('PRIVATE_KEY')})
  assert.equal(x.available,false)
  assert.equal(JSON.stringify(x).includes('PRIVATE_KEY'),false)
})
