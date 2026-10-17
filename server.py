#!/usr/bin/env python3
import argparse, base64, hashlib, json, re, threading, time, webbrowser
from html import unescape
from html.parser import HTMLParser
from http.cookiejar import CookieJar
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlencode, urljoin, urlparse
from urllib.request import HTTPCookieProcessor, Request, build_opener

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / "cache"
CACHE.mkdir(exist_ok=True)
TOKEN = re.compile(r"^[A-Za-z0-9_-]+$")
FIELD = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
OJ = "http://openjudge.cn"
DEFAULT_GROUP = "hihocoder"
GROUP_TOKEN = re.compile(r"^[A-Za-z0-9-]+$")
JAR = CookieJar()
OPENER = build_opener(HTTPCookieProcessor(JAR))
NET_LOCK = threading.RLock()
CAPTCHA_URLS = {}
DEEPSEEK_KEY = None
DEEPSEEK_MODEL = "deepseek-flash"
UA = "Mozilla/5.0 OpenJudgeLocal/1.0"

def group_origin(group=DEFAULT_GROUP):
    value = str(group or DEFAULT_GROUP).strip().lower()
    if not GROUP_TOKEN.fullmatch(value): raise ValueError("团队地址格式不正确")
    return f"http://{value}.openjudge.cn"

def request(url, data=None, headers=None, timeout=15):
    merged = {"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9"}
    if headers: merged.update(headers)
    req = Request(url, data=data, headers=merged)
    with NET_LOCK, OPENER.open(req, timeout=timeout) as response:
        return response.status, response.headers, response.read()

def fetch(url, key):
    path = CACHE / (hashlib.sha256(key.encode()).hexdigest() + ".html")
    last = None
    for delay in (0, .35, .8):
        if delay: time.sleep(delay)
        try:
            status, _, body = request(url)
            if status != 200: raise RuntimeError(f"HTTP {status}")
            if len(body) < 500: raise RuntimeError("原站返回了空白页面")
            path.write_bytes(body)
            return body.decode("utf-8", "replace"), False, None
        except Exception as error: last = error
    if path.exists(): return path.read_text("utf-8"), True, "原站暂时不可用，已显示上次缓存。"
    raise RuntimeError(str(last) or "原站暂时不可用")

def text_only(value):
    value = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", " ", value, flags=re.I)
    return " ".join(unescape(re.sub(r"<[^>]+>", " ", value)).split())[:240]

def login_state(course="2021summers6", group=DEFAULT_GROUP):
    try:
        _, _, body = request(f"{group_origin(group)}/")
        html = body.decode("utf-8", "replace")
        logged = "auth/login" not in html and ("/settings/" in html or re.search(r"/user/\d+/?", html))
        match = re.search(r'<a[^>]+href=["\'][^"\']*/user/\d+/?["\'][^>]*>([^<]+)</a>', html, re.I)
        return bool(logged), text_only(match.group(1)) if match else None
    except Exception: return False, None

class ProblemLinks(HTMLParser):
    def __init__(self, course): super().__init__(); self.course=course; self.links=[]; self.current=None; self.text=[]
    def handle_starttag(self, tag, attrs):
        if tag != "a": return
        href = dict(attrs).get("href", "")
        match = re.fullmatch(rf"(?:/)?{re.escape(self.course)}/([A-Za-z0-9_-]+)/", href) or re.fullmatch(r"([A-Za-z0-9_-]+)/", href)
        if match and match.group(1) not in {"status","ranking","clarify","statistics","submit"}: self.current=match.group(1); self.text=[]
    def handle_data(self, data):
        if self.current: self.text.append(data)
    def handle_endtag(self, tag):
        if tag == "a" and self.current:
            title=" ".join("".join(self.text).split())
            if title and not any(item["id"]==self.current for item in self.links): self.links.append({"id":self.current,"title":title})
            self.current=None; self.text=[]

def listed_problem_titles(html, course):
    """Read the separate title column used by OpenJudge problem tables."""
    titles={}
    for row in re.findall(r'<tr\b[^>]*>([\s\S]*?)</tr>',html,re.I):
        identifier=re.search(rf'<td\b[^>]*class=["\'][^"\']*\bproblem-id\b[^"\']*["\'][^>]*>[\s\S]*?<a\b[^>]*href=["\'](?:/)?{re.escape(course)}/([A-Za-z0-9_-]+)/',row,re.I)
        title=re.search(r'<td\b[^>]*class=["\'][^"\']*\btitle\b[^"\']*["\'][^>]*>[\s\S]*?<a\b[^>]*>([\s\S]*?)</a>',row,re.I)
        if identifier and title:
            value=text_only(title.group(1))
            if value: titles[identifier.group(1)]=value
    return titles

def team_directory(html):
    title_match=re.search(r'<div[^>]+class=["\'][^"\']*group-name[^"\']*["\'][^>]*>[\s\S]*?<h1[^>]*>([\s\S]*?)</h1>',html,re.I)
    join_match=re.search(r"api\.joinGroup\(\s*(\d+)",html,re.I)
    leave_match=re.search(r"api\.leaveGroup\(\s*(\d+)",html,re.I)
    result={"title":text_only(title_match.group(1)) if title_match else "OpenJudge 团队","contests":[],"practices":[],"groupId":int((leave_match or join_match).group(1)) if (leave_match or join_match) else None,"membership":"member" if leave_match else "available" if join_match else "unknown"}
    pattern=re.compile(r'<li\b[^>]*class=["\'][^"\']*(contest-info|practice-info)[^"\']*["\'][^>]*>([\s\S]*?)</li>',re.I)
    for kind,block in pattern.findall(html):
        link=re.search(r'<a\b[^>]*href=["\']/([A-Za-z0-9_-]+)/["\'][^>]*>([\s\S]*?)</a>',block,re.I)
        if not link: continue
        text=text_only(block);count=re.search(r'\((\d+)题\)',text);meta=re.search(r'<span\b[^>]*class=["\'][^"\']*(?:over-time|recently-update)[^"\']*["\'][^>]*>([\s\S]*?)</span>',block,re.I)
        entry={"id":link.group(1),"title":text_only(link.group(2)),"count":int(count.group(1)) if count else None,"meta":text_only(meta.group(1)) if meta else ""}
        target=result["contests" if kind.lower()=="contest-info" else "practices"]
        if not any(item["id"]==entry["id"] for item in target): target.append(entry)
    # Some older team templates render the standalone practice set outside of
    # a ``practice-info`` item.  It is still a separate collection at
    # /practice/, so retain it in the directory rather than losing it.
    if not any(item["id"]=="practice" for item in result["practices"]):
        practice_link=re.search(r'<a\b[^>]*href=["\']/practice/["\'][^>]*>([\s\S]*?)</a>([^<]{0,80})',html,re.I)
        if practice_link:
            trailing=text_only(practice_link.group(2))
            count=re.search(r'\((\d+)题\)',trailing)
            result["practices"].append({"id":"practice","title":text_only(practice_link.group(1)) or "练习","count":int(count.group(1)) if count else None,"meta":""})
    # The team home page lists older contests in a plain ``past-contest``
    # list, while /contests/past renders them in a table.  Neither uses the
    # contest-info class above, so collect both formats as well.
    def add_contest(identifier, title, meta=""):
        entry={"id":identifier,"title":text_only(title),"count":None,"meta":text_only(meta)}
        if not any(item["id"]==identifier for item in result["contests"]): result["contests"].append(entry)
    sections=re.findall(r'<div\b[^>]*class=["\'][^"\']*(?:past-contest|coming-contest)[^"\']*["\'][^>]*>([\s\S]*?)</div>',html,re.I)
    for section in sections:
        for identifier,title,meta in re.findall(r'<li\b[^>]*>\s*<a\b[^>]*href=["\']/([A-Za-z0-9_-]+)/["\'][^>]*>([\s\S]*?)</a>([\s\S]*?)</li>',section,re.I):
            add_contest(identifier,title,meta)
    for identifier,title in re.findall(r'<td\b[^>]*class=["\'][^"\']*\btitle\b[^"\']*["\'][^>]*>\s*<a\b[^>]*href=["\']/([A-Za-z0-9_-]+)/["\'][^>]*>([\s\S]*?)</a>',html,re.I):
        add_contest(identifier,title)
    return result

def merge_team_directory(target, source):
    for key in ("contests","practices"):
        for entry in source.get(key,[]):
            if not any(item["id"]==entry["id"] for item in target[key]):target[key].append(entry)
    return target

def team_catalog(group):
    origin=group_origin(group);pending=[f"{origin}/"];seen=set();result=None;warnings=[];cached=False
    while pending and len(seen)<40:
        url=pending.pop(0)
        if url in seen:continue
        seen.add(url)
        html,used_cache,warning=fetch(url,f"team-page:{group}:{url}")
        cached=cached or used_cache
        if warning:warnings.append(warning)
        directory=team_directory(html)
        if result is None:result=directory
        else:merge_team_directory(result,directory)
        for href in re.findall(r'<a\b[^>]*href=["\']([^"\']*(?:contests/(?:past|coming))[^"\']*)["\']',html,re.I):
            candidate=urljoin(url,href);parts=urlparse(candidate)
            if parts.netloc==urlparse(origin).netloc and re.fullmatch(r"/contests/(?:past|coming)/?",parts.path) and candidate not in seen:pending.append(candidate)
        # Pagination links normally point back to the current past/coming
        # route with a query string, so retain the query while crawling.
        for href in re.findall(r'<a\b[^>]*href=["\']([^"\']+)["\']',html,re.I):
            candidate=urljoin(url,href);parts=urlparse(candidate)
            if parts.netloc==urlparse(origin).netloc and re.fullmatch(r"/contests/(?:past|coming)/?",parts.path) and candidate not in seen:pending.append(candidate)
    if result is None:raise RuntimeError("没有读取到团队目录")
    # Keep OpenJudge's source order: its team pages place newly added
    # collections first.  Sorting by identifier buried recent题单 among old ones.
    return result,cached,"；".join(dict.fromkeys(warnings)) or None

def team_change(group, action):
    origin=group_origin(group);logged,_=login_state(group=group)
    if not logged:raise PermissionError("登录状态已失效，请先在本页登录")
    _,_,body=request(f"{origin}/")
    directory=team_directory(body.decode("utf-8","replace"));group_id=directory.get("groupId")
    if not group_id:raise RuntimeError("官网页面没有提供团队操作入口")
    if action=="join" and directory["membership"]=="member":return False,directory
    if action=="leave" and directory["membership"]!="member":raise RuntimeError("当前账号并未加入此团队")
    data=urlencode({"groupId":str(group_id)}).encode();endpoint="join" if action=="join" else "leave"
    try:status,_,response=request(f"{origin}/api/group/{endpoint}/",data,{"Content-Type":"application/x-www-form-urlencoded","X-Requested-With":"XMLHttpRequest","Origin":origin,"Referer":f"{origin}/"})
    except HTTPError as error:status=error.code;response=error.read()
    text=response.decode("utf-8","replace")
    if status>=400:raise RuntimeError(text_only(text) or f"OpenJudge 返回 HTTP {status}")
    try:
        payload=json.loads(text)
        if isinstance(payload,dict) and payload.get("error"):raise RuntimeError(str(payload["error"]))
    except json.JSONDecodeError:pass
    return True,directory

def ensure_team_member(group):
    origin=group_origin(group);_,_,body=request(f"{origin}/")
    directory=team_directory(body.decode("utf-8","replace"))
    if directory["membership"]!="available":return False
    changed,_=team_change(group,"join")
    return changed

class SubmitForm(HTMLParser):
    def __init__(self): super().__init__(); self.inside=False; self.action=None; self.fields={}
    def handle_starttag(self, tag, attrs):
        values=dict(attrs)
        if tag=="form":
            action=values.get("action","")
            marker=f"{values.get('id','')} {values.get('class','')} {action}".lower()
            if "/api/solution/" in action.lower() or ("solution" in marker and "submit" in marker):
                self.inside=True;self.action=action
        elif self.inside and tag=="input" and values.get("name"):
            kind=values.get("type","text").lower()
            if kind in {"hidden","text"} or (kind=="radio" and "checked" in values): self.fields[values["name"]]=values.get("value","")
    def handle_endtag(self, tag):
        if tag=="form" and self.inside: self.inside=False

def login_meta(group=DEFAULT_GROUP):
    group = str(group or DEFAULT_GROUP).strip().lower()
    origin = group_origin(group)
    _, _, body = request(f"{origin}/auth/login/")
    html = body.decode("utf-8", "replace")
    form = re.search(r'<form\b[^>]*action=["\'][^"\']*/api/auth/login/[^"\']*["\'][^>]*>[\s\S]*?</form>', html, re.I)
    scope = form.group(0) if form else html
    field = re.search(r'<input[^>]+name=["\']([^"\']*(?:captcha|verify|validation|code)[^"\']*)["\']', scope, re.I)
    if not field:
        for tag in re.findall(r'<input\b[^>]*>', scope, re.I):
            name = re.search(r'\bname=["\']([^"\']+)["\']', tag, re.I)
            kind = re.search(r'\btype=["\']([^"\']+)["\']', tag, re.I)
            if name and name.group(1) not in {"email", "password", "redirectUrl"} and (not kind or kind.group(1).lower() in {"text", "number", "tel"}):
                field = name
                break
    image = re.search(r'<img[^>]+src=["\']([^"\']*(?:captcha|verify|validation|code)[^"\']*)["\']', scope, re.I)
    if not image and field:
        image = re.search(r'<img[^>]+src=["\']([^"\']+)["\']', scope, re.I)
    captcha_url = urljoin(f"{origin}/auth/login/", image.group(1)) if image else None
    CAPTCHA_URLS[group] = captcha_url
    interactive = bool(re.search(r'g-recaptcha|h-captcha|cf-turnstile|turnstile', scope, re.I))
    return {"captcha": bool(captcha_url and field), "captchaName": field.group(1) if field else None, "interactive": interactive, "officialUrl": f"{origin}/auth/login/"}

def login_message(body, status):
    text = body.decode("utf-8", "replace")
    try:
        result = json.loads(text)
        if isinstance(result, dict):
            message = result.get("message") or result.get("msg") or result.get("error")
            if isinstance(message, str) and message.strip(): return message.strip()
    except Exception:
        pass
    return text_only(text) or f"登录失败（HTTP {status}）"

def response_solution_id(text):
    """Read a solution id from either OpenJudge's JSON response or a redirect URL."""
    match=re.search(r"/solution/(\d+)/?",text)
    if match:return match.group(1)
    try: payload=json.loads(text)
    except Exception:return None
    def visit(value, key=""):
        if isinstance(value,dict):
            for name,item in value.items():
                found=visit(item,name.lower())
                if found:return found
        elif isinstance(value,list):
            for item in value:
                found=visit(item,key)
                if found:return found
        elif key in {"solutionid","solution_id","solution"} and re.fullmatch(r"\d+",str(value)):
            return str(value)
        elif key in {"url","redirect","redirecturl"}:
            found=re.search(r"/solution/(\d+)/?",str(value))
            if found:return found.group(1)
        return None
    return visit(payload)

def submission_ids(origin, course, problem, user):
    params={"userName":user or "","classId":"0","problemNumber":problem}
    _,_,body=request(f"{origin}/{course}/status/?{urlencode(params)}")
    return set(re.findall(r"/solution/(\d+)/?",body.decode("utf-8","replace")))

def wait_for_new_solution(origin, course, problem, user, before):
    """The submit API often has no id; wait briefly for the new status row instead."""
    for delay in (0.25,0.5,0.8,1.2,1.8,2.5):
        time.sleep(delay)
        try:
            fresh=submission_ids(origin,course,problem,user)-before
            if fresh:return max(fresh,key=int)
        except Exception:
            pass
    return None

def is_login_page(html):
    return bool(re.search(r"/auth/login/",html,re.I) and re.search(r"name=[\"']password[\"']",html,re.I))

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs): super().__init__(*args, directory=str(ROOT), **kwargs)
    def reply(self, status, payload):
        body=json.dumps(payload,ensure_ascii=False).encode();self.send_response(status);self.send_header("Content-Type","application/json; charset=utf-8");self.send_header("Cache-Control","no-store");self.send_header("Content-Length",str(len(body)));self.end_headers();self.wfile.write(body)
    def read_json(self):
        size=int(self.headers.get("Content-Length","0"))
        if size<1 or size>2_000_000: raise ValueError("请求大小不正确")
        return json.loads(self.rfile.read(size))
    def local_origin(self): return self.headers.get("Origin","") in {"http://localhost:8000","http://127.0.0.1:8000"}
    def do_GET(self):
        u=urlparse(self.path)
        if u.path=="/catalog":
            self.path="/catalog.html";return super().do_GET()
        if (u.path=="/home" or re.fullmatch(r"/[a-z0-9-]+/[A-Za-z0-9_-]+/?",u.path)) and not u.path.startswith("/api/"):
            self.path="/index.html";return super().do_GET()
        if re.fullmatch(r"/(?:results|ranking)/[a-z0-9-]+/[A-Za-z0-9_-]+/?",u.path):
            self.path="/results.html" if u.path.startswith("/results/") else "/ranking.html";return super().do_GET()
        if u.path=="/api/login/meta":
            q=parse_qs(u.query);group=q.get("group",[DEFAULT_GROUP])[0]
            try:return self.reply(200,login_meta(group))
            except ValueError as error:return self.reply(400,{"error":str(error)})
            except Exception as error:return self.reply(502,{"error":str(error)})
        if u.path=="/api/login/status":
            q=parse_qs(u.query);course=q.get("course",["2021summers6"])[0];group=q.get("group",[DEFAULT_GROUP])[0]
            if not GROUP_TOKEN.fullmatch(group):return self.reply(400,{"error":"团队地址格式不正确"})
            logged,user=login_state(course if TOKEN.fullmatch(course) else "2021summers6",group)
            return self.reply(200,{"loggedIn":logged,"user":user})
        if u.path=="/api/deepseek/settings":
            return self.reply(200,{"configured":bool(DEEPSEEK_KEY),"model":DEEPSEEK_MODEL})
        if u.path=="/api/team":
            try:
                q=parse_qs(u.query);group=q.get("group",[DEFAULT_GROUP])[0];directory,cached,warning=team_catalog(group)
                return self.reply(200,{**directory,"group":group.lower(),"cached":cached,"warning":warning})
            except ValueError as error:return self.reply(400,{"error":str(error)})
            except Exception as error:return self.reply(502,{"error":str(error)})
        if u.path=="/api/ranking":
            q=parse_qs(u.query);group=q.get("group",[DEFAULT_GROUP])[0];course=q.get("course",[""])[0]
            if not GROUP_TOKEN.fullmatch(group) or not TOKEN.fullmatch(course):return self.reply(400,{"error":"团队或比赛地址格式不正确"})
            try:
                url=f"{group_origin(group)}/{course}/ranking/";html,cached,warning=fetch(url,f"ranking:{group}:{course}")
                return self.reply(200,{"html":html,"cached":cached,"warning":warning,"url":url})
            except Exception as error:return self.reply(502,{"error":str(error)})
        if u.path in {"/api/submissions","/api/submission"}:
            q=parse_qs(u.query);group=q.get("group",[DEFAULT_GROUP])[0];course=q.get("course",[""])[0]
            if not GROUP_TOKEN.fullmatch(group) or not TOKEN.fullmatch(course):return self.reply(400,{"error":"团队或题库格式不正确"})
            origin=group_origin(group);logged,user=login_state(course,group)
            if not logged:return self.reply(401,{"error":"登录状态已失效，请返回主页重新登录"})
            try:
                if u.path=="/api/submissions":
                    problem=q.get("problem",[""])[0]
                    if problem and not TOKEN.fullmatch(problem):return self.reply(400,{"error":"题号格式不正确"})
                    params={"userName":user or "","classId":"0"}
                    if problem:params["problemNumber"]=problem
                    _,_,body=request(f"{origin}/{course}/status/?{urlencode(params)}")
                    return self.reply(200,{"html":body.decode("utf-8","replace"),"user":user})
                solution=q.get("id",[""])[0]
                if not re.fullmatch(r"\d+",solution):return self.reply(400,{"error":"提交记录编号不正确"})
                _,_,body=request(f"{origin}/{course}/solution/{solution}/")
                return self.reply(200,{"html":body.decode("utf-8","replace")})
            except HTTPError as error:
                if error.code==401:return self.reply(401,{"error":"没有权限查看该提交记录"})
                return self.reply(error.code,{"error":f"OpenJudge 返回 HTTP {error.code}"})
            except Exception as error:return self.reply(502,{"error":str(error)})
        if u.path=="/api/captcha":
            q=parse_qs(u.query);group=q.get("group",[DEFAULT_GROUP])[0]
            if not GROUP_TOKEN.fullmatch(group):return self.reply(400,{"error":"团队地址格式不正确"})
            captcha_url=CAPTCHA_URLS.get(group)
            if not captcha_url:return self.reply(404,{"error":"当前没有验证码"})
            try:
                status,headers,body=request(captcha_url);self.send_response(status);self.send_header("Content-Type",headers.get_content_type());self.send_header("Cache-Control","no-store");self.send_header("Content-Length",str(len(body)));self.end_headers();self.wfile.write(body);return
            except Exception as error:return self.reply(502,{"error":str(error)})
        if u.path not in {"/api/problem","/api/problems"}: return super().do_GET()
        q=parse_qs(u.query);group=q.get("group",[DEFAULT_GROUP])[0];course=q.get("course",[""])[0];pid=q.get("id",[""])[0]
        if not GROUP_TOKEN.fullmatch(group) or not TOKEN.fullmatch(course) or (u.path=="/api/problem" and not TOKEN.fullmatch(pid)): return self.reply(400,{"error":"团队、题库或题号格式不正确"})
        try:
            origin=group_origin(group)
            if u.path=="/api/problem":
                url=f"{origin}/{course}/{pid}/";html,cached,warning=fetch(url,f"problem:{group}:{course}:{pid}");return self.reply(200,{"html":html,"cached":cached,"warning":warning,"url":url})
            url=f"{origin}/{course}/";html,cached,warning=fetch(url,f"list:{group}:{course}");parser=ProblemLinks(course);parser.feed(html)
            titles=listed_problem_titles(html,course)
            for item in parser.links:
                if item["id"] in titles:item["title"]=titles[item["id"]]
            if not parser.links: raise RuntimeError("原站页面中没有找到题目")
            return self.reply(200,{"problems":parser.links,"cached":cached,"warning":warning})
        except Exception as error:return self.reply(502,{"error":str(error)})
    def do_POST(self):
        global DEEPSEEK_KEY, DEEPSEEK_MODEL
        if not self.local_origin(): return self.reply(403,{"error":"仅允许本地页面调用"})
        try:data=self.read_json()
        except Exception:return self.reply(400,{"error":"请求格式不正确"})
        if self.path=="/api/login":
            group=str(data.get("group",DEFAULT_GROUP)).strip().lower();course=str(data.get("course","2021summers6"));email=str(data.get("email","")).strip();password=str(data.get("password",""));captcha=str(data.get("captcha","")).strip();captcha_name=str(data.get("captchaName","")).strip()
            if not email or not password:return self.reply(400,{"error":"请输入账号和密码"})
            if not GROUP_TOKEN.fullmatch(group) or not TOKEN.fullmatch(course):return self.reply(400,{"error":"团队或题库格式不正确"})
            form={"redirectUrl":"","email":email,"password":password}
            if captcha and FIELD.fullmatch(captcha_name):form[captcha_name]=captcha
            try:
                origin=group_origin(group)
                encoded=urlencode(form).encode()
                try:status,_,body=request(f"{origin}/api/auth/login/",encoded,{"Content-Type":"application/x-www-form-urlencoded","X-Requested-With":"XMLHttpRequest","Origin":origin,"Referer":f"{origin}/auth/login/"})
                except HTTPError as error:status=error.code;body=error.read()
                logged,user=login_state(course,group)
                if logged:return self.reply(200,{"ok":True,"user":user})
                message=login_message(body,status);meta=login_meta(group)
                return self.reply(401,{"ok":False,"error":message,"captcha":meta["captcha"],"captchaName":meta["captchaName"],"interactive":meta["interactive"],"officialUrl":meta["officialUrl"]})
            finally:password="";form.pop("password",None)
        if self.path=="/api/logout":
            group=str(data.get("group",DEFAULT_GROUP)).strip().lower()
            if not GROUP_TOKEN.fullmatch(group):return self.reply(400,{"error":"团队地址格式不正确"})
            warning=None
            try:
                origin=group_origin(group)
                request(f"{origin}/api/auth/logout/",b"",{"Content-Type":"application/x-www-form-urlencoded","X-Requested-With":"XMLHttpRequest","Origin":origin,"Referer":f"{origin}/"})
            except Exception as error:
                warning=f"官网注销请求暂时失败，但本地登录状态已清除：{error}"
            finally:
                with NET_LOCK:JAR.clear()
            return self.reply(200,{"ok":True,"warning":warning})
        if self.path in {"/api/team/join","/api/team/leave"}:
            group=str(data.get("group",DEFAULT_GROUP)).strip().lower();action="join" if self.path.endswith("/join") else "leave"
            if not GROUP_TOKEN.fullmatch(group):return self.reply(400,{"error":"团队地址格式不正确"})
            try:
                changed,directory=team_change(group,action)
                return self.reply(200,{"ok":True,"changed":changed,"group":group,"membership":"member" if action=="join" else "available","title":directory["title"]})
            except PermissionError as error:return self.reply(401,{"error":str(error)})
            except Exception as error:return self.reply(502,{"error":str(error)})
        if self.path=="/api/translate":
            text=str(data.get("text",""))
            if not DEEPSEEK_KEY:return self.reply(400,{"error":"请先在右上角“设置”中配置 DeepSeek API Key"})
            if not text.strip() or len(text)>60_000:return self.reply(400,{"error":"请先加载题目，或题目内容过长"})
            payload={"model":DEEPSEEK_MODEL,"thinking":{"type":"disabled"},"messages":[{"role":"system","content":"你是专业的算法竞赛题目翻译器。把题目完整翻译成简体中文，准确保留数字、公式、变量名、输入输出格式、样例和限制。不要解题，不要添加解释，只输出结构清晰的译文。"},{"role":"user","content":text}],"max_tokens":12000}
            try:
                encoded=json.dumps(payload,ensure_ascii=False).encode()
                try:status,_,body=request("https://api.deepseek.com/chat/completions",encoded,{"Content-Type":"application/json","Authorization":f"Bearer {DEEPSEEK_KEY}"},timeout=60)
                except HTTPError as error:status=error.code;body=error.read()
                result=json.loads(body.decode("utf-8","replace"))
                if status>=400:
                    message=result.get("error",{}).get("message") if isinstance(result,dict) else None
                    return self.reply(status,{"error":message or f"DeepSeek 返回 HTTP {status}"})
                translation=result.get("choices",[{}])[0].get("message",{}).get("content","")
                if not translation:return self.reply(502,{"error":"DeepSeek 没有返回译文"})
                return self.reply(200,{"translation":translation,"model":result.get("model",DEEPSEEK_MODEL)})
            except Exception as error:return self.reply(502,{"error":str(error)})
        if self.path=="/api/deepseek/settings":
            api_key=str(data.get("apiKey","")).strip();model=str(data.get("model","deepseek-flash"))
            if model not in {"deepseek-flash","deepseek-v4-pro"}:return self.reply(400,{"error":"模型不受支持"})
            if api_key:
                if len(api_key)>500:return self.reply(400,{"error":"API Key 格式不正确"})
                DEEPSEEK_KEY=api_key
            elif not DEEPSEEK_KEY:return self.reply(400,{"error":"请输入 DeepSeek API Key"})
            DEEPSEEK_MODEL=model;api_key=""
            return self.reply(200,{"ok":True,"configured":True,"model":DEEPSEEK_MODEL})
        if self.path=="/api/submit":
            group=str(data.get("group",DEFAULT_GROUP)).strip().lower();course=str(data.get("course",""));problem=str(data.get("problem",""));language=str(data.get("language",""));source=str(data.get("source",""))
            if not GROUP_TOKEN.fullmatch(group) or not TOKEN.fullmatch(course) or not TOKEN.fullmatch(problem) or language not in {"G++","GCC","Java","Pascal","Python3"} or not source.strip():return self.reply(400,{"error":"提交参数不正确"})
            try:
                origin=group_origin(group)
                logged,user=login_state(course,group)
                if not logged:return self.reply(401,{"error":"尚未登录，请先在本页登录"})
                joined_team=ensure_team_member(group)
                try:_,_,page=request(f"{origin}/{course}/{problem}/submit/")
                except HTTPError as error:
                    if error.code==401:return self.reply(401,{"error":"尚未登录，请先在本页登录"})
                    raise
                submit_page=page.decode("utf-8","replace")
                if is_login_page(submit_page):return self.reply(401,{"error":"官网没有保存登录状态，请重新登录后再试"})
                parser=SubmitForm();parser.feed(submit_page)
                if not parser.action:return self.reply(502,{"error":"已登录，但未能识别官网的提交表单；请刷新题目后重试"})
                before=set()
                if logged:
                    try:before=submission_ids(origin,course,problem,user)
                    except Exception:pass
                form=parser.fields;form["language"]=language;form["source"]=base64.b64encode(source.encode()).decode();encoded=urlencode(form).encode();url=urljoin(f"{origin}/",parser.action)
                try:status,_,body=request(url,encoded,{"Content-Type":"application/x-www-form-urlencoded","X-Requested-With":"XMLHttpRequest","Origin":origin,"Referer":f"{origin}/{course}/{problem}/submit/"})
                except HTTPError as error:status=error.code;body=error.read()
                result=body.decode("utf-8","replace")
                if status>=400:return self.reply(status,{"error":text_only(result) or f"OpenJudge 返回 HTTP {status}"})
                message="已送入评测队列"
                try:
                    parsed=json.loads(result)
                    if isinstance(parsed,dict):message=parsed.get("message") or parsed.get("msg") or message
                except Exception:
                    if 0<len(result.strip())<120:message=result.strip()
                solution_id=response_solution_id(result)
                if not solution_id and logged:
                    solution_id=wait_for_new_solution(origin,course,problem,user,before)
                return self.reply(200,{"ok":True,"message":message,"solutionId":solution_id,"joinedTeam":joined_team})
            except Exception as error:return self.reply(502,{"error":str(error)})
        return self.reply(404,{"error":"接口不存在"})

if __name__ == "__main__":
    parser=argparse.ArgumentParser();parser.add_argument("--port",type=int,default=8000);parser.add_argument("--open",action="store_true",help="启动后自动打开浏览器");args=parser.parse_args()
    url=f"http://localhost:{args.port}"
    print(f"OpenJudge 刷题台：{url}")
    if args.open: threading.Timer(.25,lambda:webbrowser.open(url)).start()
    ThreadingHTTPServer(("127.0.0.1",args.port),Handler).serve_forever()
