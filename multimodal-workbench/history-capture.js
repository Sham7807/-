/* Save only completed browser observations. This module never invokes a model. */
(function(root){
'use strict';
const SINGLE_LIMIT=16*1024*1024,TOTAL_LIMIT=32*1024*1024;
const jobs=new Map(),holds=new Map(),deferredRevoke=new Set();
let session=null,sessionRequest=null;
const sensitive=/^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-goog-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|key|workbench[_-]?token)$/i;
const allowedMime=/^(?:image\/(?:png|jpeg|webp|gif|avif)|video\/(?:mp4|webm|quicktime)|audio\/(?:mpeg|mp3|mp4|wav|wave|x-wav|ogg|webm|flac|x-flac|aac))$/i;
function sanitize(value,secret=''){
 const seen=new WeakSet();
 function visit(v,k=''){
  if(sensitive.test(k))return '[已隐藏]';
  if(typeof v==='string'){
   if(secret){v=v.split(secret).join('[已隐藏]').split(encodeURIComponent(secret)).join('[已隐藏]');}
   v=v.replace(/\bsk-[A-Za-z0-9_-]{8,}/g,'[已隐藏]').replace(/(Bearer\s+)[^\s"<>]+/gi,'$1[已隐藏]')
    .replace(/([?&](?:api[_-]?key|key|access_token|refresh_token|secret|password)=)[^&#\s"<>]*/gi,'$1[已隐藏]')
    .replace(/((?:authorization|x-api-key|api[_-]?key)\s*[:=]\s*["']?)[^\s"'<>;,}]+/gi,'$1[已隐藏]');
   return v.length>32000?v.slice(0,32000)+'\n[历史记录已截取，完整原始内容请下载当前结果]':v;
  }
  if(!v||typeof v!=='object')return v;
  if(seen.has(v))return '[重复引用]';seen.add(v);
  if(Array.isArray(v))return v.map(x=>visit(x));
  const out={};for(const [key,val] of Object.entries(v))out[key]=visit(val,key);return out;
 }
 return visit(value);
}
function hold(url){holds.set(url,(holds.get(url)||0)+1);}
function unhold(url){const n=(holds.get(url)||1)-1;if(n)holds.set(url,n);else{holds.delete(url);if(deferredRevoke.delete(url))root.URL.revokeObjectURL(url);}}
function releaseMedia(url){if(holds.has(url))deferredRevoke.add(url);else root.URL.revokeObjectURL(url);}
function mimeFor(type,url,mime=''){
 const raw=String(mime).split(';')[0].toLowerCase();if(allowedMime.test(raw)&&raw.startsWith(type+'/'))return raw;
 const ext=String(url).split(/[?#]/)[0].split('.').pop().toLowerCase();
 return ({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',avif:'image/avif',mp4:type==='audio'?'audio/mp4':'video/mp4',webm:type==='audio'?'audio/webm':'video/webm',mov:'video/quicktime',mp3:'audio/mpeg',wav:'audio/wav',ogg:'audio/ogg',flac:'audio/flac',m4a:'audio/mp4',aac:'audio/aac'})[ext]||'';
}
async function blobBase64(blob){
 if(typeof FileReader!=='undefined')return await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('媒体读取失败'));reader.readAsDataURL(blob);});
 const bytes=new Uint8Array(await blob.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));return root.btoa(binary);
}
function mediaWarning(index,reason){return '媒体 '+(index+1)+'：'+reason+'；本次测试文字与请求记录仍会保存。';}
async function prepare(data,secret){
 // Hold object URLs before the first await so clearing cards cannot revoke in-flight media.
 const media=data.media||[],held=media.filter(m=>String(m.url||'').startsWith('blob:')).map(m=>m.url);held.forEach(hold);
 const payload=sanitize({...data,media:[]},secret),notes=[];let total=0;
 try{
  for(let i=0;i<media.length;i++){
   const item=media[i],type=item.type||item.kind,url=String(item.url||'');
   if(!['image','video','audio'].includes(type)){notes.push(mediaWarning(i,'格式不支持保存'));continue;}
   try{
    if(/^https?:/i.test(url)){
     const parsed=new URL(url);
     if(parsed.username||parsed.password||sanitize(url,secret)!==url){notes.push(mediaWarning(i,'链接含敏感参数，已省略'));continue;}
     payload.media.push({type,mime:mimeFor(type,url,item.mime),url:parsed.href});continue;
    }
    let b64,mime,size;
    if(url.startsWith('blob:')){
     const response=await root.fetch(url);if(!response.ok)throw new Error('媒体读取失败');const blob=await response.blob();size=blob.size;mime=mimeFor(type,'',blob.type||item.mime);
     if(size>SINGLE_LIMIT||total+size>TOTAL_LIMIT){notes.push(mediaWarning(i,'超过保存上限（单个 16 MB / 合计 32 MB），请在当前结果下载原文件'));continue;}
     if(!mime){notes.push(mediaWarning(i,'格式不支持保存，请下载原文件'));continue;}b64=await blobBase64(blob);
    }else{
     const match=/^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(url);
     b64=item.b64||match?.[2];mime=mimeFor(type,'',item.mime||match?.[1]);
     if(!b64||!mime){notes.push(mediaWarning(i,'链接或格式不支持保存'));continue;}
     b64=String(b64).replace(/[\r\n]/g,'');
     if(!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)||b64.length%4){notes.push(mediaWarning(i,'媒体编码无效'));continue;}
     size=Math.floor(b64.length*3/4)-(b64.endsWith('==')?2:b64.endsWith('=')?1:0);
     if(size>SINGLE_LIMIT||total+size>TOTAL_LIMIT){notes.push(mediaWarning(i,'超过保存上限（单个 16 MB / 合计 32 MB），请在当前结果下载原文件'));continue;}
    }
    total+=size;payload.media.push({type,mime,b64});
   }catch{notes.push(mediaWarning(i,'读取失败，请在当前结果下载原文件'));}
  }
 }finally{held.forEach(unhold);}
 if(notes.length)payload.result={...payload.result,media_notes:notes};
 return {payload,notes};
}
async function request(path,options={}){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),60000);
 try{const response=await root.fetch(path,{credentials:'same-origin',cache:'no-store',...options,signal:controller.signal});let data;try{data=await response.json();}catch{}if(!response.ok)throw new Error(data?.error||(response.status===401?'登录已失效，请重新登录后重试':'保存服务暂不可用'));if(!data)throw new Error('保存服务返回异常');return data;}
 finally{clearTimeout(timer);}
}
async function getSession(refresh=false){
 if(refresh)session=null;
 if(session)return session;
 if(!sessionRequest)sessionRequest=request('/api/session').then(data=>{session=data;return data;}).finally(()=>{sessionRequest=null;});
 return sessionRequest;
}
function emit(name,detail){if(root.dispatchEvent&&typeof root.CustomEvent==='function')root.dispatchEvent(new root.CustomEvent(name,{detail}));}
function draw(job){
 const box=job.container;if(!box)return;box.className='history-save-status is-'+job.state;box.setAttribute('role','status');box.replaceChildren();
 const label=root.document.createElement('span');label.textContent=job.message;box.append(label);
 if(job.state==='error'){
  const retry=root.document.createElement('button');retry.type='button';retry.className='text-button';retry.textContent='重试保存';retry.addEventListener('click',()=>attempt(job,true));box.append(retry);
 }
 if(job.notes?.length){const note=root.document.createElement('small');note.textContent=job.notes.join(' ');box.append(note);}
}
function state(job,value,message){job.state=value;job.message=message;draw(job);}
async function attempt(job,refresh=false){
 if(job.saving)return job.saving;
 if(refresh&&jobs.get(job.id)!==job){state(job,'local','此任务已有更新结果，请查看最新记录');return;}
 state(job,'saving','正在保存到历史记录…');
 job.saving=(async()=>{
  try{
   const prepared=await job.prepared;job.notes=prepared.notes;
   const sessionData=await getSession(refresh);
   if(sessionData.history_enabled!==true){state(job,'local','仅保留在当前页面 · 当前服务未启用历史记录');return;}
   if(typeof sessionData.token!=='string'||!sessionData.token)throw new Error('会话不可用，请刷新登录后重试');
   const result=await request('/api/history',{method:'POST',headers:{'Content-Type':'application/json','X-Workbench-Token':sessionData.token},body:JSON.stringify(prepared.payload)});
   const id=result.id||result.record?.id||result.item?.id;if(!id)throw new Error('服务未确认保存，请重试');
   job.prepared=null;state(job,'saved',job.notes.length?'记录已保存 · 部分媒体请下载留存':'已保存到历史记录');emit('workbench:history-saved',{id,kind:prepared.payload.kind});
  }catch(error){state(job,'error','历史记录未保存：'+sanitize(error.message||'连接失败，请重试'));}
  finally{job.saving=null;}
 })();return job.saving;
}
function record(data,options={}){
 if(!data||!data.client_id||data.status==='demo')return Promise.resolve(null);
 const id=String(data.client_id),previous=jobs.get(id),job={id,container:options.container,state:'saving',message:'正在保存到历史记录…',notes:[]};
 jobs.set(id,job);
 if(!/^https?:$/.test(root.location?.protocol||'')){state(job,'local','仅保留在当前页面 · 从工作台网址打开可保存历史');return Promise.resolve(job);}
 job.prepared=prepare(data,options.key||'');draw(job);
 // Serialize updates for a video task so an older pending result cannot overwrite completion.
 const before=previous?.promise||Promise.resolve();job.promise=before.catch(()=>{}).then(()=>attempt(job));return job.promise;
}
root.HistoryCapture={record,sanitize,releaseMedia,prepare};
})(typeof window!=='undefined'?window:globalThis);
