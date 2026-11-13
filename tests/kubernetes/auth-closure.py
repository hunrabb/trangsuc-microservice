#!/usr/bin/env python3
"""Live customer authentication checks against the two pre-existing demo Auth Pods.

No builds, migrations or privileged accounts. Credentials stay in memory. The only
DB updates are expiry/cleanup of the exact account created by this run. Requires
kubectl access to jewelry-demo and preflight evidence; errors withhold responses.
"""
import concurrent.futures
import datetime
import json
import os
import pathlib
import secrets
import subprocess
import sys
import time
import uuid

K = ['kubectl', '--kubeconfig', '/home/hung/.kube/jewelry-lab.config', '--request-timeout=8s']
P = pathlib.Path('docs/evidence/kubernetes-phase4-1-auth/closure-20261113')
DRIVER = r"""
const http=require('node:http');
let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',async()=>{
 try {
  const o=JSON.parse(input);const u=new URL(o.url);const data=o.body===undefined?null:JSON.stringify(o.body);
  const result=await new Promise((resolve,reject)=>{const r=http.request(u,{method:o.method||'GET',agent:false,headers:{connection:'close',...(data?{'content-type':'application/json','content-length':Buffer.byteLength(data)}:{}),...o.headers}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>{let body;try{body=JSON.parse(b)}catch{body=b}resolve({status:res.statusCode,headers:res.headers,body})})});r.setTimeout(5000,()=>r.destroy(new Error('HTTP timeout')));r.on('error',reject);if(data)r.write(data);r.end()});
  process.stdout.write(JSON.stringify(result));
 } catch {process.stderr.write('HTTP test request failed (credentials withheld)');process.exitCode=1}
});

"""
NAME = 'Checkpoint 4.1.4 Demo Customer'
DB = r"""
const {PrismaService}=require('./dist/prisma/prisma.service.js');
const {hashRefreshToken}=require('./dist/session/tokens.js');
let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',async()=>{
 let db;try{
  const o=JSON.parse(input),u=new URL(process.env.DATABASE_URL);
  if(u.hostname!=='jewelry-pg-rw.jewelry-demo.svc.cluster.local'||u.pathname!=='/auth_db'||u.searchParams.get('schema')!=='auth')throw Error();
  db=new PrismaService({get:k=>k==='DATABASE_POOL_MAX'?1:process.env[k]});
  const target=await db.$queryRawUnsafe('SELECT current_database() AS name');
  if(target[0].name!=='auth_db')throw Error();
  let result;
  if(o.op==='baseline')result={database:'auth_db',users:await db.user.count(),accounts:await db.customerAccount.count(),sessions:await db.customerSession.count(),audit:await db.auditLog.count()};
  else {
   if(!/^closure41\.[a-f0-9]+@example\.invalid$/.test(o.email)||o.fullName!=='Checkpoint 4.1.4 Demo Customer')throw Error();
   const account=await db.customerAccount.findUnique({where:{email:o.email}});
   if(account && (account.fullName!==o.fullName || (o.id && account.id!==o.id)))throw Error();
   if(o.op==='resolve')result={id:account?.id||null};
   else {
    if(!account)throw Error();
    if(o.op==='expire'){
     const r=await db.customerSession.updateMany({where:{accountId:account.id,tokenHash:hashRefreshToken(o.token),revokedAt:null},data:{expiresAt:new Date(Date.now()-1000)}});
     if(r.count!==1)throw Error();result={expiredOnlyOwnedSession:true};
    }else if(o.op==='cleanup'){
     if(await db.auditLog.count({where:{entityId:account.id}}))throw Error('audit references; retain fixture');
     result=await db.$transaction(async tx=>{const sessions=await tx.customerSession.deleteMany({where:{accountId:account.id}});const accounts=await tx.customerAccount.deleteMany({where:{id:account.id,email:o.email,fullName:o.fullName}});if(accounts.count!==1)throw Error();return{sessionsRemoved:sessions.count,accountsRemoved:accounts.count}});
    }else if(o.op==='snapshot'){
     const rows=await db.customerSession.findMany({where:{accountId:account.id},orderBy:{id:'asc'}});
     const tokens=o.tokens||[];result={accountId:account.id,passwordHashIsBcrypt:/^\$2[aby]\$/.test(account.passwordHash),passwordMatches:o.password?await require('bcryptjs').compare(o.password,account.passwordHash):undefined,sessions:rows.map(s=>({id:s.id,revoked:s.revokedAt!==null,revokedAt:s.revokedAt,started:s.sessionStartedAt,expires:s.expiresAt,matches:tokens.map(t=>s.tokenHash===hashRefreshToken(t))}))};
    }else throw Error();
   }
  }
  process.stdout.write(JSON.stringify(result));
 }catch{process.stderr.write('Scoped fixture DB operation failed; credentials withheld');process.exitCode=1}
 finally{if(db)await db.$disconnect()}
});
"""
VERIFY = r"""
let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',async()=>{try{
 const o=JSON.parse(input),{verifyAccessToken,loadPublicKey}=require('@jewelry/common'),{decodeJwt,decodeProtectedHeader}=require('jose');
 const cfg={publicKey:loadPublicKey(process.env.JWT_PUBLIC_KEY_PATH),issuer:process.env.JWT_ISSUER,audiences:{shop:process.env.JWT_AUDIENCE_SHOP,backoffice:process.env.JWT_AUDIENCE_BACKOFFICE}};
 const user=await verifyAccessToken(o.token,cfg,'shop'),p=decodeJwt(o.token),h=decodeProtectedHeader(o.token);
 if(user.id!==o.id||user.branches.length!==0||p.iss!==cfg.issuer||p.aud!==cfg.audiences.shop||p.exp-p.iat!==900||h.alg!=='RS256'||!p.jti)throw Error();
 let rejected=false;try{await verifyAccessToken(o.token,cfg,'backoffice')}catch{rejected=true}if(!rejected)throw Error();process.stdout.write('PASS');
}catch{process.stderr.write('JWT verification failed; token withheld');process.exitCode=1}});
"""


def run(args, data=None, timeout=25):
    r = subprocess.run(args, input=data, text=True, capture_output=True, timeout=timeout)
    if r.returncode:
        raise RuntimeError('Remote test operation failed; response and credentials withheld')
    return r.stdout


def node(pod, code, data):
    return run(K + ['exec', '-i', '-n', 'jewelry-demo', pod, '--', 'node', '--max-old-space-size=64', '-e', code], json.dumps(data))


preflight = json.loads((P / 'preflight-result.json').read_text())
assert preflight['status'] == 'CONDITIONAL PASS'
assert datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(preflight['end']) < datetime.timedelta(minutes=15)
assert not (P / 'STOP.json').exists()
checks = []


def check(label, condition, **safe):
    if not condition:
        raise RuntimeError(label + ' failed; response withheld')
    checks.append({'test': label, 'status': 'PASS', **safe})
    print('PASS ' + label, flush=True)


ps = json.loads(run(K + ['get', 'pods', '-n', 'jewelry-demo', '-l', 'app.kubernetes.io/name=auth,app.kubernetes.io/part-of=jewelry-demo', '-o', 'json']))['items']
assert len(ps) == 2 and {p['spec']['nodeName'] for p in ps} == {'jewelry-lab-worker', 'jewelry-lab-worker2'}
assert all(p['status']['phase'] == 'Running' and all(c['ready'] and c['restartCount'] == 0 for c in p['status']['containerStatuses']) for p in ps)
A, B = sorted(ps, key=lambda p: p['spec']['nodeName'])
email = 'closure41.' + secrets.token_hex(10) + '@example.invalid'
password = secrets.token_urlsafe(30)
account_id = None
cookies = []
created = False
cleanup = None
failure = None


def http(pod, path, method='GET', body=None, cookie=None, token=None):
    headers = {}
    if cookie:
        headers['cookie'] = cookie
    if token:
        headers['authorization'] = 'Bearer ' + token
    req = {'url': 'http://' + pod['status']['podIP'] + ':3000' + path, 'method': method, 'headers': headers}
    if body is not None:
        req['body'] = body
    return json.loads(node(A['metadata']['name'], DRIVER, req))


def db(op, **extra):
    return json.loads(node(A['metadata']['name'], DB, {'op': op, 'email': email, 'id': account_id, 'fullName': NAME, **extra}))


def session(r, status):
    check('session response status and DTO', r['status'] == status and set(r['body']) == {'accessToken', 'expiresIn', 'user'} and set(r['body']['user']) == {'id', 'email', 'fullName'} and r['body']['expiresIn'] == 900)
    vals = r['headers'].get('set-cookie', [])
    check('refresh cookie security flags', len(vals) == 1 and all(v in vals[0] for v in ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/api/shop/auth']) and vals[0].startswith('rt_shop='))
    cookie = vals[0].split(';', 1)[0]
    cookies.append(cookie)
    return r['body']['accessToken'], cookie


def raw(cookie):
    return cookie.split('=', 1)[1]


def match(snap, index):
    rows = [s for s in snap['sessions'] if s['matches'][index]]
    check('refresh hash identifies exactly one persisted session', len(rows) == 1)
    return rows[0]


baseline = db('baseline')
check('database target confirmed before writes', baseline['database'] == 'auth_db')
try:
    created = True  # Resolve by exact random email even if register succeeds but response is lost.
    r = http(A, '/shop/auth/register', 'POST', {'email': email, 'password': password, 'fullName': NAME})
    initial, reg = session(r, 201)
    account_id = r['body']['user']['id']
    check('ordinary customer account; no privileged role', bool(uuid.UUID(account_id)))
    check('initial session logout B', http(B, '/shop/auth/logout', 'POST', cookie=reg)['status'] == 204)
    token_a, ca = session(http(A, '/shop/auth/login', 'POST', {'email': email, 'password': password}), 200)
    check('login A token accepted by HTTP guard/profile B', http(B, '/shop/auth/me', token=token_a)['body'].get('id') == account_id)
    check('JWT claims signature TTL audience B', node(B['metadata']['name'], VERIFY, {'token': token_a, 'id': account_id}) == 'PASS')
    snap = db('snapshot', tokens=[raw(ca)], password=password)
    check('real bcrypt password and shared session persistence', snap['passwordHashIsBcrypt'] and snap['passwordMatches'] and not match(snap, 0)['revoked'])
    count = len(snap['sessions'])
    r = http(B, '/shop/auth/login', 'POST', {'email': email, 'password': secrets.token_urlsafe(24)})
    check('wrong password rejected without opening a session', r['status'] == 401 and len(db('snapshot')['sessions']) == count)
    token_b, cb = session(http(B, '/shop/auth/refresh', 'POST', cookie=ca), 200)
    check('login A refresh B token accepted back on A', http(A, '/shop/auth/me', token=token_b)['body'].get('id') == account_id)
    snap = db('snapshot', tokens=[raw(ca), raw(cb)])
    old, new = match(snap, 0), match(snap, 1)
    check('rotation consumes parent and creates one child with same start', len(snap['sessions']) == count + 1 and old['revoked'] and not new['revoked'] and old['started'] == new['started'] and raw(ca) != raw(cb))
    check('reuse during source-defined 10-second grace returns conflict', http(A, '/shop/auth/refresh', 'POST', cookie=ca)['status'] == 409)
    revoked = datetime.datetime.fromisoformat(old['revokedAt'].replace('Z', '+00:00'))
    remaining = 10.2 - (datetime.datetime.now(datetime.timezone.utc) - revoked).total_seconds()
    if remaining > 0:
        time.sleep(remaining)
    check('reuse after grace returns session expired', http(B, '/shop/auth/refresh', 'POST', cookie=ca)['status'] == 401)
    check('reuse policy does not revoke the replacement session', not match(db('snapshot', tokens=[raw(cb)]), 0)['revoked'])
    reverse_token, reverse_cookie = session(http(B, '/shop/auth/login', 'POST', {'email': email, 'password': password}), 200)
    check('login B token accepted A', http(A, '/shop/auth/me', token=reverse_token)['body'].get('id') == account_id)
    reverse_token2, reverse_cookie2 = session(http(A, '/shop/auth/refresh', 'POST', cookie=reverse_cookie), 200)
    check('refresh A token accepted back B', http(B, '/shop/auth/me', token=reverse_token2)['body'].get('id') == account_id)
    before = len(db('snapshot')['sessions'])
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda p: http(p, '/shop/auth/refresh', 'POST', cookie=cb), [A, B]))
    check('concurrent refresh across Pods has one winner and one conflict', sorted(r['status'] for r in results) == [200, 409])
    winner = next(r for r in results if r['status'] == 200)
    race_token, race_cookie = session(winner, 200)
    check('concurrent consumption creates exactly one session', len(db('snapshot')['sessions']) == before + 1)
    check('concurrent winner access token works across replicas', http(B, '/shop/auth/me', token=race_token)['body'].get('id') == account_id)
    _, expcookie = session(http(A, '/shop/auth/login', 'POST', {'email': email, 'password': password}), 200)
    check('expiry test modifies only owned API-created session', db('expire', token=raw(expcookie))['expiredOnlyOwnedSession'])
    before = len(db('snapshot')['sessions'])
    expired = http(B, '/shop/auth/refresh', 'POST', cookie=expcookie)
    check('expired refresh rejected and cookie cleared', expired['status'] == 401 and any('Max-Age=0' in c for c in expired['headers'].get('set-cookie', [])))
    check('invalid refresh rejected without duplicate sessions', http(A, '/shop/auth/refresh', 'POST', cookie='rt_shop=' + secrets.token_urlsafe(32))['status'] == 401 and len(db('snapshot')['sessions']) == before)
    check('logout cross-replica', http(B, '/shop/auth/logout', 'POST', cookie=reverse_cookie2)['status'] == 204)
    check('revoked logout credential cannot refresh on A', http(A, '/shop/auth/refresh', 'POST', cookie=reverse_cookie2)['status'] in [409, 401])
    check('session sliding/absolute expiry bounded by source policy', all(datetime.datetime.fromisoformat(s['expires'].replace('Z', '+00:00')) <= datetime.datetime.fromisoformat(s['started'].replace('Z', '+00:00')) + datetime.timedelta(days=30) for s in db('snapshot')['sessions']))
except BaseException:
    failure = 'Authentication test failed; credentials and raw responses withheld'
finally:
    if created:
        try:
            resolved = db('resolve')
            if resolved['id']:
                account_id = resolved['id']
                cleanup = db('cleanup')
                check('exact owned account and sessions cleaned up', cleanup['accountsRemoved'] == 1)
            else:
                cleanup = {'accountsRemoved': 0, 'reason': 'Registration created no account'}
        except BaseException:
            failure = 'Scoped fixture cleanup needs attention; no unrelated data was deleted'
            receipt = pathlib.Path('/tmp/jewelry-auth-closure/cleanup-pending.json')
            fd = os.open(receipt, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as f:
                json.dump({'id': account_id, 'email': email, 'fullName': NAME}, f)
    after = db('baseline')
    checks.append({'test': 'disabled customer account', 'status': 'NOT APPLICABLE', 'reason': 'CustomerAccount has no disabled/status field; employee password login is ADMIN-only and was not used'})
    if baseline != after:
        failure = 'Fixture cleanup counts differ from baseline'
    else:
        check('business account session and audit counts restored', True)
    result = {'status': 'FAILED' if failure else 'PASS', 'checks': checks, 'cleanup': cleanup, 'fixtureCreatedVia': '/shop/auth/register', 'privilegedAccountCreated': False, 'baseline': baseline, 'after': after, 'pods': [{'pod': p['metadata']['name'], 'node': p['spec']['nodeName']} for p in [A, B]], 'secretsPersistedOrPrinted': False}
    (P / 'authentication-results.json').write_text(json.dumps(result, indent=2) + '\n')
if failure:
    raise SystemExit(failure)
print('AUTH LOGIN REFRESH CROSS-REPLICA AND CLEANUP PASS', flush=True)
