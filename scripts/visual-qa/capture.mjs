import { chromium } from '../browser-check/node_modules/playwright/index.mjs';
import { resolveLocalOnlyTarget } from '../browser-check/lib/target.mjs';
import { installMockCloud } from '../browser-check/lib/mockCloud.mjs';
import { dismissWelcomeModal } from '../browser-check/lib/actions.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
const out='docs/visual-qa/immersive/'+(process.argv[2]||'final'); await mkdir(out,{recursive:true});
const target=await resolveLocalOnlyTarget(); const browser=await chromium.launch(); const results=[];
try {for(const [width,height] of [[390,844],[430,932],[1440,1000]]) for(const theme of ['light','dark']) {
 const page=await browser.newPage({viewport:{width,height},colorScheme:theme}); await installMockCloud(page); await page.goto(target.url); await dismissWelcomeModal(page);
 await page.evaluate(theme=>document.documentElement.setAttribute('data-theme',theme),theme);
 await page.evaluate(async()=>{
   for(const [name,weight] of [['סקוואט',80],['לחיצת חזה',60],['דדליפט',100]]) {
     await window.addMovement(name,'Squat');
     for(const offset of [28,21,14,7,0]) {
       const date=new Date();date.setDate(date.getDate()-offset);
       const input=document.getElementById('logDateInput');input.value=window.localISODate(date);input.dispatchEvent(new Event('change',{bubbles:true}));
       window.applyFieldValue('step','weight',weight-offset/2);window.applyFieldValue('step','reps',5);window.applyFieldValue('step','sets',3);await window.saveSet();
     }
   }
 });
 await page.waitForTimeout(900);
 await page.evaluate(()=>{document.querySelectorAll('.modal-overlay.open').forEach(el=>{const close=el.querySelector('button[data-action^="close-"]');if(close)close.click()})});
 for(const tab of (width===1440 ? ['add','calendar','history'] : ['add','calendar','history','wod','community'])) {
 await page.evaluate(tab=>document.querySelector(`[data-tab="${tab}"]`).click(),tab);
 await page.evaluate(()=>scrollTo(0,0)); await page.waitForTimeout(350); await page.screenshot({path:`${out}/${tab}-${theme}-${width}.png`,fullPage:true});
 await page.screenshot({path:`${out}/${tab}-${theme}-${width}-viewport.png`});
 if(tab==='calendar'){await page.click('[data-action="cal-toggle-view"]');await page.screenshot({path:`${out}/history-list-${theme}-${width}.png`,fullPage:true});await page.click('[data-action="cal-toggle-view"]');await page.evaluate(()=>scrollTo(0,0));}
 results.push(await page.evaluate(({tab,theme,width,height})=>{const rect=s=>document.querySelector(s)?.getBoundingClientRect();const sheet=rect('.scene-sheet'),media=rect('.scene-page__media');return {tab,theme,width,height,sheet:sheet?.top,sheetPercent:sheet?.top/height*100,mediaHeight:media?.height,pageHeight:rect('.scene-page')?.height,title:parseFloat(getComputedStyle(document.querySelector('.scene-page__title')).fontSize),edges:media?.left===rect('.scene-page')?.left&&media?.width===rect('.scene-page')?.width,fullBackground:media?.height===rect('.scene-page')?.height,padding:parseFloat(getComputedStyle(document.querySelector('.scene-sheet')).paddingLeft),navHeight:rect('#bottomTabBar')?.height,overflow:document.documentElement.scrollWidth>innerWidth}}, {tab,theme,width,height}));
 }
 if(width<900) for(const [name,open,close,selector] of [
 ['achievements','openAchievements','closeAchievements','#achievementsOverlay'],
 ['notifications','openNotifications','closeNotifications','#notificationsOverlay'],
 ['settings','openSettings','closeSettings','#settingsOverlay'],
 ['onboarding','openWelcomeModal','closeWelcomeModal','#welcomeOverlay']]) {
 await page.evaluate(open=>window[open](),open); await page.waitForTimeout(350);
 await page.screenshot({path:`${out}/${name}-${theme}-${width}.png`,fullPage:true});
 await page.evaluate(close=>window[close](),close);
 await writeFile(out+'/measurements.json',JSON.stringify(results,null,2));
 }
 await page.close();
} await writeFile(out+'/measurements.json',JSON.stringify(results,null,2)); console.log(JSON.stringify(results));} finally {await browser.close();await target.close()}
