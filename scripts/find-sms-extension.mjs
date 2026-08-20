#!/usr/bin/env node
/**
 * Encuentra en QUÉ extensión aterrizan los SMS entrantes, escaneando el
 * message-store de cada extensión (requiere ReadAccounts + admin JWT).
 *
 * Uso: RC_CLIENT_ID=... RC_CLIENT_SECRET=... RC_JWT=... node scripts/find-sms-extension.mjs
 */

const SERVER = (process.env.RC_SERVER_URL ?? "https://platform.ringcentral.com").replace(/\/+$/, "");
const DAYS = Number(process.env.SCAN_DAYS ?? 7);

function req(n){const v=process.env[n];if(!v){console.error("Falta "+n);process.exit(1);}return v;}

async function getToken(){
  const basic=Buffer.from(`${req("RC_CLIENT_ID")}:${req("RC_CLIENT_SECRET")}`).toString("base64");
  const body=new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion:req("RC_JWT")});
  const r=await fetch(`${SERVER}/restapi/oauth/token`,{method:"POST",headers:{Authorization:`Basic ${basic}`,"Content-Type":"application/x-www-form-urlencoded"},body});
  const d=await r.json();
  if(!r.ok){console.error("OAuth falló",JSON.stringify(d));process.exit(1);}
  return d.access_token;
}
async function api(token,path){
  const r=await fetch(`${SERVER}${path}`,{headers:{Authorization:`Bearer ${token}`,Accept:"application/json"}});
  return {ok:r.ok,status:r.status,data:await r.json().catch(()=>({}))};
}
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

async function main(){
  const token=await getToken();
  const dateFrom=new Date(Date.now()-DAYS*24*60*60*1000).toISOString();
  console.log(`Escaneando SMS desde ${dateFrom}\n`);

  // 1. Listar extensiones (todas las páginas).
  let exts=[]; let page=1;
  for(;;){
    const r=await api(token,`/restapi/v1.0/account/~/extension?perPage=1000&page=${page}`);
    if(!r.ok){console.error("No pude listar extensiones",r.status,JSON.stringify(r.data).slice(0,200));process.exit(1);}
    exts=exts.concat(r.data.records||[]);
    if(!r.data.navigation?.nextPage) break;
    page++;
  }
  console.log(`Extensiones totales: ${exts.length}`);
  const byType={}; for(const e of exts){byType[e.type]=(byType[e.type]||0)+1;}
  console.log("Por tipo:",JSON.stringify(byType));

  // 2. Escanear message-store SMS de cada extensión (secuencial suave por rate-limit).
  const hits=[];
  let scanned=0;
  for(const e of exts){
    const r=await api(token,`/restapi/v1.0/account/~/extension/${e.id}/message-store?messageType=SMS&dateFrom=${encodeURIComponent(dateFrom)}&perPage=20`);
    scanned++;
    if(r.ok){
      const recs=(r.data.records||[]);
      if(recs.length){
        const inbound=recs.filter(m=>m.direction==="Inbound");
        hits.push({ext:e,total:recs.length,inbound:inbound.length,sample:recs.slice(0,3)});
      }
    }
    if(scanned%20===0){console.log(`  ...escaneadas ${scanned}/${exts.length}`);await sleep(300);}
  }

  console.log(`\n═══ Extensiones con SMS en los últimos ${DAYS} días ═══`);
  if(!hits.length){console.log("Ninguna extensión tiene SMS en su message-store.");}
  for(const h of hits){
    console.log(`\n► ext id=${h.ext.id} ext#=${h.ext.extensionNumber} "${h.ext.name}" type=${h.ext.type}`);
    console.log(`   SMS: ${h.total} (inbound: ${h.inbound})`);
    for(const m of h.sample){
      const from=m.from?.phoneNumber||"?";
      const to=(m.to||[]).map(t=>t.phoneNumber).join(",");
      console.log(`   - ${m.creationTime} ${m.direction} from ${from} → ${to} "${String(m.subject||"").slice(0,40)}"`);
    }
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
