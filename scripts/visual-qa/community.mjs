import {chromium} from '../browser-check/node_modules/playwright/index.mjs';
import {resolveLocalOnlyTarget} from '../browser-check/lib/target.mjs';
import {installMockCloud} from '../browser-check/lib/mockCloud.mjs';
import {dismissWelcomeModal} from '../browser-check/lib/actions.mjs';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
const out='docs/visual-qa/immersive/final';await mkdir(out,{recursive:true});
const axe=await readFile(new URL('../browser-check/node_modules/axe-core/axe.min.js',import.meta.url),'utf8');
const target=await resolveLocalOnlyTarget(),browser=await chromium.launch(),results=[];
try{for(const [width,height] of [[390,844],[430,932]])for(const theme of ['light','dark']){
 const page=await browser.newPage({viewport:{width,height},colorScheme:theme});const now=new Date().toISOString();
 await installMockCloud(page,{
 profiles:[{id:'u1',handle:'qa_member',display_name:'חבר בדיקה',is_admin:false,recovery_verified_at:now,visible_to_club:true}],
 invite_redemptions:[{user_id:'u1',invite_id:'inv-1',role:'member',redeemed_at:now}],
 clubs:[{id:'club-1',name:'האימוניה'}],
 notifications:[{id:'n1',user_id:'u1',type:'event_cancelled',category:'events',title:'עדכון מהמועדון',body:'הודעת בדיקה מקומית לבדיקת התראות',deep_link:'/community/feed',created_at:now,read_at:null}],
 notification_preferences:[],feed_page_rows:[],follows:[],hidden_posts:[],saved_posts:[]
 },{user:{id:'u1',is_anonymous:false,email:'qa@members.haimuniya.invalid'}});
 await page.goto(target.url);await dismissWelcomeModal(page);await page.evaluate(theme=>document.documentElement.setAttribute('data-theme',theme),theme);
 await page.click('#tabCommunityBtn');await page.waitForSelector('#communityClubTop');await page.waitForTimeout(350);
 for(const screen of ['community-member','notification-center']){
  if(screen==='notification-center'){await page.click('[data-community-action="feed-notifications"]');await page.waitForSelector('[data-notif-center]');await page.waitForTimeout(500);}
  await page.screenshot({path:`${out}/${screen}-${theme}-${width}.png`,fullPage:true});await page.evaluate(axe);
  const issues=await page.evaluate(async()=>{const r=await window.axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa']}});return r.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}));});
  results.push({screen,theme,width,height,issues});
 }
 await page.close();
}await writeFile(out+'/community-verification.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results));}finally{await browser.close();await target.close();}
