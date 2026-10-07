const { app, BrowserWindow, shell, dialog } = require('electron');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL, URLSearchParams } = require('url');

const OJ = 'http://openjudge.cn';
const DEFAULT_GROUP = 'hihocoder';
const GROUP_TOKEN = /^[A-Za-z0-9-]+$/;
const TOKEN = /^[A-Za-z0-9_-]+$/;
const FIELD = /^[A-Za-z0-9_-]{1,40}$/;
const USER_AGENT = 'Mozilla/5.0 OpenJudgeDesktop/1.0';
const STATIC_ROOT = path.join(__dirname, 'app');

let server;
let origin = '';
let cacheRoot = '';
let captchaUrl = null;
let deepseekKey = null;
let deepseekModel = 'deepseek-flash';

class MemoryCookieJar {
  constructor() { this.cookies = []; }

  store(values, requestUrl) {
    const current = new URL(requestUrl);
    for (const raw of values || []) {
      const parts = raw.split(';').map(item => item.trim());
      const split = parts[0].indexOf('=');
      if (split < 1) continue;
      const cookie = {
        name: parts[0].slice(0, split),
        value: parts[0].slice(split + 1),
        domain: current.hostname,
        hostOnly: true,
        path: '/',
        secure: false,
        expires: null,
      };
      for (const attribute of parts.slice(1)) {
        const index = attribute.indexOf('=');
        const name = (index < 0 ? attribute : attribute.slice(0, index)).toLowerCase();
        const value = index < 0 ? '' : attribute.slice(index + 1);
        if (name === 'domain') {
          cookie.domain = value.replace(/^\./, '').toLowerCase();
          cookie.hostOnly = false;
        } else if (name === 'path') cookie.path = value || '/';
        else if (name === 'secure') cookie.secure = true;
        else if (name === 'max-age') cookie.expires = Date.now() + Number(value) * 1000;
        else if (name === 'expires') cookie.expires = Date.parse(value);
      }
      this.cookies = this.cookies.filter(item => !(
        item.name === cookie.name && item.domain === cookie.domain && item.path === cookie.path
      ));
      if (!cookie.expires || cookie.expires > Date.now()) this.cookies.push(cookie);
    }
  }

  header(requestUrl) {
    const target = new URL(requestUrl);
    const now = Date.now();
    this.cookies = this.cookies.filter(cookie => !cookie.expires || cookie.expires > now);
    return this.cookies.filter(cookie => {
      const domainOk = cookie.hostOnly
        ? target.hostname === cookie.domain
        : target.hostname === cookie.domain || target.hostname.endsWith(`.${cookie.domain}`);
      return domainOk && target.pathname.startsWith(cookie.path) && (!cookie.secure || target.protocol === 'https:');
    }).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  }
}

const cookieJar = new MemoryCookieJar();

function remoteRequest(url, options = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = options.body ? Buffer.from(options.body) : null;
    const headers = {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Accept-Encoding': 'identity',
      ...(options.headers || {}),
    };
    const cookie = cookieJar.header(url);
    if (cookie) headers.Cookie = cookie;
    if (body) headers['Content-Length'] = body.length;
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request(target, {
      method: options.method || (body ? 'POST' : 'GET'),
      headers,
      timeout: options.timeout || 15000,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', async () => {
        cookieJar.store(response.headers['set-cookie'], url);
        const status = response.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && response.headers.location && redirects < 8) {
          const next = new URL(response.headers.location, url).toString();
          const keepMethod = status === 307 || status === 308;
          try {
            resolve(await remoteRequest(next, keepMethod ? options : { headers: options.headers }, redirects + 1));
          } catch (error) { reject(error); }
          return;
        }
        resolve({ status, headers: response.headers, body: Buffer.concat(chunks) });
      });
    });
    request.on('timeout', () => request.destroy(new Error('请求超时')));
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function stripText(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return match ? match[1] : '';
}

function groupOrigin(group = DEFAULT_GROUP) {
  const value = String(group || DEFAULT_GROUP).trim().toLowerCase();
  if (!GROUP_TOKEN.test(value)) throw new Error('团队地址格式不正确');
  return `http://${value}.openjudge.cn`;
}

async function fetchWithCache(url, key) {
  const file = path.join(cacheRoot, `${crypto.createHash('sha256').update(key).digest('hex')}.html`);
  let lastError;
  for (const delay of [0, 350, 800]) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    try {
      const response = await remoteRequest(url);
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      if (response.body.length < 500) throw new Error('原站返回了空白页面');
      fs.writeFileSync(file, response.body);
      return { html: response.body.toString('utf8'), cached: false, warning: null };
    } catch (error) { lastError = error; }
  }
  if (fs.existsSync(file)) {
    return { html: fs.readFileSync(file, 'utf8'), cached: true, warning: '原站暂时不可用，已显示上次缓存。' };
  }
  throw lastError || new Error('原站暂时不可用');
}

async function loginState(course = '2021summers6', group = DEFAULT_GROUP) {
  try {
    const response = await remoteRequest(`${groupOrigin(group)}/${course}/`);
    const html = response.body.toString('utf8');
    const loggedIn = !html.includes('auth/login') && (html.includes('/settings/') || /\/user\/\d+\/?/.test(html));
    const user = html.match(/<a[^>]+href=["'][^"']*\/user\/\d+\/?["'][^>]*>([\s\S]*?)<\/a>/i);
    return { loggedIn, user: user ? stripText(user[1]) : null };
  } catch (_) { return { loggedIn: false, user: null }; }
}

async function loginMeta() {
  const response = await remoteRequest(`${OJ}/auth/login/`);
  const html = response.body.toString('utf8');
  const image = html.match(/<img[^>]+src=["']([^"']*(?:captcha|verify|validation|code)[^"']*)["']/i);
  const field = html.match(/<input[^>]+name=["']([^"']*(?:captcha|verify|validation|code)[^"']*)["']/i);
  captchaUrl = image ? new URL(image[1], `${OJ}/auth/login/`).toString() : null;
  return { captcha: Boolean(captchaUrl && field), captchaName: field ? field[1] : null };
}

function problemLinks(html, course, group = DEFAULT_GROUP) {
  const found = [];
  const seen = new Set();
  const anchor = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchor.exec(html))) {
    let target;
    try { target = new URL(match[1], `${groupOrigin(group)}/${course}/`); } catch (_) { continue; }
    const segments = target.pathname.split('/').filter(Boolean);
    if (segments.length !== 2 || segments[0] !== course || !TOKEN.test(segments[1])) continue;
    const id = segments[1];
    if (['status', 'ranking', 'clarify', 'statistics', 'submit'].includes(id) || seen.has(id)) continue;
    const title = stripText(match[2]);
    if (title) { found.push({ id, title }); seen.add(id); }
  }
  return found;
}

function teamDirectory(html) {
  const titleMatch = html.match(/<div[^>]+class=["'][^"']*group-name[^"']*["'][^>]*>[\s\S]*?<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const result = { title: titleMatch ? stripText(titleMatch[1]) : 'OpenJudge 团队', contests: [], practices: [] };
  const item = /<li\b[^>]*class=["'][^"']*(contest-info|practice-info)[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
  let match;
  while ((match = item.exec(html))) {
    const block = match[2];
    const link = block.match(/<a\b[^>]*href=["']\/([A-Za-z0-9_-]+)\/["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const text = stripText(block);
    const count = text.match(/\((\d+)题\)/);
    const meta = block.match(/<span\b[^>]*class=["'][^"']*(?:over-time|recently-update)[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
    const entry = {
      id: link[1],
      title: stripText(link[2]),
      count: count ? Number(count[1]) : null,
      meta: meta ? stripText(meta[1]) : '',
    };
    const target = match[1].toLowerCase() === 'contest-info' ? result.contests : result.practices;
    if (!target.some(existing => existing.id === entry.id)) target.push(entry);
  }
  return result;
}

function submitForm(html) {
  const formMatch = html.match(/<form\b[^>]*id=["']solution_submit["'][^>]*>[\s\S]*?<\/form>/i);
  if (!formMatch) return { action: null, fields: {} };
  const form = formMatch[0];
  const startTag = form.match(/^<form\b[^>]*>/i)?.[0] || '';
  const fields = {};
  for (const match of form.matchAll(/<input\b[^>]*>/gi)) {
    const tag = match[0];
    const name = attribute(tag, 'name');
    const type = (attribute(tag, 'type') || 'text').toLowerCase();
    if (name && (['hidden', 'text'].includes(type) || (type === 'radio' && /\bchecked\b/i.test(tag)))) {
      fields[name] = attribute(tag, 'value');
    }
  }
  return { action: attribute(startTag, 'action'), fields };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const size = Number(request.headers['content-length'] || 0);
    if (size < 1 || size > 2_000_000) return reject(new Error('请求大小不正确'));
    const chunks = [];
    let total = 0;
    request.on('data', chunk => {
      total += chunk.length;
      if (total > 2_000_000) request.destroy(new Error('请求内容过大'));
      else chunks.push(chunk);
    });
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_) { reject(new Error('请求格式不正确')); }
    });
    request.on('error', reject);
  });
}

function json(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': body.length,
  });
  response.end(body);
}

function serveStatic(requestPath, response) {
  const files = { '/': 'index.html', '/index.html': 'index.html', '/results.html': 'results.html' };
  const filename = files[requestPath];
  if (!filename) return json(response, 404, { error: '页面不存在' });
  const body = fs.readFileSync(path.join(STATIC_ROOT, filename));
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length });
  response.end(body);
}

async function handleGet(request, response, url) {
  if (url.pathname === '/api/login/meta') {
    try { return json(response, 200, await loginMeta()); }
    catch (error) { return json(response, 502, { error: error.message }); }
  }
  if (url.pathname === '/api/login/status') {
    const course = url.searchParams.get('course') || '2021summers6';
    const group = url.searchParams.get('group') || DEFAULT_GROUP;
    if (!GROUP_TOKEN.test(group)) return json(response, 400, { error: '团队地址格式不正确' });
    return json(response, 200, await loginState(TOKEN.test(course) ? course : '2021summers6', group));
  }
  if (url.pathname === '/api/deepseek/settings') {
    return json(response, 200, { configured: Boolean(deepseekKey), model: deepseekModel });
  }
  if (url.pathname === '/api/team') {
    try {
      const group = url.searchParams.get('group') || DEFAULT_GROUP;
      const groupUrl = groupOrigin(group);
      const result = await fetchWithCache(`${groupUrl}/`, `team:${group.toLowerCase()}`);
      const directory = teamDirectory(result.html);
      return json(response, 200, { ...directory, group: group.toLowerCase(), cached: result.cached, warning: result.warning });
    } catch (error) { return json(response, GROUP_TOKEN.test(url.searchParams.get('group') || DEFAULT_GROUP) ? 502 : 400, { error: error.message }); }
  }
  if (url.pathname === '/api/captcha') {
    if (!captchaUrl) return json(response, 404, { error: '当前没有验证码' });
    try {
      const remote = await remoteRequest(captchaUrl);
      response.writeHead(remote.status, {
        'Content-Type': remote.headers['content-type'] || 'image/png',
        'Cache-Control': 'no-store',
        'Content-Length': remote.body.length,
      });
      return response.end(remote.body);
    } catch (error) { return json(response, 502, { error: error.message }); }
  }
  if (url.pathname === '/api/problem' || url.pathname === '/api/problems') {
    const group = url.searchParams.get('group') || DEFAULT_GROUP;
    const course = url.searchParams.get('course') || '';
    const id = url.searchParams.get('id') || '';
    if (!GROUP_TOKEN.test(group) || !TOKEN.test(course) || (url.pathname === '/api/problem' && !TOKEN.test(id))) {
      return json(response, 400, { error: '题库或题号格式不正确' });
    }
    try {
      const groupUrl = groupOrigin(group);
      if (url.pathname === '/api/problem') {
        const remoteUrl = `${groupUrl}/${course}/${id}/`;
        const result = await fetchWithCache(remoteUrl, `problem:${group}:${course}:${id}`);
        return json(response, 200, { ...result, url: remoteUrl });
      }
      const result = await fetchWithCache(`${groupUrl}/${course}/`, `list:${group}:${course}`);
      const problems = problemLinks(result.html, course, group);
      if (!problems.length) throw new Error('原站页面中没有找到题目');
      return json(response, 200, { problems, cached: result.cached, warning: result.warning });
    } catch (error) { return json(response, 502, { error: error.message }); }
  }
  if (url.pathname === '/api/submissions' || url.pathname === '/api/submission') {
    const group = url.searchParams.get('group') || DEFAULT_GROUP;
    const course = url.searchParams.get('course') || '';
    if (!GROUP_TOKEN.test(group) || !TOKEN.test(course)) return json(response, 400, { error: '团队或题库格式不正确' });
    const groupUrl = groupOrigin(group);
    const session = await loginState(course, group);
    if (!session.loggedIn) return json(response, 401, { error: '登录状态已失效，请返回主页重新登录' });
    try {
      if (url.pathname === '/api/submissions') {
        const problem = url.searchParams.get('problem') || '';
        if (problem && !TOKEN.test(problem)) return json(response, 400, { error: '题号格式不正确' });
        const parameters = new URLSearchParams({ userName: session.user || '', classId: '0' });
        if (problem) parameters.set('problemNumber', problem);
        const remote = await remoteRequest(`${groupUrl}/${course}/status/?${parameters}`);
        return json(response, 200, { html: remote.body.toString('utf8'), user: session.user });
      }
      const id = url.searchParams.get('id') || '';
      if (!/^\d+$/.test(id)) return json(response, 400, { error: '提交记录编号不正确' });
      const remote = await remoteRequest(`${groupUrl}/${course}/solution/${id}/`);
      if (remote.status === 401) return json(response, 401, { error: '没有权限查看该提交记录' });
      if (remote.status >= 400) return json(response, remote.status, { error: `OpenJudge 返回 HTTP ${remote.status}` });
      return json(response, 200, { html: remote.body.toString('utf8') });
    } catch (error) { return json(response, 502, { error: error.message }); }
  }
  return serveStatic(url.pathname, response);
}

async function handlePost(request, response, url) {
  if (request.headers.origin !== origin) return json(response, 403, { error: '仅允许本地应用调用' });
  let data;
  try { data = await readBody(request); }
  catch (error) { return json(response, 400, { error: error.message }); }

  if (url.pathname === '/api/login') {
    const email = String(data.email || '').trim();
    const group = String(data.group || DEFAULT_GROUP).trim().toLowerCase();
    const course = String(data.course || '2021summers6');
    let password = String(data.password || '');
    const captcha = String(data.captcha || '').trim();
    const captchaName = String(data.captchaName || '').trim();
    if (!email || !password) return json(response, 400, { error: '请输入账号和密码' });
    if (!GROUP_TOKEN.test(group) || !TOKEN.test(course)) return json(response, 400, { error: '团队或题库格式不正确' });
    const form = new URLSearchParams({ redirectUrl: '', email, password });
    if (captcha && FIELD.test(captchaName)) form.set(captchaName, captcha);
    try {
      const remote = await remoteRequest(`${OJ}/api/auth/login/`, {
        method: 'POST',
        body: form.toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
      });
      const session = await loginState(course, group);
      if (session.loggedIn) return json(response, 200, { ok: true, user: session.user });
      const meta = await loginMeta();
      return json(response, 401, {
        ok: false,
        error: stripText(remote.body.toString('utf8')) || `登录失败（HTTP ${remote.status}）`,
        captcha: meta.captcha,
        captchaName: meta.captchaName,
      });
    } catch (error) { return json(response, 502, { error: error.message }); }
    finally { password = ''; }
  }

  if (url.pathname === '/api/deepseek/settings') {
    let apiKey = String(data.apiKey || '').trim();
    const model = String(data.model || 'deepseek-flash');
    if (!['deepseek-flash', 'deepseek-v4-pro'].includes(model)) return json(response, 400, { error: '模型不受支持' });
    if (apiKey) {
      if (apiKey.length > 500) return json(response, 400, { error: 'API Key 格式不正确' });
      deepseekKey = apiKey;
    } else if (!deepseekKey) return json(response, 400, { error: '请输入 DeepSeek API Key' });
    deepseekModel = model;
    apiKey = '';
    return json(response, 200, { ok: true, configured: true, model: deepseekModel });
  }

  if (url.pathname === '/api/translate') {
    const text = String(data.text || '');
    if (!deepseekKey) return json(response, 400, { error: '请先在右上角“设置”中配置 DeepSeek API Key' });
    if (!text.trim() || text.length > 60000) return json(response, 400, { error: '请先加载题目，或题目内容过长' });
    const payload = JSON.stringify({
      model: deepseekModel,
      thinking: { type: 'disabled' },
      messages: [
        { role: 'system', content: '你是专业的算法竞赛题目翻译器。把题目完整翻译成简体中文，准确保留数字、公式、变量名、输入输出格式、样例和限制。不要解题，不要添加解释，只输出结构清晰的译文。' },
        { role: 'user', content: text },
      ],
      max_tokens: 12000,
    });
    try {
      const remote = await remoteRequest('https://api.deepseek.com/chat/completions', {
        method: 'POST', body: payload, timeout: 60000,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deepseekKey}` },
      });
      const result = JSON.parse(remote.body.toString('utf8'));
      if (remote.status >= 400) return json(response, remote.status, { error: result?.error?.message || `DeepSeek 返回 HTTP ${remote.status}` });
      const translation = result?.choices?.[0]?.message?.content || '';
      if (!translation) return json(response, 502, { error: 'DeepSeek 没有返回译文' });
      return json(response, 200, { translation, model: result.model || deepseekModel });
    } catch (error) { return json(response, 502, { error: error.message }); }
  }

  if (url.pathname === '/api/submit') {
    const group = String(data.group || DEFAULT_GROUP).trim().toLowerCase();
    const course = String(data.course || '');
    const problem = String(data.problem || '');
    const language = String(data.language || '');
    const source = String(data.source || '');
    if (!GROUP_TOKEN.test(group) || !TOKEN.test(course) || !TOKEN.test(problem) || !['G++', 'GCC', 'Java', 'Pascal', 'Python3'].includes(language) || !source.trim()) {
      return json(response, 400, { error: '提交参数不正确' });
    }
    try {
      const groupUrl = groupOrigin(group);
      const page = await remoteRequest(`${groupUrl}/${course}/${problem}/submit/`);
      if (page.status === 401) return json(response, 401, { error: '尚未登录，请先在本页登录' });
      const parsed = submitForm(page.body.toString('utf8'));
      if (!parsed.action) return json(response, 401, { error: '登录状态已失效，请重新登录' });
      const form = new URLSearchParams(parsed.fields);
      form.set('language', language);
      form.set('source', Buffer.from(source).toString('base64'));
      const submitUrl = new URL(parsed.action, `${groupUrl}/`).toString();
      const remote = await remoteRequest(submitUrl, {
        method: 'POST', body: form.toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
      });
      const result = remote.body.toString('utf8');
      if (remote.status >= 400) return json(response, remote.status, { error: stripText(result) || `OpenJudge 返回 HTTP ${remote.status}` });
      let message = '已送入评测队列';
      try { const parsedResult = JSON.parse(result); message = parsedResult.message || parsedResult.msg || message; } catch (_) {
        if (result.trim().length > 0 && result.trim().length < 120) message = result.trim();
      }
      const id = result.match(/\/solution\/(\d+)\/?/);
      return json(response, 200, { ok: true, message, solutionId: id ? id[1] : null });
    } catch (error) { return json(response, 502, { error: error.message }); }
  }
  return json(response, 404, { error: '接口不存在' });
}

function createLocalServer(port) {
  return new Promise((resolve, reject) => {
    const candidate = http.createServer(async (request, response) => {
      try {
        const url = new URL(request.url, origin || `http://127.0.0.1:${port}`);
        if (request.method === 'GET') await handleGet(request, response, url);
        else if (request.method === 'POST') await handlePost(request, response, url);
        else json(response, 405, { error: '请求方法不受支持' });
      } catch (error) { json(response, 500, { error: error.message }); }
    });
    candidate.once('error', reject);
    candidate.listen(port, '127.0.0.1', () => resolve(candidate));
  });
}

async function startServer() {
  cacheRoot = path.join(app.getPath('userData'), 'problem-cache');
  fs.mkdirSync(cacheRoot, { recursive: true });
  let lastError;
  for (let port = 18765; port <= 18775; port += 1) {
    try {
      origin = `http://127.0.0.1:${port}`;
      server = await createLocalServer(port);
      return origin;
    } catch (error) { lastError = error; }
  }
  throw lastError || new Error('无法启动本地服务');
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 820,
    minHeight: 620,
    title: 'OpenJudge 刷题台',
    backgroundColor: '#f4f6fa',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  window.loadURL(origin);
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
else {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window) { if (window.isMinimized()) window.restore(); window.focus(); }
  });
  app.whenReady().then(async () => {
    try { await startServer(); createWindow(); }
    catch (error) {
      dialog.showErrorBox('启动失败', `OpenJudge 刷题台无法启动：${error.message}`);
      app.quit();
    }
  });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0 && origin) createWindow(); });
  app.on('before-quit', () => { if (server) server.close(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
