const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {detectRegionalSettings,createServer}=require('./pacer-server');
const {once}=require('node:events');
const source=fs.readFileSync(path.join(__dirname,'ai-budget-pacer.html'),'utf8');
const script=source.match(/<script>([\s\S]*?)<\/script>/)[1];
const dictionaries=JSON.parse(source.match(/\/\*TRANSLATIONS\*\/([\s\S]*?)\/\*END_TRANSLATIONS\*\//)[1]);
async function screen(language,locale,browserLanguage='fr-FR'){
 const nodes=new Map();const documentElement={lang:''};
 const get=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',className:'',style:{},hidden:false,insertAdjacentHTML(){}});return nodes.get(id);};
 const at=Date.now()-1000;
 let fail=false,status=200,payload={primary:{window_minutes:300,used_percent:25,resets_at:Date.now()/1000+3600,logged_at:at},resets_available:2};
 const settings={language,locale,time_zone:'America/La_Paz'};
 const context=vm.createContext({document:{documentElement,getElementById:get},Intl,Date,AbortController,AbortSignal,setTimeout,clearTimeout,setInterval(){},navigator:{language:browserLanguage},
  fetch:async url=>{if(fail)throw new Error('offline');return {ok:url==='/api/time'||status===200,status,json:async()=>url==='/api/time'?settings:payload};}});
 vm.runInContext(script.replace('/*PACER_LOCALE*/null',JSON.stringify(settings)),context);
 await new Promise(resolve=>setImmediate(resolve));
 return {get,context,documentElement,nodes,settings,fail:()=>{fail=true;},missing:()=>{status=404;payload={error:'No valid local rate-limit records found.'};}};
}
test('Windows UI culture selects language independently from regional format, with explicit fallback',()=>{
 for(const ui of ['es-BO','es-ES','es-MX','en-US','en-GB','de-DE']){
  const result=detectRegionalSettings({platform:'win32',query:()=>JSON.stringify({ui,region:'en-GB'})});
  assert.equal(result.language,ui.startsWith('es')?'es':'en');assert.equal(result.locale,'en-GB');assert.equal(result.locale_source,'windows');
 }
 for(const query of [()=>{throw new Error('timeout');},()=>'{bad',()=>JSON.stringify({ui:'invalid_!'} )]){
  const result=detectRegionalSettings({platform:'win32',query});assert.equal(result.language,'en');assert.equal(result.locale,'en-US');assert.equal(result.locale_source,'fallback');
 }
});
test('translation dictionaries cover the same keys and placeholders',()=>{
 assert.deepEqual(Object.keys(dictionaries.es).sort(),Object.keys(dictionaries.en).sort());
 for(const key of Object.keys(dictionaries.en)){
  assert.ok(dictionaries.es[key]);assert.ok(dictionaries.en[key]);
  assert.deepEqual(dictionaries.es[key].match(/\{\w+\}/g)?.sort(),dictionaries.en[key].match(/\{\w+\}/g)?.sort());
 }
});
test('Spanish and English interfaces ignore browser language and keep numerical calculations',async()=>{
 for(const [language,locale,browser] of [['es','es-BO','en-US'],['es','es-ES','en-GB'],['es','es-MX','fr-FR'],['en','en-US','es-BO'],['en','en-GB','es-ES']]){
  const s=await screen(language,locale,browser),dict=dictionaries[language];
  assert.equal(s.documentElement.lang,language);
  assert.equal(s.get('quotaLabel_h5').textContent,dict.quota);assert.equal(s.get('timeLabel_h5').textContent,dict.time);
  assert.equal(s.get('name_wk').textContent,dict.week);
  assert.equal(s.get('ql_h5').textContent,new Intl.NumberFormat(locale,{style:'percent',maximumFractionDigits:1}).format(.75));
  assert.equal(s.get('qf_h5').style.width,'75%');
  assert.equal(vm.runInContext('r1(1.5)',s.context),new Intl.NumberFormat(locale,{maximumFractionDigits:1}).format(1.5));
  const ms=Date.parse('2026-11-17T12:34:56Z');
  assert.equal(vm.runInContext(`localDate(${ms})`,s.context),new Intl.DateTimeFormat(locale,{timeZone:'America/La_Paz',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(ms));
  assert.equal(s.get('rs').textContent,dict.resetsMany.replace('{n}','2'));
  assert.ok(s.get('reset_h5').textContent.startsWith(dict.next.split('{date}')[0]));
  assert.ok(s.get('s_h5').textContent.startsWith(dict.record.split('{date}')[0]));
  s.missing();await vm.runInContext('sync()',s.context);assert.equal(s.get('err').textContent,dict.noRecords);assert.equal(s.get('p_h5').textContent,dict.unknown);
  s.fail();await vm.runInContext('sync()',s.context);assert.equal(s.get('err').textContent,dict.updateFailed);assert.equal(s.get('p_h5').textContent,dict.offline);
 }
});
test('initial server-injected culture applies even if regional metadata fails',async()=>{
 const s=await screen('es','es-ES','en-US');s.fail();await vm.runInContext('sync()',s.context);
 assert.equal(s.documentElement.lang,'es');assert.equal(s.get('err').textContent,dictionaries.es.updateFailed);
});
test('HTML, lang, no-script message and regional API agree for simulated Windows cultures',async t=>{
 for(const language of ['es','en']){
  const locale=language==='es'?'es-MX':'en-GB';
  const server=createServer({enableResets:false,regional:{language,locale,ui_culture:locale,locale_source:'windows'}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
   const url=`http://127.0.0.1:${server.address().port}`;
   const html=await (await fetch(url)).text();
   assert.ok(html.includes(`<html lang="${language}">`));
   assert.ok(html.includes(`<noscript>${dictionaries[language].noscript}</noscript>`));
   assert.ok(!html.includes('/*PACER_LOCALE*/null'));
   const time=await (await fetch(url+'/api/time')).json();
   assert.equal(time.language,language);assert.equal(time.locale,locale);
  }finally{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}
 }
});
