import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import {parseHTML} from 'linkedom';

async function fixture(fetch) {
  const {document,window}=parseHTML((await fs.readFile('public/locked.html','utf8')).replaceAll('{{SLUG}}','abc123').replaceAll('{{HOME_LINK}}',''));
  const proto=window.HTMLElement.prototype;
  proto.focus=function(){};
  proto.showModal=function(){this.setAttribute('open','');}; proto.close=function(){this.removeAttribute('open');};
  Object.defineProperty(proto,'open',{configurable:true,get(){return this.hasAttribute('open');}});
  let navigations=0;
  const context=vm.createContext({document,fetch,AbortController,hydrateIcons(){},location:{reload(){navigations++;}}});
  vm.runInContext((await fs.readFile('public/locked.js','utf8')).replace(/^import[^\n]+\n/,''),context);
  const $=s=>document.querySelector(s);
  return {$,window,navigations:()=>navigations,submit:()=>$('#unlockForm').dispatchEvent(new window.Event('submit',{cancelable:true}))};
}
const settle=()=>new Promise(r=>setImmediate(r));
test('unlock errors retain input, announce feedback and allow a new attempt',async()=>{
  let count=0;const f=await fixture(async()=>{count++;return {ok:false,json:async()=>({error:'密码不正确，请检查后重试。'})};});
  f.$('#readerPassword').value='wrong';f.submit();await settle();
  assert.equal(count,1);assert.equal(f.$('#readerPassword').value,'wrong');assert.match(f.$('#unlockStatus').textContent,/密码不正确/);assert.equal(f.$('#submitUnlock').disabled,false);assert.equal(f.navigations(),0);
  f.$('#toggleReaderPassword').click();assert.equal(f.$('#readerPassword').type,'text');
  f.submit();await settle();assert.equal(count,2);
});
test('closing during validation suppresses stale navigation and repeated submit',async()=>{
  let complete,count=0;const f=await fixture(()=>{count++;return new Promise(r=>complete=r);});
  f.$('#readerPassword').value='secret123';f.submit();f.submit();assert.equal(count,1);
  f.$('#closeUnlock').click();assert.equal(f.$('#unlockDialog').open,false);
  complete({ok:true,json:async()=>({ok:true})});await settle();assert.equal(f.navigations(),0);
  f.$('#reopenUnlock').click();assert.equal(f.$('#unlockDialog').open,true);assert.equal(f.$('#submitUnlock').disabled,false);
});
test('remember choice reaches the API and successful verification reopens the original URL',async()=>{
  let payload;const f=await fixture(async(_url,options)=>{payload=JSON.parse(options.body);return {ok:true,json:async()=>({ok:true})};});
  f.$('#readerPassword').value='  密码 abc  ';f.$('#rememberReader').checked=false;
  f.$('#rememberReader').dispatchEvent(new f.window.Event('change'));assert.match(f.$('#rememberHint').textContent,/2 小时/);
  f.submit();await settle();assert.equal(payload.remember,false);assert.equal(payload.password,'  密码 abc  ');assert.equal(f.navigations(),1);assert.equal(f.$('#readerPassword').value,'');
});
test('network failure stays locked and exposes a retryable message',async()=>{
  const f=await fixture(async()=>{throw new Error('offline');});f.$('#readerPassword').value='secret123';f.submit();await settle();assert.match(f.$('#unlockStatus').textContent,/连接暂时不可用/);assert.equal(f.$('#unlockDialog').open,true);assert.equal(f.navigations(),0);
});
