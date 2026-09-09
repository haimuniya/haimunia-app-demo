import {chromium} from '../browser-check/node_modules/playwright/index.mjs';
import {resolveLocalOnlyTarget} from '../browser-check/lib/target.mjs';
import {installMockCloud} from '../browser-check/lib/mockCloud.mjs';
import {dismissWelcomeModal} from '../browser-check/lib/actions.mjs';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
const out='docs/visual-qa/immersive/verification';await mkdir(out,{recursive:true});
const axe=await readFile(new URL('../browser-check/node_modules/axe-core/axe.min.js',import.meta.url),'utf8');
const target=await resolveLocalOnlyTarget(),browser=await chromium.launch();const results=[];
try {
 for(const [width,height] of [[390,844],[430,932],[900,1000],[1280,1000],[1440,1000]]) for(const theme of ['light','dark']) {
  const page=await browser.newPage({viewport:{width,height},colorScheme:theme});await installMockCloud(page);await page.goto(target.url);await dismissWelcomeModal(page);
  await page.evaluate(theme=>document.documentElement.setAttribute('data-theme',theme),theme);
  await page.evaluate(async()=>{await window.addMovement('QA Squat סקוואט','Squat');window.applyFieldValue('step','weight',60);await window.saveSet();});await page.waitForTimeout(900);
  await page.evaluate(()=>document.querySelectorAll('.modal-overlay.open button[data-action^="close-"]').forEach(b=>b.click()));
  for(const tab of ['add','calendar','history','wod','community']) {
   await page.evaluate(tab=>document.querySelector(`[data-tab="${tab}"]`).click(),tab);await page.evaluate(()=>scrollTo(0,0));await page.waitForTimeout(250);
   await page.evaluate(axe);
   const issues=await page.evaluate(async()=>{const r=await window.axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa']}});return r.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}));});
   const geometry=await page.evaluate(()=>{const all=[...document.querySelectorAll('[id]')],ids=all.map(e=>e.id);return {overflow:document.documentElement.scrollWidth>innerWidth,duplicateIds:[...new Set(ids.filter((id,i)=>ids.indexOf(id)!==i))],direction:document.documentElement.dir,navItems:document.querySelectorAll('#bottomTabBar [data-tab]').length,sceneCount:document.querySelectorAll('#content .scene-page').length};});
   results.push({tab,theme,width,height,issues,...geometry});
  }
  if(width<900) for(const [name,open,close] of [['achievements','openAchievements','closeAchievements'],['notifications','openNotifications','closeNotifications'],['settings','openSettings','closeSettings'],['onboarding','openWelcomeModal','closeWelcomeModal']]) {
   await page.evaluate(open=>window[open](),open);await page.waitForTimeout(250);await page.evaluate(axe);
   const issues=await page.evaluate(async()=>{const r=await window.axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa']}});return r.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}));});
   results.push({tab:name,theme,width,height,issues});await page.evaluate(close=>window[close](),close);
  }
  if(width===390) for(const scale of ['large','zoom200','reduced']) {
   await page.evaluate(()=>document.querySelector('[data-tab="add"]').click());
   if(scale==='large')await page.evaluate(()=>window.setTextScalePref('large'));
   if(scale==='zoom200'){await page.evaluate(()=>window.setTextScalePref('normal'));await page.evaluate(()=>document.documentElement.style.zoom='2');}
   if(scale==='reduced'){await page.evaluate(()=>document.documentElement.style.zoom='');await page.emulateMedia({reducedMotion:'reduce'});}
   await page.screenshot({path:`${out}/add-${theme}-${scale}.png`,fullPage:true});
   results.push({scale,theme,overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)});
  }
  await page.close();await writeFile(out+'/results.json',JSON.stringify(results,null,2));
 }
 console.log(JSON.stringify(results));
} finally {await browser.close();await target.close();}
