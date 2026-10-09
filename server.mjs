import http from 'node:http';
import {setDefaultResultOrder,lookup} from 'node:dns';
import {setDefaultAutoSelectFamily} from 'node:net';
setDefaultResultOrder('ipv4first');setDefaultAutoSelectFamily(false);
lookup('www.findjob.co.kr',{all:true},(error,addresses)=>console.log('Source DNS',error?.code,addresses));
import {timingSafeEqual} from 'node:crypto';
import {collectFindjobJobs} from './findjob.mjs';
const key=process.env.COLLECTOR_KEY;
if(!key||key.length<32)throw Error('COLLECTOR_KEY must be configured');
let running=false;
const authorized=value=>{const a=Buffer.from(value||''),b=Buffer.from('Bearer '+key);return a.length===b.length&&timingSafeEqual(a,b);};
const reply=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
http.createServer(async(req,res)=>{
 if(req.url==='/health'&&req.method==='GET')return reply(res,200,{ok:true});
 if(req.url!=='/snapshot'||req.method!=='GET')return reply(res,404,{error:'Not found'});
 if(!authorized(req.headers.authorization))return reply(res,401,{error:'Unauthorized'});
 if(running)return reply(res,409,{error:'Collection already running'});
 running=true;
 try{
  const searches=[],details={};
  const result=await collectFindjobJobs({FINDJOB_FETCH:async(url,options)=>{
   let response;try{response=await fetch(url,options);}catch(error){console.error('Upstream connection',new URL(url).hostname,error.name,error.cause?.code,error.cause?.message);throw error;}if(!response.ok)return response;
   const data=await response.clone().json();
   if(new URL(url).pathname.endsWith('/search'))searches.push(data.data.result);
   else details[JSON.parse(options.body).adId]=data.data;
   return response;
  }});
  const rows=searches.flatMap(search=>search.rows),total=searches[0]?.total_count;
  if(rows.length!==total)throw Error('Incomplete source snapshot');
  reply(res,200,{format:'youngjin-findjob-v1',companyId:'15413342',capturedAt:Date.now(),search:{result:{total_count:total,rows}},details});
  console.log('Public ads collected',result.jobs.length);
 }catch(error){console.error('Public collection failed',error.name);reply(res,502,{error:'Source unavailable'});}finally{running=false;}
}).listen(Number(process.env.PORT||3000),'0.0.0.0');
