"""Local Chromium checks. Requires Python Playwright and a Chromium executable.
The fetch binding uses the real Node API + SQLite, without exposing a test port.
Set DISPLAY_BASELINE_HTML to the untouched v16.5 source to compare layouts too.
"""
from pathlib import Path
import os, json, subprocess, time, uuid
from datetime import datetime, timezone
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parent.parent
proc=subprocess.Popen(['node',str(ROOT/'tests/browser-rpc.js')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
def rpc(q):
    proc.stdin.write(json.dumps(q,ensure_ascii=False)+'\n'); proc.stdin.flush()
    result=json.loads(proc.stdout.readline())
    assert 'error' not in result, result
    return result

def command(action,payload=None,target=None):
    r=rpc({'path':'/api/command','method':'POST','body':{'command_id':str(uuid.uuid4()),'action':action,'payload':payload or {},'target':target}})
    body=json.loads(r['body']); assert body['ok'],body
    return body

def snapshot(): return json.loads(rpc({'path':'/api/display'})['body'])
def add(item): return command('upsert_item',{'item':item})

STUB="""<script>
window.fetch=async(path,opts={})=>{
 if(opts.method==='POST' && window.delayPost) await new Promise(r=>setTimeout(r,window.delayPost));
 const res=await window.backendRequest({path,method:opts.method||'GET',...(opts.body?{body:JSON.parse(opts.body)}:{})});
 return new Response(res.body,{status:res.status,headers:res.headers});
};
window.google={script:{get run(){return {ok:null,err:null,withSuccessHandler(fn){this.ok=fn;return this},withFailureHandler(fn){this.err=fn;return this},getDisplayData(){fetch('/api/display').then(r=>r.json()).then(this.ok).catch(this.err)},performDisplayAction(v){fetch('/api/action',{method:'POST',body:JSON.stringify(v)}).then(r=>r.json()).then(this.ok).catch(this.err)}}}}};
</script>"""
html=(ROOT/'public/index.html').read_text()
checks=[]
def record(name): checks.append(name);print('PASS',name,flush=True)

def wait(page,expression,timeout=5):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        if page.evaluate(expression): return
        page.wait_for_timeout(30)
    raise AssertionError(expression)

def load(browser,content=html,width=412,height=915):
    page=browser.new_page(viewport={'width':width,'height':height},has_touch=True,is_mobile=width<600)
    page.expose_function('backendRequest',rpc)
    page.on('pageerror', lambda err: print('BROWSER ERROR',str(err),flush=True))
    page.set_content(content.replace('<head>','<head>'+STUB))
    wait(page,'authoritativeData !== null')
    return page

try:
 with sync_playwright() as pw:
  browser=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM','/usr/bin/chromium'),headless=True,args=['--no-sandbox'])
  command('clear_display_and_current_service_log')
  page=load(browser)
  assert page.evaluate('DISPLAY_APP_VERSION')=='17.2'
  record('frontend starts against native API snapshot')
  add({'id':'alert-test','type':'alert','title':'Pozor','body':'Test upozornění'})
  add({'id':'reminder-test','type':'reminder','title':'Časovač','body':'Test připomínky','data':{'remind_at':datetime.now(timezone.utc).isoformat()}})
  page.evaluate('refreshDisplay()')
  wait(page,"document.querySelector('#alertViewportPulse').classList.contains('is-active') && document.querySelector('#reminderViewportPulse').classList.contains('is-active')")
  page.wait_for_timeout(9050)
  assert page.evaluate("document.querySelector('#alertViewportPulse').classList.contains('is-active')")
  assert page.evaluate("document.querySelector('#reminderViewportPulse').classList.contains('is-active')")
  page.wait_for_timeout(1250)
  assert not page.evaluate("document.querySelector('#alertViewportPulse').classList.contains('is-active')")
  assert not page.evaluate("document.querySelector('#reminderViewportPulse').classList.contains('is-active')")
  assert page.locator('.operational-reminder.reminder-ringing').count()==1
  assert 'infinite' in page.locator('.operational-reminder').evaluate('(el)=>getComputedStyle(el).animationIterationCount')
  record('both viewport pulses last 10 seconds; reminder card continues pulsing')
  assert page.locator('.operational-alert').evaluate('(el)=>getComputedStyle(el).touchAction')=='pan-y pinch-zoom'
  box=page.locator('.operational-alert').bounding_box(); x=box['x']+30; y=box['y']+box['height']/2
  cdp=page.context.new_cdp_session(page)
  cdp.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':x,'y':y}]})
  for i in range(1,10):
    cdp.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':x+24*i,'y':y+1}]})
    page.wait_for_timeout(20)
  cdp.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
  wait(page,"!authoritativeData.items.some(i=>i.id==='alert-test')")
  record('trusted touchscreen swipe removes an alert through POST /api/action')
  page.locator('.operational-reminder').tap()
  wait(page,"authoritativeData.items.find(i=>i.id==='reminder-test').status==='completed'")
  record('tap ringing reminder completes it on the server')
  command('clear_display_and_current_service_log')
  add({'id':'order-test','type':'order','title':'#1 stůl T5','body':'Kuřecí řízek – 160 Kč\nHranolky – 55 Kč','data':{'order_number':1}})
  page.evaluate('refreshDisplay()');wait(page,"authoritativeData.items.some(i=>i.id==='order-test')")
  page.wait_for_timeout(500)
  page.evaluate('window.delayPost=900')
  page.locator('[data-item-id="order-test"] .card').tap()
  assert page.evaluate("latestData.items.find(i=>i.id==='order-test').status")=='served'
  assert page.evaluate("authoritativeData.items.find(i=>i.id==='order-test').status")=='waiting'
  record('optimistic tap changes the card before server acknowledgement')
  wait(page,"authoritativeData.items.find(i=>i.id==='order-test').status==='served'")
  page.evaluate('window.delayPost=0');page.wait_for_timeout(1300)
  page.locator('[data-item-id="order-test"] .card').tap()
  wait(page,"authoritativeData.items.find(i=>i.id==='order-test').status==='waiting'")
  record('tap completed order restores its prior state')
  page.wait_for_timeout(600)
  box=page.locator('[data-item-id="order-test"] .card').bounding_box(); x=box['x']+50;y=box['y']+70
  cdp.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':x,'y':y}]})
  page.wait_for_timeout(720)
  cdp.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
  wait(page,"!document.getElementById('orderDetailOverlay').hidden")
  assert page.locator('#orderDetailDialog input[type=checkbox]').count()==2
  record('touch long-press opens the original item-selection dialog')
  page.close()
  baseline=os.environ.get('DISPLAY_BASELINE_HTML')
  if baseline:
    # Compare exactly the same server snapshot, freezing timers and animations.
    from PIL import Image,ImageChops
    command('clear_display_and_current_service_log')
    add({'id':'order-a','type':'order','title':'#1 stůl T5','body':'Kuřecí řízek – 160 Kč\nHranolky – 55 Kč','data':{'order_number':1,'table':'stůl T5'}})
    add({'id':'info-a','type':'info','title':'Bez soli','body':'Příloha zvlášť','data':{'parent_order_id':'order-a'}})
    add({'id':'order-b','type':'order','title':'#2 Martin','body':'Hovězí vývar – 35 Kč','data':{'order_number':2}})
    command('complete_order',target='order-b')
    add({'id':'tip-a','type':'tip','title':'Občerstvení obsluhy','body':'Voda je připravená'})
    original=Path(baseline).read_text()
    for w,h in [(412,915),(1280,800)]:
      shots=[]
      for label,source in [('baseline',original),('v17',html)]:
        p=load(browser,source,w,h)
        p.clock.install(time=datetime(2026,9,5,20,0,tzinfo=timezone.utc))
        p.clock.pause_at(datetime(2026,9,5,20,0,1,tzinfo=timezone.utc))
        p.add_style_tag(content='*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;}')
        p.evaluate('updateTimers();updateClockDisplays();')
        out=ROOT/'test-results'/f'{label}-{w}.png';out.parent.mkdir(exist_ok=True)
        p.screenshot(path=str(out),full_page=True);shots.append(Image.open(out).convert('RGB'));p.close()
      assert shots[0].size==shots[1].size,(w,shots[0].size,shots[1].size)
      diff=ImageChops.difference(*shots)
      assert diff.getbbox() is None, f'layout difference at width {w}: {diff.getbbox()}'
      record(f'pixel-identical v16.5 layout at {w}x{h} (frozen clock)')
  browser.close()
 (ROOT/'test-results').mkdir(exist_ok=True)
 (ROOT/'test-results/browser-result.json').write_text(json.dumps({'passed':checks},indent=2)+'\n')
finally:
 proc.terminate()
