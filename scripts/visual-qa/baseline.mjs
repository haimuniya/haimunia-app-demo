// Captures the repository HEAD in an isolated temporary tree; never resets
// the working tree. The original dirty-tree core screenshots are in before/.
import {chromium} from '../browser-check/node_modules/playwright/index.mjs';
import {startStaticServer} from '../browser-check/lib/server.mjs';
import {installMockCloud} from '../browser-check/lib/mockCloud.mjs';
import {dismissWelcomeModal} from '../browser-check/lib/actions.mjs';
import {mkdir,writeFile,symlink,mkdtemp} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
const root=process.cwd(),tree=await mkdtemp('/tmp/immersive-baseline-'),out='docs/visual-qa/immersive/before-head';await mkdir(out,{recursive:true});
for(const name of ['index.html','app.js','cloud.js','sw.js'])await writeFile(path.join(tree,name),execFileSync('git',['show','HEAD:'+name],{maxBuffer:8*1024*1024}));
for(const name of ['assets','src','vendor','theme-init.js','cloud-config.js','manifest.json','icon-192.png','icon-512.png','privacy.html','terms.html'])await symlink(path.join(root,name),path.join(tree,name));
const target=await startStaticServer(tree),browser=await chromium.launch();
try{for(const [width,height] of [[390,844],[430,932],[1440,1000]])for(const theme of ['light','dark']){
 const page=await browser.newPage({viewport:{width,height},colorScheme:theme});await installMockCloud(page);await page.goto(target.url);await dismissWelcomeModal(page);await page.evaluate(theme=>document.documentElement.setAttribute('data-theme',theme),theme);
 for(const tab of (width===1440?['add','calendar','history']:['add','calendar','history','wod','community'])){await page.evaluate(tab=>document.querySelector(`[data-tab="${tab}"]`).click(),tab);await page.evaluate(()=>scrollTo(0,0));await page.waitForTimeout(250);await page.screenshot({path:`${out}/${tab}-${theme}-${width}.png`,fullPage:true});}
 if(width<900)for(const [name,open,close]of[['achievements','openAchievements','closeAchievements'],['notifications','openNotifications','closeNotifications'],['settings','openSettings','closeSettings'],['onboarding','openWelcomeModal','closeWelcomeModal']]){await page.evaluate(open=>window[open](),open);await page.waitForTimeout(250);await page.screenshot({path:`${out}/${name}-${theme}-${width}.png`,fullPage:true});await page.evaluate(close=>window[close](),close);}
 await page.close();
}}finally{await browser.close();await target.close();}
console.log('HEAD baseline captured in '+out);
