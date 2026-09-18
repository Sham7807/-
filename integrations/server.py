#!/usr/bin/env python3
"""Loopback workbench service. Runs only fixed, reviewed test suites."""
import argparse
import io
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import threading
import time
import uuid
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, urlunsplit
import kvv_runner
from acceptance_results import decorate

ROOT = Path(__file__).resolve().parent
WORKSPACE = ROOT.parent
WEB = WORKSPACE / 'multimodal-workbench'
REPORTS = ROOT / 'reports'
TOKEN = secrets.token_urlsafe(32)
JOBS = {}
LOCK = threading.RLock()
SUITES = {'kvv11', 'kvvfull', 'ccmax'}

def clean(value, key=''):
    if isinstance(value, dict):
        return {k: ('[已隐藏]' if re.fullmatch(r'(?i)(key|api[_-]?key|authorization|x-api-key|x-goog-api-key)', k) else clean(v,key)) for k,v in value.items()}
    if isinstance(value, list): return [clean(v,key) for v in value]
    if isinstance(value, tuple): return [clean(v,key) for v in value]
    if isinstance(value, str):
        if key: value = value.replace(key, '[已隐藏]')
        return re.sub(r'(?i)(Bearer\s+)[^\s"<>]+', r'\1[已隐藏]', value)
    return value

def normalized_base(raw):
    u = urlsplit(str(raw).strip())
    if u.scheme not in ('http','https') or not u.hostname or u.username or u.password or u.query or u.fragment:
        raise ValueError('渠道地址必须是完整 HTTP(S) 地址，不能带账号、查询参数或片段。')
    path = u.path.rstrip('/')
    if not path.endswith('/v1'): path += '/v1'
    return urlunsplit((u.scheme,u.netloc,path,'',''))

def validate(data):
    if not isinstance(data,dict) or data.get('suite') not in SUITES: raise ValueError('请选择有效的验收套件')
    c = {'suite':data['suite'], 'base':normalized_base(data.get('base','')), 'key':str(data.get('key','')).strip(), 'model':str(data.get('model','')).strip()}
    if not c['key'] or not c['model']: raise ValueError('请填写 API Key 和渠道模型 ID')
    if any('\n' in c[k] or '\r' in c[k] for k in ('key','model')): raise ValueError('密钥和模型名不能包含换行')
    for name, default, low, high in [('timeout',120,5,600),('signature_samples',1,1,20),('sse_samples',3,1,200),('concurrency',2,1,10)]:
        try: n = int(data.get(name,default))
        except (ValueError,TypeError): raise ValueError(name+' 必须为整数')
        if not low <= n <= high: raise ValueError(f'{name} 超出范围 {low}–{high}')
        c[name] = n
    c['think_mode'] = data.get('think_mode','kimi')
    if c['think_mode'] not in ('kimi','opensource','none'): raise ValueError('thinking 格式无效')
    c['auth'] = data.get('auth','anthropic')
    if c['auth'] not in ('anthropic','bearer'): raise ValueError('CCmax 鉴权方式无效')
    c['thinking'] = bool(data.get('thinking',True))
    return c

def run_job(job,c):
    directory = REPORTS / job['id']; directory.mkdir(parents=True, exist_ok=True)
    key = c['key']
    def emit(event):
        event = clean(event,key)
        with LOCK:
            job['events'].append(event)
            if len(job['events']) > 2000: job['events'] = job['events'][-2000:]
            if event.get('type')=='request_start': job['request_count']=job.get('request_count',0)+1
            if event.get('request_count') is not None: job['request_count']=event['request_count']
            if event.get('total') is not None: job['total'] = event['total']
            if event.get('completed') is not None: job['completed'] = event['completed']
    try:
        if c['suite']=='ccmax':
            from ccmax_acceptance import run
            result = run(c,emit,job['cancel'].is_set)
        else: result = kvv_runner.run(c,emit,job['cancel'].is_set,directory)
        result = clean(result,key)
        result['configuration'] = clean({**result.get('configuration',{}), **{k:v for k,v in c.items() if k!='key'}})
    except Exception as exc:
        result = {'suite':c['suite'],'status':'error','error':clean(str(exc),key),'summary':{}}
    finally:
        # Raw pytest artifacts can include echoed vendor errors. Persist only redacted text.
        for path in directory.iterdir():
            if path.is_file(): path.write_text(clean(path.read_text(errors='replace'),key),encoding='utf-8')
    result['started_at']=job['started_at'];result['finished_at']=time.time();result['run_id']=job['id']
    decorate(result)
    (directory/'report.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    try:
        (directory/'report.html').write_bytes(report_html(result,directory))
    except Exception:
        result['report_export_error']='HTML 报告生成失败；测试结果已保存，可先下载 JSON 与证据包。'
        (directory/'report.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    with LOCK:
        job['result']=result; job['status']=result['status']; job['finished_at']=time.time()
        job['summary']=result.get('summary',{})
        if job['summary'].get('total') is not None: job['total']=job['summary']['total']
        job['completed']=job['summary'].get('completed',job['completed'])
    c['key']=''

def snapshot(job):
    return {k:v for k,v in job.items() if k not in ('cancel','result')} | {'elapsed': round((job.get('finished_at') or time.time())-job['started_at'],1), 'result':job.get('result')}

def report_html(result, directory=None):
    from report_renderer import render_report
    return render_report(result, directory)


class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def guard(self,auth=False):
        expected=f'127.0.0.1:{self.server.server_port}'
        if self.headers.get('Host') != expected: self.send_json(403,{'error':'仅允许本地工作台访问'}); return False
        origin=self.headers.get('Origin')
        if origin and origin != 'http://'+expected: self.send_json(403,{'error':'请求来源不匹配，请从本地工作台打开'}); return False
        if auth and not secrets.compare_digest(self.headers.get('X-Workbench-Token',''),TOKEN): self.send_json(403,{'error':'会话已过期，请刷新页面'}); return False
        return True
    def send_bytes(self,status,data,mime,filename=None):
        self.send_response(status);self.send_header('Content-Type',mime);self.send_header('Content-Length',str(len(data)))
        self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff');self.send_header('Referrer-Policy','no-referrer')
        self.send_header('X-Frame-Options','SAMEORIGIN')
        if filename:self.send_header('Content-Disposition',f'attachment; filename="{filename}"')
        self.end_headers();self.wfile.write(data)
    def send_json(self,status,data): self.send_bytes(status,json.dumps(data,ensure_ascii=False).encode(),'application/json; charset=utf-8')
    def do_GET(self):
        if not self.guard():return
        path=urlsplit(self.path).path
        if path=='/api/session':
            with LOCK: active=next((j['id'] for j in JOBS.values() if j['status']=='running'),None)
            return self.send_json(200,{'token':TOKEN,'active':active,'latest':next(reversed(JOBS),None),'kvv_revision':'66092cf','ready':True})
        if path.startswith('/api/runs/'):
            if not self.guard(auth=True):return
            parts=path.split('/');job=JOBS.get(parts[3])
            if not job:return self.send_json(404,{'error':'任务不存在'})
            if len(parts)==4:
                with LOCK:data=snapshot(job)
                return self.send_json(200,data)
            result=job.get('result')
            if not result:return self.send_json(409,{'error':'任务尚未完成'})
            if parts[4]=='report.html':return self.send_bytes(200,report_html(result,REPORTS/job['id']),'text/html; charset=utf-8','acceptance-report.html')
            if parts[4]=='report.json':return self.send_bytes(200,json.dumps(result,ensure_ascii=False,indent=2).encode(),'application/json','acceptance-report.json')
            if parts[4]=='evidence.zip':
                data=io.BytesIO()
                with zipfile.ZipFile(data,'w',zipfile.ZIP_DEFLATED) as archive:
                    for f in (REPORTS/job['id']).iterdir():
                        if f.is_file() and f.name!='report.html':archive.writestr(f.name,f.read_bytes())
                    archive.writestr('report.html',report_html(result,REPORTS/job['id']))
                return self.send_bytes(200,data.getvalue(),'application/zip','acceptance-evidence.zip')
            return self.send_json(404,{'error':'产物不存在'})
        if path=='/' or path=='/index.html': target=WEB/'index.html'
        elif re.fullmatch(r'/[a-zA-Z0-9_-]+\.(js|css|html)',path): target=WEB/path[1:]
        else:return self.send_json(404,{'error':'Not found'})
        if not target.is_file():return self.send_json(404,{'error':'Not found'})
        return self.send_bytes(200,target.read_bytes(),(mimetypes.guess_type(target.name)[0] or 'text/plain')+'; charset=utf-8')
    def do_POST(self):
        if not self.guard(auth=True):return
        path=urlsplit(self.path).path
        if re.fullmatch(r'/api/runs/[a-f0-9]+/cancel',path):
            job=JOBS.get(path.split('/')[3])
            if not job:return self.send_json(404,{'error':'任务不存在'})
            job['cancel'].set();return self.send_json(200,{'status':'stopping'})
        if path=='/api/models':
            try:
                length=int(self.headers.get('Content-Length','0'))
                if self.headers.get_content_type()!='application/json' or not 0<length<65536:raise ValueError('请求格式无效')
                data=json.loads(self.rfile.read(length))
                base=normalized_base(data.get('base',''));key=str(data.get('key','')).strip();auth=data.get('auth','bearer')
                if not key or any(x in key for x in ('\n','\r')) or auth not in ('bearer','anthropic'):raise ValueError('请输入有效密钥与鉴权方式')
                from channel_discovery import fetch_models
                return self.send_json(200,fetch_models(base,key,auth))
            except Exception as exc:
                return self.send_json(400,{'error':str(exc).replace(locals().get('key','__no_key__'),'[已隐藏]')})
        if path!='/api/runs':return self.send_json(404,{'error':'Not found'})
        try:
            if self.headers.get_content_type()!='application/json': raise ValueError('请求必须为 JSON')
            length=int(self.headers.get('Content-Length','0'))
            if not 0<length<65536:raise ValueError('请求长度无效')
            c=validate(json.loads(self.rfile.read(length)))
            with LOCK:
                if any(j['status']=='running' for j in JOBS.values()):return self.send_json(409,{'error':'已有验收任务运行中，请完成或取消后再开始'})
                job={'id':uuid.uuid4().hex,'suite':c['suite'],'model':c['model'],'base':c['base'],'status':'running','started_at':time.time(),'total':11 if c['suite']=='kvv11' else None,'completed':0,'events':[],'cancel':threading.Event()}
                JOBS[job['id']]=job
            threading.Thread(target=run_job,args=(job,c),daemon=True).start()
            return self.send_json(202,{'id':job['id']})
        except (ValueError,TypeError) as exc:return self.send_json(400,{'error':str(exc)})

def restore_reports():
    if not REPORTS.exists(): return
    for path in sorted(REPORTS.glob('*/report.json'), key=lambda p:p.stat().st_mtime):
        try:
            result=json.loads(path.read_text())
            identity=path.parent.name
            if not re.fullmatch('[a-f0-9]+',identity):continue
            suite=result.get('configuration',{}).get('suite') or result.get('suite')
            if suite=='ccmax_acceptance':suite='ccmax'
            config=result.get('configuration',{});summary=result.get('summary',{})
            JOBS[identity]={'id':identity,'suite':suite,'model':config.get('model',''),'base':config.get('base',''),
                'status':result.get('status','error'),'started_at':result.get('started_at',path.stat().st_mtime),
                'finished_at':result.get('finished_at',path.stat().st_mtime),'total':summary.get('total'),
                'completed':summary.get('completed',0),'summary':summary,'events':[],'result':result,'cancel':threading.Event()}
        except (ValueError,OSError):continue
    # Editing a derived report must not make an older run the latest run.
    ordered=sorted(JOBS.items(),key=lambda item:item[1]['started_at'])
    JOBS.clear();JOBS.update(ordered)

def main():
    restore_reports()
    parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=8877);parser.add_argument('--open',action='store_true');args=parser.parse_args()
    server=ThreadingHTTPServer(('127.0.0.1',args.port),Handler)
    print(f'工作台已启动：http://127.0.0.1:{server.server_port}',flush=True)
    if args.open:
        import webbrowser;webbrowser.open(f'http://127.0.0.1:{server.server_port}/')
    try:server.serve_forever()
    except KeyboardInterrupt:
        for job in JOBS.values():job['cancel'].set()
        time.sleep(1)
    finally:server.server_close()
if __name__=='__main__':main()
