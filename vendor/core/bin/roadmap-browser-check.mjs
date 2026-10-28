import { pathToFileURL } from 'node:url';
import { checkRoadmapHtml } from '../scripts/roadmap-check.mjs';
export const ROADMAP_VIEWPORTS = Object.freeze([{width:1440,height:1000},{width:390,height:844}].map(Object.freeze));
const ROADMAP_CHECK_NAMES = ['dual-maps','mobile-document-width','no-console-errors','no-network-dependencies', ...['flow','api'].flatMap(map => ['dom','route-bounds','bounds','text-geometry','station-text-clearance','route-label-geometry','clicks','hint-readability','filters','packets','zoom','zoom-readable-labels','pan','reset','double-click-reset'].map(name => `${map}-${name}`))];
export function validRoadmapEvidence(receipt) {
  return receipt.diagramType === 'roadmap' && receipt.acceptanceProfile === 'roadmap-v1'
    && receipt.roadmap?.status === 'pass' && receipt.roadmap.staticChecks === true
    && Array.isArray(receipt.roadmap.viewports) && receipt.roadmap.viewports.length === ROADMAP_VIEWPORTS.length
    && ROADMAP_VIEWPORTS.every(v => receipt.roadmap.viewports.filter(e => e.width===v.width && e.height===v.height && e.ok===true && Array.isArray(e.checks) && e.checks.every(c=>c.ok===true) && ROADMAP_CHECK_NAMES.every(name=>e.checks.filter(c=>c.name===name&&c.ok===true).length===1)).length===1);
}
async function evaluate(browser, sessionId, expression) {
  const result = await browser.cdp.send('Runtime.evaluate', {expression,awaitPromise:true,returnByValue:true},sessionId);
  if(result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
export async function inspectRoadmap(browser, {artifactPath,width,height}) {
  const sessionId = await browser.sessionPromise;
  await browser.cdp.send('Network.enable',{},sessionId);
  await browser.cdp.send('Log.enable',{},sessionId);
  browser.cdp.events.length=0;
  await browser.cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false},sessionId);
  const loaded=browser.cdp.waitFor('Page.loadEventFired',sessionId); loaded.catch(()=>{});
  const nav=await browser.cdp.send('Page.navigate',{url:pathToFileURL(artifactPath).href},sessionId);
  if(nav.errorText) throw new Error(nav.errorText);
  await loaded;
  const result=await evaluate(browser,sessionId,`(async () => {
    await document.fonts.ready;
    const checks=[];
    const check=(name,ok,details)=>checks.push({name,ok:!!ok,...(details?{details}: {})});
    check('dual-maps',document.querySelectorAll('svg.map').length===2);
    check('mobile-document-width',document.documentElement.scrollWidth<=innerWidth+2,{scrollWidth:document.documentElement.scrollWidth,innerWidth});
    for(const map of ['flow','api']) {
      const svg=document.getElementById(map+'-map');
      const layer=svg?.querySelector('.zoom-layer');
      const viewport=svg?.closest('.map-viewport');
      if(!svg||!layer||!viewport) {check(map+'-dom',false);continue;}
      const stations=[...svg.querySelectorAll('.station')];
      const routes=[...svg.querySelectorAll('.route')];
      check(map+'-dom',stations.length>=2&&routes.length>0&&routes.every(p=>p.getTotalLength()>0));
      const vb=svg.viewBox.baseVal;
      check(map+'-route-bounds',routes.every(p=>{const b=p.getBBox();return b.x>=0&&b.y>=0&&b.x+b.width<=vb.width&&b.y+b.height<=vb.height;}));
      check(map+'-bounds',stations.every(g=>{const b=g.getBBox();const t=g.transform.baseVal.consolidate()?.matrix;return t&&b.x+t.e>=0&&b.y+t.f>=0&&b.x+b.width+t.e<=vb.width&&b.y+b.height+t.f<=vb.height;}));
      check(map+'-text-geometry',stations.every(g=>[...g.querySelectorAll('text')].filter(text=>!text.classList.contains('sub')||text.textContent.length>0).every(text=>{const b=text.getBBox();const t=g.transform.baseVal.consolidate()?.matrix;return t&&b.width>0&&b.height>0&&b.x+t.e>=0&&b.y+t.f>=0&&b.x+b.width+t.e<=vb.width&&b.y+b.height+t.f<=vb.height;})));
      const textBoxes=stations.map(g=>{const t=g.transform.baseVal.consolidate().matrix;return [...g.querySelectorAll('text')].filter(text=>text.textContent.length>0).map(text=>{const b=text.getBBox();return {x:b.x+t.e,y:b.y+t.f,width:b.width,height:b.height};});});
      const intersects=(a,b)=>a.x<b.x+b.width&&b.x<a.x+a.width&&a.y<b.y+b.height&&b.y<a.y+a.height;
      check(map+'-station-text-clearance',textBoxes.every((boxes,i)=>textBoxes.every((other,j)=>j<=i||boxes.every(a=>other.every(b=>!intersects(a,b))))));
      const routeLabels=[...layer.querySelectorAll(':scope > g[pointer-events="none"] > text')].map(text=>text.getBBox());
      check(map+'-route-label-geometry',routeLabels.every(b=>b.width>0&&b.height>0&&b.x>=0&&b.y>=0&&b.x+b.width<=vb.width&&b.y+b.height<=vb.height&&textBoxes.every(boxes=>boxes.every(other=>!intersects(b,other))))&&routeLabels.every((a,i)=>routeLabels.every((b,j)=>j<=i||!intersects(a,b))));
      check(map+'-clicks',stations.every(station=>{station.dispatchEvent(new MouseEvent('click',{bubbles:true}));return station.classList.contains('active')&&document.getElementById(map+'-hint').textContent.includes(station.querySelector('.num').textContent);}));
      const hint=document.getElementById(map+'-hint');
      check(map+'-hint-readability',parseFloat(getComputedStyle(hint).fontSize)>=12&&hint.scrollWidth<=hint.clientWidth+2&&hint.textContent.trim().length>4,{fontSize:getComputedStyle(hint).fontSize,width:hint.clientWidth,scrollWidth:hint.scrollWidth});
      const buttons=[...document.querySelectorAll(map==='flow'?'#flow .map-actions [data-kind], #flow .map-actions [data-line]':'#api .map-actions [data-api]')];
      check(map+'-filters',buttons.length>=(map==='flow'?4:1)&&buttons.every(button=>{button.click();const filter=map==='flow'?(button.dataset.line||button.dataset.kind):button.dataset.api;return button.classList.contains('active')&&routes.every(p=>{const match=filter==='all'||(map==='flow'?(p.dataset.line===filter||p.dataset.kind===filter):p.dataset.api===filter);return p.classList.contains('dim')===!match;});}));
      buttons.find(b=>(b.dataset.line||b.dataset.api)==='all')?.click();
      const packets=[...svg.querySelectorAll('.packet')];
      const expected=routes.filter(p=>map==='api'||p.classList.contains('auto')).length;
      const before=packets.map(p=>[p.getAttribute('cx'),p.getAttribute('cy')]);
      await new Promise(resolve=>setTimeout(resolve,180));
      check(map+'-packets',packets.length===expected&&packets.every((p,i)=>p.getAttribute('opacity')==='1'&&(p.getAttribute('cx')!==before[i][0]||p.getAttribute('cy')!==before[i][1])),{expected,count:packets.length,movement:expected===0?'not-applicable':'observed'});
      viewport.scrollIntoView({block:'center'});
      const rect=viewport.getBoundingClientRect();
      viewport.dispatchEvent(new WheelEvent('wheel',{deltaY:-120,clientX:rect.left+100,clientY:rect.top+100,bubbles:true,cancelable:true}));
      const zoom=layer.getAttribute('transform');
      check(map+'-zoom',document.querySelector('[data-zoom-label="'+map+'-map"]').textContent==='112%'&&zoom.includes('scale(1.12)'));
      const projectedTextPx=()=>Math.min(...stations.flatMap(g=>[...g.querySelectorAll('text:not(.num)')].filter(t=>t.textContent.length).map(t=>{const m=t.getScreenCTM();return parseFloat(getComputedStyle(t).fontSize)*Math.hypot(m.a,m.b);} )));
      const overviewPx=projectedTextPx()/1.12;
      for(let step=0;step<15;step++) viewport.dispatchEvent(new WheelEvent('wheel',{deltaY:-120,clientX:rect.left+100,clientY:rect.top+100,bubbles:true,cancelable:true}));
      const zoomedPx=projectedTextPx();
      check(map+'-zoom-readable-labels',document.querySelector('[data-zoom-label="'+map+'-map"]').textContent==='500%'&&zoomedPx>=12,{overviewMinTextPx:overviewPx,zoomedMinTextPx:zoomedPx,overviewRequiresZoom:overviewPx<12,zoomPercent:500});
      const beforePan=layer.getAttribute('transform');
      // Targeting a station avoids synthetic pointer-capture, while executing the original pan handlers.
      stations[0].dispatchEvent(new PointerEvent('pointerdown',{button:0,clientX:rect.left+50,clientY:rect.top+50,bubbles:true,pointerId:1}));
      viewport.dispatchEvent(new PointerEvent('pointermove',{clientX:rect.left+80,clientY:rect.top+90,bubbles:true,pointerId:1}));
      viewport.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:1}));
      check(map+'-pan',layer.getAttribute('transform')!==beforePan&&!viewport.classList.contains('is-panning'));
      document.querySelector('[data-reset-zoom="'+map+'-map"]').click();
      check(map+'-reset',layer.getAttribute('transform')==='translate(0 0) scale(1)'&&document.querySelector('[data-zoom-label="'+map+'-map"]').textContent==='100%');
      viewport.dispatchEvent(new WheelEvent('wheel',{deltaY:-120,clientX:rect.left+100,clientY:rect.top+100,bubbles:true,cancelable:true}));
      viewport.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
      check(map+'-double-click-reset',layer.getAttribute('transform')==='translate(0 0) scale(1)');
    }
    return {width:innerWidth,height:innerHeight,interactionDispatch:'dom-events',checks};
  })()`);
  const events=browser.cdp.events.filter(e=>e.sessionId===sessionId);
  const errors=events.filter(e=>e.method==='Runtime.exceptionThrown'||e.method==='Runtime.consoleAPICalled'&&['error','warning'].includes(e.params.type)||e.method==='Log.entryAdded'&&['error','warning'].includes(e.params.entry.level));
  const external=events.filter(e=>e.method==='Network.requestWillBeSent'&&/^https?:/i.test(e.params.request.url));
  result.checks.push({name:'no-console-errors',ok:errors.length===0,errors:errors.map(e=>({method:e.method,details:e.params}))},{name:'no-network-dependencies',ok:external.length===0,urls:external.map(e=>e.params.request.url)});
  result.ok=result.checks.every(c=>c.ok);
  return result;
}
export function roadmapStaticPass(bytes, artifactPath) { return checkRoadmapHtml(bytes.toString('utf8'),artifactPath).ok; }
