const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const http=require('node:http');
const vm=require('node:vm');
const {once}=require('node:events');
const {setTimeout:delay}=require('node:timers/promises');
const {createServer,DEFAULT_IDLE_MS}=require('./pacer-server');
const {launch,request}=require('./pacer-launcher');
const {spawn}=require('node:child_process');
const regional={language:'en',locale:'en-US',ui_culture:'en-US',locale_source:'test'};
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(__dirname,'.pacer-test-lifecycle-'));
 t.after(async()=>{assert.ok(dir.startsWith(path.join(__dirname,'.pacer-test-lifecycle-')));await fs.rm(dir,{recursive:true,force:true});});
 return dir;
}
async function serve(t,options={}){
 const server=createServer({dir:await fixture(t),regional,enableResets:false,idleMs:450,shutdownGraceMs:1500,...options});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise(resolve=>{server.close(()=>resolve());server.closeAllConnections();}));
 const port=server.address().port,url=`http://127.0.0.1:${port}`;
 return {server,port,url};
}
async function ticket(url){
 const res=await fetch(url);const html=await res.text();
 return {key:html.match(/const MONITOR_KEY="([0-9a-f]{64})"/)[1],html,res};
}
function beat(url,key,extra={}){return fetch(url+'/api/heartbeat',{method:'POST',headers:{Origin:url,'X-Budget-Pacer-Monitor':key,...extra}});}
async function closedSoon(server,ms=2500){
 if(!server.listening)return;
 const event=once(server,'close');
 let timer;
 try{await Promise.race([event,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Server did not close')),ms);})]);}
 finally{clearTimeout(timer);}
}
test('default inactivity is exactly five minutes; probes and arbitrary requests do not renew it',async t=>{
 assert.equal(DEFAULT_IDLE_MS,300000);
 const {server,url}=await serve(t,{idleMs:1000});
 const started=Date.now();
 const {res}=await ticket(url);
 assert.equal(res.headers.get('x-frame-options'),'DENY');
 assert.match(res.headers.get('content-security-policy'),/frame-ancestors 'none'/);
 for(let i=0;i<25&&server.listening;i++){
  try{
   assert.equal((await fetch(url+'/api/health')).status,200);
   assert.equal((await fetch(url+'/api/time')).status,200);
   assert.equal((await fetch(url+'/api/limits')).status,404);
   assert.equal((await fetch(url)).status,200);
  }catch(e){if(server.listening)throw e;break;}
  await delay(75);
 }
 await closedSoon(server);
 assert.ok(Date.now()-started<2200,'Arbitrary probes must not postpone the idle deadline');
 await assert.rejects(fetch(url+'/api/health'));
});
test('valid same-origin activity keeps server alive; multiple tabs and aliases share the lease',async t=>{
 const {server,url,port}=await serve(t,{idleMs:700});
 const one=await ticket(url),two=await ticket(url);
 assert.equal(one.key,two.key);
 for(let i=0;i<7;i++){
  await delay(140);
  const base=i%2?url:`http://localhost:${port}`;
  assert.equal((await beat(base,i%2?one.key:two.key)).status,200);
 }
 assert.equal(server.listening,true);
 // Stop activity from all pages. No unload event is needed.
 await closedSoon(server);
});
test('foreign origin, absent capability, wrong method and request bodies cannot keep server alive',async t=>{
 const {server,url}=await serve(t,{idleMs:700});
 const {key}=await ticket(url);
 assert.equal((await beat(url,key,{Origin:'https://untrusted.example'})).status,403);
 assert.equal((await beat(url,'bad')).status,403);
 assert.equal((await fetch(url+'/api/heartbeat')).status,405);
 assert.equal((await fetch(url+'/api/heartbeat',{method:'POST',headers:{'X-Budget-Pacer-Monitor':key}})).status,403);
 assert.equal((await beat(url,key,{'Sec-Fetch-Site':'cross-site'})).status,403);
 assert.equal((await fetch(url+'/api/heartbeat',{method:'POST',body:'invalid',headers:{Origin:url,'X-Budget-Pacer-Monitor':key}})).status,400);
 assert.equal((await fetch(url+'/api/limits',{headers:{Origin:'http://other.local'}})).status,403);
 assert.equal((await fetch(url,{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
 await closedSoon(server);
});
test('orderly idle shutdown lets an active response finish then releases the port',async t=>{
 const {server,url,port}=await serve(t,{idleMs:500});
 const {key}=await ticket(url);
 // Test-only slow response: no external code and no credentials.
 server.prependListener('request',(req,res)=>{
  if(req.url==='/api/time'){
   const end=res.end.bind(res);res.end=(...args)=>setTimeout(()=>end(...args),800);
  }
 });
 await beat(url,key);
 const slow=fetch(url+'/api/time').then(async res=>({status:res.status,body:await res.json()}));
 await delay(650);assert.equal(server.listening,false);
 assert.equal((await slow).status,200);
 await closedSoon(server);
 const replacement=http.createServer((req,res)=>res.end('ok'));
 replacement.listen(port,'127.0.0.1');await once(replacement,'listening');
 await new Promise(resolve=>replacement.close(resolve));
});
test('shared launcher restarts an idle-stopped project and rejects its old page capability',async t=>{
 let pid;
 const oldHome=process.env.CODEX_HOME;
 t.after(async()=>{if(pid)try{process.kill(pid);await delay(300);}catch{};if(oldHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=oldHome;});
 const project=await fixture(t);
 for(const name of ['pacer-server.js','ai-budget-pacer.html','icon.png'])await fs.copyFile(path.join(__dirname,name),path.join(project,name));
 const server=require(path.join(project,'pacer-server')).createServer({dir:project,regional,enableResets:false,idleMs:550});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const port=server.address().port,url=`http://127.0.0.1:${port}`;
 const old=await ticket(url);
 await closedSoon(server);
 process.env.CODEX_HOME=project;
 const result=await launch({project,port,browser:false});
 pid=JSON.parse((await request(port,'/api/health')).body).pid;
 assert.equal(result.started,true);
 assert.equal((await beat(url,old.key)).status,403);
 const fresh=await ticket(url);assert.notEqual(fresh.key,old.key);
 assert.equal((await beat(url,fresh.key)).status,200);
 const second=await launch({project,port,browser:false});assert.equal(second.started,false);
});
test('browser script sends heartbeat before data refresh and resumes on visibility/pageshow',async t=>{
 const {url}=await serve(t,{idleMs:4000});const {html,key}=await ticket(url);
 const elements=new Map(),events={},calls=[];
 const get=id=>{if(!elements.has(id))elements.set(id,{textContent:'',className:'',style:{},hidden:false,insertAdjacentHTML(){}});return elements.get(id);};
 const context=vm.createContext({document:{getElementById:get,documentElement:{},visibilityState:'visible',addEventListener:(name,fn)=>{events[name]=fn;}},
  addEventListener:(name,fn)=>{events[name]=fn;},Intl,Date,AbortController,AbortSignal,setTimeout,clearTimeout,setInterval(){},
  fetch:async(route,options={})=>{calls.push(route);return fetch(url+route,{...options,headers:{...options.headers,Origin:url}});}});
 vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],context);
 for(let i=0;i<50 && !calls.includes('/api/limits');i++)await delay(20);
 assert.deepEqual(calls.slice(0,3),['/api/heartbeat','/api/time','/api/limits']);
 assert.equal(elements.get('p_h5').textContent,'unknown');
 assert.equal(typeof events.visibilitychange,'function');assert.equal(typeof events.pageshow,'function');
 assert.ok(!JSON.stringify(await (await fetch(url+'/api/health')).json()).includes(key));
});
test('a real Node child exits by itself on inactivity without process.exit and frees its port',async t=>{
 const script=`const s=require('./pacer-server').createServer({dir:'nonexistent-fixture',enableResets:false,regional:${JSON.stringify(regional)},idleMs:1100});s.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:s.address().port})));`;
 const child=spawn(process.execPath,['-e',script],{cwd:__dirname,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,BUDGET_PACER_ENABLE_RESETS:'0'}});
 t.after(()=>{if(child.exitCode===null)child.kill();});
 const exited=once(child,'exit');
 const ready=await new Promise((resolve,reject)=>{
  let output='';const timer=setTimeout(()=>reject(new Error('Child startup timeout')),5000);
  child.once('error',e=>{clearTimeout(timer);reject(e);});
  child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('\n')){clearTimeout(timer);resolve(JSON.parse(output.trim()));}});
 });
 for(let i=0;i<3;i++){
  const response=await fetch(`http://127.0.0.1:${ready.port}/api/health`);assert.equal(response.status,200);await response.text();await delay(100);
 }
 let timer;
 try{const [code]=await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Child did not exit')),4000);})]);assert.equal(code,0);}
 finally{clearTimeout(timer);}
 await assert.rejects(fetch(`http://127.0.0.1:${ready.port}/api/health`));
});
