// Reads only the same unauthenticated search/detail endpoints used by Findjob's public pages.
// Fixed company identity and fixed upstream hosts: callers cannot select arbitrary sources.
const FINDJOB_COMPANY='15413342';
const FINDJOB_ORIGIN='https://www.findjob.co.kr';
const FINDJOB_STATE='findjob_sync_state';
const FINDJOB_LOCK='findjob_sync_lock';
const findjobEncoder=new TextEncoder();
const findjobToday=now=>new Date(now+9*3600000).toISOString().slice(0,10);
const findjobError=message=>Object.assign(new Error(message),{status:502});
const findjobSha=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',findjobEncoder.encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
const findjobSetting=async(env,key)=>JSON.parse((await env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind(key).first())?.value||'null');
const findjobSaveSetting=(env,key,value)=>env.DB.prepare('INSERT INTO site_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key,JSON.stringify(value));

export function findjobPlainText(html){
 const entities={nbsp:' ',amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",ndash:'–',mdash:'—',middot:'·'};
 return String(html||'').replace(/<(script|style|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'').replace(/<br\s*\/?>|<\/(?:p|div|li|h[1-6]|tr)>/gi,'\n').replace(/<[^>]*>/g,'').replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi,(all,key)=>{if(key[0]==='#'){const n=key[1].toLowerCase()==='x'?parseInt(key.slice(2),16):Number(key.slice(1));return n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)?String.fromCodePoint(n):'';}return entities[key.toLowerCase()]??all;}).replace(/\r/g,'').replace(/[ \t]+/g,' ').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
function findjobDate(value){const raw=String(value||'').replace(/[^0-9]/g,'').slice(0,8);if(!/^\d{8}$/.test(raw))return '';const day=raw.slice(0,4)+'-'+raw.slice(4,6)+'-'+raw.slice(6,8);return Number.isFinite(Date.parse(day))&&new Date(day).toISOString().slice(0,10)===day?day:'';}
function findjobDayEnd(value){const day=findjobDate(value);return day?Date.parse(day+'T23:59:59.999+09:00'):0;}
async function findjobRead(env,path,body){
 // Workerd supports manual/follow redirects only. Reject redirects through !ok below.
 let response;
 for(let attempt=0;attempt<2;attempt++){
  try{
   const origin=attempt===0?FINDJOB_ORIGIN:'https://m.findjob.co.kr';
   response=await (env.FINDJOB_FETCH||fetch)(origin+path,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json','User-Agent':'Youngjin21-PublicJobs/1.0 (+https://youngjin21.com)'},body:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(30000)});
   if(response.ok)break;
   console.error('Findjob upstream response failed',origin,path,response.status);
   if(response.status>=300&&response.status<400)break;
   if(attempt===0){await response.body?.cancel();continue;}
  }catch(error){
   console.error('Findjob upstream request failed',path,attempt+1,String(error?.name||'Error'));
   if(attempt===1)throw error;
  }
 }
 if(!response.ok)throw findjobError('벼룩시장 연결이 원활하지 않습니다. 기존 공고는 유지됩니다.');
 const text=await response.text();if(text.length>2000000)throw findjobError('벼룩시장 응답이 예상 범위를 넘었습니다.');
 let result;try{result=JSON.parse(text);}catch{throw findjobError('벼룩시장 응답 형식이 바뀌었습니다. 연결 점검이 필요합니다.');}
 if(String(result.status)!=='200'||result.code!=='0000'||!result.data)throw findjobError('벼룩시장 정보를 확인하지 못했습니다. 기존 공고는 유지됩니다.');
 return result.data;
}
function findjobValidateText(value,max,label){if(!value||value.length>max)throw findjobError('공고의 '+label+'을 확인해야 합니다. 기존 공고는 유지됩니다.');return value;}
export async function collectFindjobJobs(env,now=Date.now()){
 const query='text_idx="영진통운" allwordthruindex synonym("d0") yb redro $relevance csed';
 const encoded=btoa(Array.from(findjobEncoder.encode(query),b=>String.fromCharCode(b)).join(''));
 const rows=[];let total=null;
 for(let offset=0;offset<500;offset+=100){
  const data=await findjobRead(env,'/job-info/api/v1/konan/search',{konanParam1:'*',konanParam2:'ad.ad',konanParam3:encoded,konanParam4:'100',konanParam5:String(offset)});
  const result=data.result;
  if(!result||!Number.isInteger(result.total_count)||result.total_count<0||result.total_count>500||!Array.isArray(result.rows))throw findjobError('공고 검색 결과 형식이 바뀌었습니다. 연결 점검이 필요합니다.');
  if(total!==null&&total!==result.total_count)throw findjobError('검색 중 공고 목록이 변경되었습니다. 다음 확인 때 다시 가져옵니다.');
  total=result.total_count;
  if(!result.rows.length&&offset<total)throw findjobError('공고 목록을 끝까지 읽지 못했습니다. 기존 공고는 유지됩니다.');
  rows.push(...result.rows);
  if(rows.length>=total)break;
 }
 if(rows.length!==total)throw findjobError('공고 목록을 끝까지 읽지 못했습니다. 기존 공고는 유지됩니다.');
 const groups=new Map();
 for(const row of rows){
  const f=row.fields;if(!f||String(f.cuid)!==FINDJOB_COMPANY)continue;
  if(!/^\d{1,12}$/.test(f.ad_id)||!/^([a-f0-9]{32,128})$/.test(f.gp_field||''))throw findjobError('공고 식별 정보가 바뀌었습니다. 연결 점검이 필요합니다.');
  const searchExpires=findjobDayEnd(f.pblsh_end_dt);
  if(!searchExpires||(f.coll_end_dt&&!findjobDate(f.coll_end_dt)))throw findjobError('벼룩시장 게시 기간 형식이 바뀌었습니다. 기존 공고는 유지됩니다.');
  if(f.clos_dt||searchExpires<now||(findjobDayEnd(f.coll_end_dt)&&findjobDayEnd(f.coll_end_dt)<now))continue;
  const prior=groups.get(f.gp_field);if(!prior||Number(f.ad_id)>Number(prior.ad_id))groups.set(f.gp_field,f);
 }
 if(groups.size>40)throw findjobError('공고가 많아 연결 설정을 확인해야 합니다. 기존 공고는 유지됩니다.');
 const jobs=[];
 for(const [sourceKey,f] of groups){
  const data=await findjobRead(env,'/job-info/api/v1/jobInfo/jobDtl',{cltDvsn:'pc',adId:f.ad_id,pageNm:'PUBLIC_JOB'});
  const ad=data.adDtl;
  if(!ad||String(ad.cuid)!==FINDJOB_COMPANY||String(ad.adId)!==f.ad_id||String(ad.bizCorpNm).replace(/\s/g,'')!=='주식회사영진통운21'||ad.reprNm!=='이용화')throw findjobError('영진통운 회사 정보가 일치하지 않아 가져오기를 중단했습니다.');
  const expiresAt=findjobDayEnd(ad.pblshEndDt);if(!expiresAt)throw findjobError('벼룩시장 게시 기간을 확인하지 못했습니다.');
  const deadline=findjobDate(ad.collEndDt);
  if(expiresAt<now||(deadline&&deadline<findjobToday(now)))continue;
  const time=value=>/^\d{4}$/.test(value||'')?value.slice(0,2)+':'+value.slice(2):'';
  const period=[time(ad.wrkTmFrom),time(ad.wrkTmTo)].filter(Boolean).join(' ~ ');
  const amount=/^\d+$/.test(ad.salAmt||'')?Number(ad.salAmt):0;
  const job={source_key:sourceKey,source_id:f.ad_id,title:findjobValidateText(findjobPlainText(ad.title),300,'제목'),region:findjobValidateText(findjobPlainText(ad.wrkAddrRoad||ad.wrkAddrJibeon||ad.regnNm),500,'운행 지역'),schedule:findjobValidateText([ad.dayWeek,period||ad.wrkTmCd,ad.wrkTmEtc].filter(Boolean).map(findjobPlainText).join(' · '),500,'운행 시간'),salary:amount?`${ad.salKind||'급여'} ${amount.toLocaleString('ko-KR')}원`:(ad.salComRulesEtc||'상세 안내 참고'),qualification:findjobPlainText(ad.ableOptKor).replace(/\|/g,' · '),description:findjobValidateText(findjobPlainText(ad.cn),20000,'상세 내용'),deadline,expires_at:expiresAt,source_updated_at:String(ad.updDt||ad.regDt||''),source_status:'active'};
  job.content_hash=await findjobSha(JSON.stringify(job));jobs.push(job);
 }
 return {jobs,rawCount:rows.filter(row=>String(row.fields?.cuid)===FINDJOB_COMPANY).length};
}
export async function findjobSyncStatus(env){
 const state=await findjobSetting(env,FINDJOB_STATE);
 const jobs=(await env.DB.prepare('SELECT * FROM findjob_jobs ORDER BY created_at DESC').all()).results;
 return {company:'주식회사 영진통운21',state,jobs};
}
export async function importFindjobSnapshot(env,snapshot){
 const now=Date.now();
 if(snapshot?.format!=='youngjin-findjob-v1'||snapshot.companyId!==FINDJOB_COMPANY||!Number.isSafeInteger(snapshot.capturedAt)||snapshot.capturedAt<now-3600000||snapshot.capturedAt>now+300000||!Array.isArray(snapshot.search?.result?.rows)||!snapshot.details||typeof snapshot.details!=='object')throw findjobError('영진통운 공고 파일을 확인해 주세요. 한 시간 이내에 만든 파일만 올릴 수 있습니다.');
 if(snapshot.search.result.rows.length>500||snapshot.search.result.total_count!==snapshot.search.result.rows.length)throw findjobError('공고 목록이 완전하지 않습니다. 파일을 다시 만들어 주세요.');
 const reader={...env,FINDJOB_FETCH:async(url,options)=>{
  const path=new URL(url).pathname,body=JSON.parse(options.body);
  const data=path.endsWith('/search')?snapshot.search:snapshot.details[body.adId];
  if(!data)throw findjobError('공고 상세 정보가 빠졌습니다. 파일을 다시 만들어 주세요.');
  return Response.json({status:'200',code:'0000',data});
 }};
 return syncFindjobJobs(reader,true);
}
export async function syncFindjobJobs(env,manual=false){
 const now=Date.now();const previous=await findjobSetting(env,FINDJOB_STATE);
 if(!manual&&previous?.lastAttemptAt>now-(previous?.error?60000:300000))return {...previous,skipped:true};
 const lease=crypto.randomUUID();
 const lock=await env.DB.prepare('INSERT INTO site_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(json_extract(site_settings.value,\'$.expiresAt\') AS INTEGER)<? RETURNING value').bind(FINDJOB_LOCK,JSON.stringify({lease,expiresAt:now+900000}),now).first();
 if(!lock)return {...previous,skipped:true,running:true};
 try{
  await findjobSaveSetting(env,FINDJOB_STATE,{...previous,lastAttemptAt:now,running:true}).run();
  const collected=await collectFindjobJobs(env,now);
  const existing=(await env.DB.prepare('SELECT source_key,content_hash,source_status FROM findjob_jobs').all()).results;
  let added=0,changed=0;
  const writes=[];
  for(const j of collected.jobs){
   const old=existing.find(x=>x.source_key===j.source_key);if(!old)added++;else if(old.content_hash!==j.content_hash||old.source_status!=='active')changed++;
   writes.push(env.DB.prepare(`INSERT INTO findjob_jobs (source_key,source_id,title,region,schedule,salary,qualification,description,deadline,expires_at,source_updated_at,content_hash,source_status,hidden,missing_count,first_missing_at,created_at,updated_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'active',0,0,NULL,?,?,?) ON CONFLICT(source_key) DO UPDATE SET source_id=excluded.source_id,title=excluded.title,region=excluded.region,schedule=excluded.schedule,salary=excluded.salary,qualification=excluded.qualification,description=excluded.description,deadline=excluded.deadline,expires_at=excluded.expires_at,source_updated_at=excluded.source_updated_at,content_hash=excluded.content_hash,source_status='active',missing_count=0,first_missing_at=NULL,updated_at=CASE WHEN findjob_jobs.content_hash<>excluded.content_hash THEN excluded.updated_at ELSE findjob_jobs.updated_at END,last_seen_at=excluded.last_seen_at`).bind(j.source_key,j.source_id,j.title,j.region,j.schedule,j.salary,j.qualification,j.description,j.deadline,j.expires_at,j.source_updated_at,j.content_hash,now,now,now));
  }
  // Never remove missing records after a failed fetch or a single temporary empty search.
  writes.push(env.DB.prepare("UPDATE findjob_jobs SET missing_count=missing_count+1,first_missing_at=COALESCE(first_missing_at,?),source_status=CASE WHEN expires_at<? OR (missing_count>=1 AND first_missing_at<=?) THEN 'closed' ELSE source_status END WHERE last_seen_at<?").bind(now,now,now-3600000,now));
  const state={lastAttemptAt:now,lastSuccessAt:now,rawCount:collected.rawCount,uniqueCount:collected.jobs.length,added,changed,running:false,error:'',method:manual?'file':'server'};
  writes.push(findjobSaveSetting(env,FINDJOB_STATE,state));await env.DB.batch(writes);return state;
 }catch(error){
  console.error('Findjob sync failed',String(error?.name||'Error'),String(error?.message||'Unknown error').slice(0,500));
  const message=error.status?error.message:'벼룩시장 연결을 확인하지 못했습니다. 기존 공고는 유지됩니다.';
  await findjobSaveSetting(env,FINDJOB_STATE,{...previous,lastAttemptAt:now,running:false,error:message}).run();throw findjobError(message);
 }finally{await env.DB.prepare("DELETE FROM site_settings WHERE key=? AND json_extract(value,'$.lease')=?").bind(FINDJOB_LOCK,lease).run();}
}

export async function findjobMcp(request,env){
 const headers={'Content-Type':'application/json','Cache-Control':'no-store'};
 const response=(id,result,error,status=200)=>new Response(JSON.stringify({jsonrpc:'2.0',id,...(error?{error}:{result})}),{status,headers});
 if(request.method==='GET')return new Response(null,{status:405,headers:{Allow:'POST'}});
 if(request.method!=='POST')return new Response(null,{status:405});
 const raw=await request.text();if(raw.length>8000)return response(null,null,{code:-32600,message:'Request too large'},413);
 let body;try{body=JSON.parse(raw);}catch{return response(null,null,{code:-32700,message:'Invalid JSON'},400);}
 if(!body||Array.isArray(body)||body.jsonrpc!=='2.0')return response(null,null,{code:-32600,message:'Invalid request'},400);
 const id=body.id??null;
 if(body.method==='initialize')return response(id,{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'youngjin21-recruitment-sync',version:'1.0.0'}});
 if(body.method?.startsWith('notifications/'))return new Response(null,{status:202});
 if(body.method==='ping')return response(id,{});
 const definitions=[{name:'findjob_sync_status',description:'Read the last sync result for Youngjin21 public recruitment ads. No inquiries, applicant data or credentials are returned.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}},{name:'sync_findjob_jobs',description:'Import/update only the public Findjob ads belonging to verified Youngjin21 company 15413342 into youngjin21.com. Deduplicates reposts, preserves manual ads and hidden choices. No arbitrary input, costs or applicant messages. Use for scheduled recruitment refreshes.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true}}];
 if(body.method==='tools/list')return response(id,{tools:definitions});
 if(body.method!=='tools/call')return response(id,null,{code:-32601,message:'Unknown method'});
 // These identity headers are set and protected by Sites OAuth, never by app cookies.
 const owner=env.FINDJOB_SYNC_OWNER_EMAIL;
 if(!owner||!request.headers.get('oai-authenticated-user-id')||request.headers.get('oai-authenticated-user-email')?.toLowerCase()!==owner.toLowerCase())return response(id,null,{code:-32001,message:'Site owner sign-in required'},403);
 if(body.params?.arguments&&Object.keys(body.params.arguments).length)return response(id,null,{code:-32602,message:'This tool takes no arguments'});
 try{
  let result;
  if(body.params?.name==='findjob_sync_status'){const data=await findjobSyncStatus(env);result={company:data.company,state:data.state,jobs:data.jobs.map(j=>({sourceId:j.source_id,title:j.title,status:j.source_status,hidden:!!j.hidden}))};}
  else if(body.params?.name==='sync_findjob_jobs')result=await syncFindjobJobs(env);
  else return response(id,null,{code:-32602,message:'Unknown tool'});
  return response(id,{content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,isError:false});
 }catch(error){return response(id,{content:[{type:'text',text:error.message}],isError:true});}
}
