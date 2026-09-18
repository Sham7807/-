(function () {
  'use strict';
  const $ = id => document.getElementById(id), form = $('loginForm'), submit = $('loginSubmit'), message = $('loginMessage');
  let busy = false;
  function notice(text, info) { message.textContent = text; message.classList.toggle('is-info', !!info); message.hidden = !text; }
  if (new URLSearchParams(location.search).has('expired')) notice('登录状态已过期，请重新登录。', true);
  $('togglePassword').addEventListener('click', () => { const visible = $('password').type === 'password'; $('password').type = visible ? 'text' : 'password'; $('togglePassword').textContent = visible ? '隐藏' : '显示'; $('togglePassword').setAttribute('aria-label', visible ? '隐藏密码' : '显示密码'); $('togglePassword').setAttribute('aria-pressed', String(visible)); });
  async function request(path, options) { const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000); try { return await fetch(path, { ...options, signal: controller.signal, credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', ...options?.headers } }); } finally { clearTimeout(timer); } }
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !form.reportValidity()) return;
    busy = true; submit.disabled = true; submit.firstElementChild.textContent = '正在登录…'; notice('');
    try {
      const response = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: $('username').value.trim(), password: $('password').value }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { notice(response.status === 401 ? '账号或密码不正确，请检查后重试。' : response.status === 429 ? '尝试次数较多，请稍后再试。' : (data.error || '暂时无法登录，请稍后重试。')); $('password').focus(); return; }
      $('password').value = ''; location.replace('/');
    } catch (error) { notice(error.name === 'AbortError' ? '连接超时，请检查网络后重试。' : '无法连接工作台，请检查网络后重试。'); }
    finally { busy = false; submit.disabled = false; submit.firstElementChild.textContent = '进入工作台'; }
  });
  request('/api/auth').then(async response => { if (!response.ok || busy) return; const state = await response.json(); if (state.authenticated || state.enabled === false) location.replace('/'); }).catch(() => {});
})();
