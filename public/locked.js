import { hydrateIcons } from './ui.js?v=202610091';
hydrateIcons();
const $ = selector => document.querySelector(selector);
const dialog = $('#unlockDialog'), form = $('#unlockForm'), password = $('#readerPassword'), submit = $('#submitUnlock'), status = $('#unlockStatus');
const slug = document.body.dataset.documentSlug;
let generation = 0, pending = false, controller;
function close() { generation++; controller?.abort(); pending = false; submit.disabled = false; submit.textContent = '验证并阅读'; dialog.close(); }
function open() { status.textContent = ''; status.classList.remove('success'); dialog.showModal(); password.focus(); }
$('#closeUnlock').onclick = close; $('#dismissUnlock').onclick = close; $('#reopenUnlock').onclick = open;
dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
$('#toggleReaderPassword').onclick = event => { const visible = password.type === 'password'; password.type = visible ? 'text' : 'password'; event.currentTarget.textContent = visible ? '隐藏' : '显示'; event.currentTarget.setAttribute('aria-label',visible ? '隐藏访问密码' : '显示访问密码'); event.currentTarget.setAttribute('aria-pressed',String(visible)); };
$('#rememberReader').onchange = event => { $('#rememberHint').textContent = event.target.checked ? '下次打开这份文档可直接阅读。共享设备建议取消勾选。' : '本次访问权限保留 2 小时，之后需重新验证。'; };
form.addEventListener('submit', async event => {
  event.preventDefault(); if (pending) return;
  const ticket = ++generation; pending = true; controller = new AbortController();
  submit.disabled = true; submit.textContent = '正在验证…'; status.textContent = ''; status.classList.remove('success'); password.removeAttribute('aria-invalid');
  try {
    const response = await fetch(`/public/api/documents/${slug}/unlock`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ password:password.value, remember:$('#rememberReader').checked }), credentials:'same-origin', signal:controller.signal });
    const data = await response.json();
    if (ticket !== generation || !dialog.open || document.body.dataset.documentSlug !== slug) return;
    if (!response.ok) { status.textContent = data.error || '连接暂时不可用，请重试。'; password.setAttribute('aria-invalid','true'); password.focus(); return; }
    status.classList.add('success'); status.textContent = '验证成功，正在打开文档…'; password.value = ''; location.reload();
  } catch (error) { if (ticket === generation && dialog.open && error.name !== 'AbortError') status.textContent = '连接暂时不可用，请重试。'; }
  finally { if (ticket === generation) { pending = false; submit.disabled = false; submit.textContent = '验证并阅读'; } }
});
open();
