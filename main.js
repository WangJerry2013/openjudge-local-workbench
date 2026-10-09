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
const captchaUrls = new Map();
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

  clear() { this.cookies = []; }
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
    const response = await remoteRequest(`${groupOrigin(group)}/`);
    const html = response.body.toString('utf8');
    const loggedIn = !html.includes('auth/login') && (html.includes('/settings/') || /\/user\/\d+\/?/.test(html));
    const user = html.match(/<a[^>]+href=["'][^"']*\/user\/\d+\/?["'][^>]*>([\s\S]*?)<\/a>/i);
    return { loggedIn, user: user ? stripText(user[1]) : null };
  } catch (_) { return { loggedIn: false, user: null }; }
}

async function loginMeta(group = DEFAULT_GROUP) {
  group = String(group || DEFAULT_GROUP).trim().toLowerCase();
  const groupUrl = groupOrigin(group);
  const response = await remoteRequest(`${groupUrl}/auth/login/`);
  const html = response.body.toString('utf8');
  const form = html.match(/<form\b[^>]*action=["'][^"']*\/api\/auth\/login\/[^"']*["'][^>]*>[\s\S]*?<\/form>/i)?.[0] || html;
  let field = form.match(/<input[^>]+name=["']([^"']*(?:captcha|verify|validation|code)[^"']*)["']/i);
  if (!field) {
    for (const tag of form.match(/<input\b[^>]*>/gi) || []) {
      const name = attribute(tag, 'name');
      const type = (attribute(tag, 'type') || 'text').toLowerCase();
      if (name && !['email', 'password', 'redirectUrl'].includes(name) && ['text', 'number', 'tel'].includes(type)) {
        field = [tag, name];
        break;
      }
    }
  }
  let image = form.match(/<img[^>]+src=["']([^"']*(?:captcha|verify|validation|code)[^"']*)["']/i);
  if (!image && field) image = form.match(/<img[^>]+src=["']([^"']+)["']/i);
  const captchaUrl = image ? new URL(image[1], `${groupUrl}/auth/login/`).toString() : null;
  captchaUrls.set(group, captchaUrl);
  const interactive = /g-recaptcha|h-captcha|cf-turnstile|turnstile/i.test(form);
  return { captcha: Boolean(captchaUrl && field), captchaName: field ? field[1] : null, interactive, officialUrl: `${groupUrl}/auth/login/` };
}

function loginMessage(body, status) {
  const text = body.toString('utf8');
  try {
    const result = JSON.parse(text);
    const message = result?.message || result?.msg || result?.error;
    if (typeof message === 'string' && message.trim()) return message.trim();
  } catch (_) {}
  return stripText(text) || `登录失败（HTTP ${status}）`;
}

function problemLinks(html, course, group = DEFAULT_GROUP) {
  const found = [];
  const seen = new Set();
  const titles = new Map();
  const row = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = row.exec(html))) {
    const idMatch = rowMatch[1].match(new RegExp(`<td\\b[^>]*class=["'][^"']*\\bproblem-id\\b[^"']*["'][^>]*>[\\s\\S]*?<a\\b[^>]*href=["'](?:/)?${course}/([A-Za-z0-9_-]+)/`, 'i'));
    const titleMatch = rowMatch[1].match(/<td\b[^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*>[\s\S]*?<a\b[^>]*>([\s\S]*?)<\/a>/i);
    const title = titleMatch ? stripText(titleMatch[1]) : '';
    if (idMatch && title) titles.set(idMatch[1], title);
  }
  const anchor = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchor.exec(html))) {
    let target;
    try { target = new URL(match[1], `${groupOrigin(group)}/${course}/`); } catch (_) { continue; }
    const segments = target.pathname.split('/').filter(Boolean);
    if (segments.length !== 2 || segments[0] !== course || !TOKEN.test(segments[1])) continue;
    const id = segments[1];
    if (['status', 'ranking', 'clarify', 'statistics', 'submit'].includes(id) || seen.has(id)) continue;
    const title = titles.get(id) || stripText(match[2]);
    if (title) { found.push({ id, title }); seen.add(id); }
  }
  return found;
}

function teamDirectory(html) {
  const titleMatch = html.match(/<div[^>]+class=["'][^"']*group-name[^"']*["'][^>]*>[\s\S]*?<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const join = html.match(/api\.joinGroup\(\s*(\d+)/i);
  const leave = html.match(/api\.leaveGroup\(\s*(\d+)/i);
  const result = { title: titleMatch ? stripText(titleMatch[1]) : 'OpenJudge 团队', contests: [], practices: [], groupId: Number((leave || join)?.[1]) || null, membership: leave ? 'member' : join ? 'available' : 'unknown' };
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
  // Older team templates keep the standalone practice set outside of a
  // practice-info list item.  It still has its own /practice/ collection.
  if (!result.practices.some(item => item.id === 'practice')) {
    const practiceLink = html.match(/<a\b[^>]*href=["']\/practice\/["'][^>]*>([\s\S]*?)<\/a>([^<]{0,80})/i);
    if (practiceLink) {
      const count = stripText(practiceLink[2]).match(/\((\d+)题\)/);
      result.practices.push({ id: 'practice', title: stripText(practiceLink[1]) || '练习', count: count ? Number(count[1]) : null, meta: '' });
    }
  }
  // Older contests are plain list items on a team home page, but table rows
  // on /contests/past; neither format carries the contest-info class.
  const addContest = (id, title, meta = '') => {
    if (!result.contests.some(existing => existing.id === id)) result.contests.push({ id, title: stripText(title), count: null, meta: stripText(meta) });
  };
  for (const section of html.matchAll(/<div\b[^>]*class=["'][^"']*(?:past-contest|coming-contest)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi)) {
    for (const old of section[1].matchAll(/<li\b[^>]*>\s*<a\b[^>]*href=["']\/([A-Za-z0-9_-]+)\/["'][^>]*>([\s\S]*?)<\/a>([\s\S]*?)<\/li>/gi)) addContest(old[1], old[2], old[3]);
  }
  for (const old of html.matchAll(/<td\b[^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*>\s*<a\b[^>]*href=["']\/([A-Za-z0-9_-]+)\/["'][^>]*>([\s\S]*?)<\/a>/gi)) addContest(old[1], old[2]);
  return result;
}

function mergeTeamDirectory(target, source) {
  for (const key of ['contests', 'practices']) {
    for (const entry of source[key] || []) if (!target[key].some(item => item.id === entry.id)) target[key].push(entry);
  }
  return target;
}

async function teamCatalog(group) {
  const groupUrl = groupOrigin(group);
  const pending = [`${groupUrl}/`], seen = new Set(), warnings = [];
  let directory = null, cached = false;
  while (pending.length && seen.size < 40) {
    const remoteUrl = pending.shift();
    if (seen.has(remoteUrl)) continue;
    seen.add(remoteUrl);
    const result = await fetchWithCache(remoteUrl, `team-page:${group}:${remoteUrl}`);
    cached ||= result.cached;
    if (result.warning) warnings.push(result.warning);
    const parsed = teamDirectory(result.html);
    directory = directory ? mergeTeamDirectory(directory, parsed) : parsed;
    for (const match of result.html.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)) {
      const candidate = new URL(match[1], remoteUrl);
      if (candidate.origin === groupUrl && /^\/contests\/(?:past|coming)\/?$/.test(candidate.pathname) && !seen.has(candidate.toString())) pending.push(candidate.toString());
    }
  }
  if (!directory) throw new Error('没有读取到团队目录');
  directory.contests.sort((left, right) => left.id.localeCompare(right.id));
  directory.practices.sort((left, right) => left.id.localeCompare(right.id));
  return { directory, cached, warning: [...new Set(warnings)].join('；') || null };
}

async function teamChange(group, action) {
  const groupUrl = groupOrigin(group), session = await loginState('2021summers6', group);
  if (!session.loggedIn) throw Object.assign(new Error('登录状态已失效，请先在本页登录'), { status: 401 });
  const home = await remoteRequest(`${groupUrl}/`), directory = teamDirectory(home.body.toString('utf8'));
  if (!directory.groupId) throw new Error('官网页面没有提供团队操作入口');
  if (action === 'join' && directory.membership === 'member') return { changed: false, directory };
  if (action === 'leave' && directory.membership !== 'member') throw new Error('当前账号并未加入此团队');
  const remote = await remoteRequest(`${groupUrl}/api/group/${action === 'join' ? 'join' : 'leave'}/`, {
    method: 'POST', body: new URLSearchParams({ groupId: String(directory.groupId) }).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest', Origin: groupUrl, Referer: `${groupUrl}/` },
  });
  const text = remote.body.toString('utf8');
  if (remote.status >= 400) throw new Error(stripText(text) || `OpenJudge 返回 HTTP ${remote.status}`);
  try { const payload = JSON.parse(text); if (payload?.error) throw new Error(String(payload.error)); } catch (error) { if (error instanceof SyntaxError) {} else throw error; }
  return { changed: true, directory };
}

async function ensureTeamMember(group) {
  const groupUrl = groupOrigin(group), home = await remoteRequest(`${groupUrl}/`);
  if (teamDirectory(home.body.toString('utf8')).membership !== 'available') return false;
  return (await teamChange(group, 'join')).changed;
}

function submitForm(html) {
  const forms = html.match(/<form\b[^>]*>[\s\S]*?<\/form>/gi) || [];
  const form = forms.find(candidate => {
    const startTag = candidate.match(/^<form\b[^>]*>/i)?.[0] || '';
    const action = attribute(startTag, 'action') || '';
    const marker = `${attribute(startTag, 'id') || ''} ${attribute(startTag, 'class') || ''} ${action}`.toLowerCase();
    return action.toLowerCase().includes('/api/solution/') || (marker.includes('solution') && marker.includes('submit'));
  });
  if (!form) return { action: null, fields: {} };
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

function isLoginPage(html) {
  return /\/auth\/login\//i.test(html) && /name=["']password["']/i.test(html);
}

function responseSolutionId(text) {
  const fromUrl = text.match(/\/solution\/(\d+)\/?/);
  if (fromUrl) return fromUrl[1];
  try {
    const visit = (value, key = '') => {
      if (Array.isArray(value)) return value.map(item => visit(item, key)).find(Boolean) || null;
      if (value && typeof value === 'object') return Object.entries(value).map(([name, item]) => visit(item, name.toLowerCase())).find(Boolean) || null;
      if (['solutionid', 'solution_id', 'solution'].includes(key) && /^\d+$/.test(String(value))) return String(value);
      if (['url', 'redirect', 'redirecturl'].includes(key)) return String(value).match(/\/solution\/(\d+)\/?/)?.[1] || null;
      return null;
    };
    return visit(JSON.parse(text));
  } catch (_) { return null; }
}

async function submissionIds(group, course, problem, user) {
  const parameters = new URLSearchParams({ userName: user || '', classId: '0', problemNumber: problem });
  const remote = await remoteRequest(`${groupOrigin(group)}/${course}/status/?${parameters}`);
  return new Set([...remote.body.toString('utf8').matchAll(/\/solution\/(\d+)\/?/g)].map(match => match[1]));
}

async function waitForNewSolution(group, course, problem, user, before) {
  for (const delay of [250, 500, 800, 1200, 1800, 2500]) {
    await new Promise(resolve => setTimeout(resolve, delay));
    try {
      const ids = await submissionIds(group, course, problem, user);
      const fresh = [...ids].filter(id => !before.has(id));
      if (fresh.length) return fresh.sort((left, right) => Number(right) - Number(left))[0];
    } catch (_) {}
  }
  return null;
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
  if (requestPath.startsWith('/api/')) return json(response, 404, { error: '接口不存在' });
  const files = { '/': 'index.html', '/home': 'index.html', '/index.html': 'index.html', '/results.html': 'results.html', '/ranking.html': 'ranking.html' };
  const filename = files[requestPath]
    || (/^\/[a-z0-9-]+\/[A-Za-z0-9_-]+\/?$/.test(requestPath) ? 'index.html' : null)
    || (/^\/results\/[a-z0-9-]+\/[A-Za-z0-9_-]+\/?$/.test(requestPath) ? 'results.html' : null)
    || (/^\/ranking\/[a-z0-9-]+\/[A-Za-z0-9_-]+\/?$/.test(requestPath) ? 'ranking.html' : null);
  if (!filename) return json(response, 404, { error: '页面不存在' });
  const body = fs.readFileSync(path.join(STATIC_ROOT, filename));
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length });
  response.end(body);
}

async function handleGet(request, response, url) {
  if (url.pathname === '/api/login/meta') {
    try { return json(response, 200, await loginMeta(url.searchParams.get('group') || DEFAULT_GROUP)); }
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
      const result = await teamCatalog(group);
      return json(response, 200, { ...result.directory, group: group.toLowerCase(), cached: result.cached, warning: result.warning });
    } catch (error) { return json(response, GROUP_TOKEN.test(url.searchParams.get('group') || DEFAULT_GROUP) ? 502 : 400, { error: error.message }); }
  }
  if (url.pathname === '/api/ranking') {
    const group = url.searchParams.get('group') || DEFAULT_GROUP;
    const course = url.searchParams.get('course') || '';
    if (!GROUP_TOKEN.test(group) || !TOKEN.test(course)) return json(response, 400, { error: '团队或比赛地址格式不正确' });
    try {
      const remoteUrl = `${groupOrigin(group)}/${course}/ranking/`;
      const result = await fetchWithCache(remoteUrl, `ranking:${group}:${course}`);
      return json(response, 200, { ...result, url: remoteUrl });
    } catch (error) { return json(response, 502, { error: error.message }); }
  }
  if (url.pathname === '/api/captcha') {
    const group = url.searchParams.get('group') || DEFAULT_GROUP;
    if (!GROUP_TOKEN.test(group)) return json(response, 400, { error: '团队地址格式不正确' });
    const captchaUrl = captchaUrls.get(group);
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
      const groupUrl = groupOrigin(group);
      const remote = await remoteRequest(`${groupUrl}/api/auth/login/`, {
        method: 'POST',
        body: form.toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest', Origin: groupUrl, Referer: `${groupUrl}/auth/login/` },
      });
      const session = await loginState(course, group);
      if (session.loggedIn) return json(response, 200, { ok: true, user: session.user });
      const meta = await loginMeta(group);
      return json(response, 401, {
        ok: false,
        error: loginMessage(remote.body, remote.status),
        captcha: meta.captcha,
        captchaName: meta.captchaName,
        interactive: meta.interactive,
        officialUrl: meta.officialUrl,
      });
    } catch (error) { return json(response, 502, { error: error.message }); }
    finally { password = ''; }
  }

  if (url.pathname === '/api/logout') {
    const group = String(data.group || DEFAULT_GROUP).trim().toLowerCase();
    if (!GROUP_TOKEN.test(group)) return json(response, 400, { error: '团队地址格式不正确' });
    let warning = null;
    try {
      const groupUrl = groupOrigin(group);
      await remoteRequest(`${groupUrl}/api/auth/logout/`, {
        method: 'POST', body: '',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest', Origin: groupUrl, Referer: `${groupUrl}/` },
      });
    } catch (error) {
      warning = `官网注销请求暂时失败，但本地登录状态已清除：${error.message}`;
    } finally { cookieJar.clear(); }
    return json(response, 200, { ok: true, warning });
  }

  if (url.pathname === '/api/team/join' || url.pathname === '/api/team/leave') {
    const group = String(data.group || DEFAULT_GROUP).trim().toLowerCase();
    const action = url.pathname.endsWith('/join') ? 'join' : 'leave';
    if (!GROUP_TOKEN.test(group)) return json(response, 400, { error: '团队地址格式不正确' });
    try {
      const result = await teamChange(group, action);
      return json(response, 200, { ok: true, changed: result.changed, group, membership: action === 'join' ? 'member' : 'available', title: result.directory.title });
    } catch (error) { return json(response, error.status || 502, { error: error.message }); }
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
      const session = await loginState(course, group);
      if (!session.loggedIn) return json(response, 401, { error: '尚未登录，请先在本页登录' });
      const joinedTeam = await ensureTeamMember(group);
      const page = await remoteRequest(`${groupUrl}/${course}/${problem}/submit/`);
      if (page.status === 401) return json(response, 401, { error: '尚未登录，请先在本页登录' });
      const submitPage = page.body.toString('utf8');
      if (isLoginPage(submitPage)) return json(response, 401, { error: '官网没有保存登录状态，请重新登录后再试' });
      const parsed = submitForm(submitPage);
      if (!parsed.action) return json(response, 502, { error: '已登录，但未能识别官网的提交表单；请刷新题目后重试' });
      let before = new Set();
      if (session.loggedIn) {
        try { before = await submissionIds(group, course, problem, session.user); } catch (_) {}
      }
      const form = new URLSearchParams(parsed.fields);
      form.set('language', language);
      form.set('source', Buffer.from(source).toString('base64'));
      const submitUrl = new URL(parsed.action, `${groupUrl}/`).toString();
      const remote = await remoteRequest(submitUrl, {
        method: 'POST', body: form.toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest', Origin: groupUrl, Referer: `${groupUrl}/${course}/${problem}/submit/` },
      });
      const result = remote.body.toString('utf8');
      if (remote.status >= 400) return json(response, remote.status, { error: stripText(result) || `OpenJudge 返回 HTTP ${remote.status}` });
      let message = '已送入评测队列';
      try { const parsedResult = JSON.parse(result); message = parsedResult.message || parsedResult.msg || message; } catch (_) {
        if (result.trim().length > 0 && result.trim().length < 120) message = result.trim();
      }
      let solutionId = responseSolutionId(result);
      if (!solutionId && session.loggedIn) solutionId = await waitForNewSolution(group, course, problem, session.user, before);
      return json(response, 200, { ok: true, message, solutionId, joinedTeam });
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
