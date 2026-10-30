// Test fixture only. Production routing belongs to the AWS ALB, not this file.
import {createServer} from 'node:http';
const allowed=new Set([3201,3203]);
const backends=[3201,3203].map(port=>({port,healthy:false,draining:false,active:0,requests:0}));
let cursor=0,retries=0;
async function probe(){await Promise.all(backends.map(async b=>{try{b.healthy=!b.draining&&(await fetch(`http://127.0.0.1:${b.port}/ready`,{signal:AbortSignal.timeout(500)})).ok;}catch{b.healthy=false;}}));}
await probe();const timer=setInterval(()=>{void probe();},250);timer.unref();
const server=createServer(async(req,res)=>{
 const url=new URL(req.url??'/','http://127.0.0.1:3205');
 if(req.method==='GET'&&url.pathname==='/_load/stats'){res.setHeader('content-type','application/json');res.end(JSON.stringify({backends,retries}));return;}
 if(req.method==='POST'&&['/_load/drain','/_load/restore'].includes(url.pathname)){
  const port=Number(url.searchParams.get('port'));if(!allowed.has(port)){res.writeHead(400).end();return;}
  const b=backends.find(item=>item.port===port);b.draining=url.pathname.endsWith('drain');await probe();res.writeHead(204).end();return;
 }
 if(url.pathname==='/ready'){res.writeHead(backends.some(b=>b.healthy)?200:503).end();return;}
 const candidates=backends.filter(b=>b.healthy&&!b.draining);if(!candidates.length){res.writeHead(503).end();return;}
 const first=candidates[cursor++%candidates.length],alternatives=[first,...backends.filter(b=>b!==first&&!b.draining)];
 const read=req.method==='GET'||req.method==='HEAD';
 for(let i=0;i<(read?alternatives.length:1);i++){
  const b=alternatives[i];b.active++;b.requests++;
  try{
   const headers=new Headers();for(const [name,value]of Object.entries(req.headers))if(value!==undefined&&!['connection','host','transfer-encoding','content-length'].includes(name))headers.set(name,Array.isArray(value)?value.join(','):value);
   headers.set('x-forwarded-for',String(req.headers['x-forwarded-for']??'127.0.0.1'));
   const response=await fetch(`http://127.0.0.1:${b.port}${url.pathname}${url.search}`,{method:req.method,headers,redirect:'manual',
    ...(read?{}:{body:req,duplex:'half'}),signal:AbortSignal.timeout(15000)});
   // Buffer only fixture-sized responses so a failed GET can be retried before
   // sending headers. Production ALB retries are not inferred from this fixture.
   const body=Buffer.from(await response.arrayBuffer());if(body.length>4*1024*1024)throw new Error('Fixture response too large');
   res.statusCode=response.status;
   for(const [name,value]of response.headers)if(!['content-length','content-encoding','transfer-encoding','connection','set-cookie'].includes(name))res.setHeader(name,value);
   const cookies=response.headers.getSetCookie();if(cookies.length)res.setHeader('set-cookie',cookies);
   res.setHeader('content-length',body.length);res.setHeader('x-load-upstream',String(b.port));res.end(body);return;
  }catch{b.healthy=false;if(!read||i+1>=alternatives.length){res.writeHead(502).end();return;}retries++;}
  finally{b.active--;}
 }
});
server.listen(3205,'127.0.0.1');
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{clearInterval(timer);server.close(()=>process.exit(0));});
