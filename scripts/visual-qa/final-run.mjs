// Run screenshot generation and browser checks sequentially so timing
// assertions never compete with screenshot capture or the accessibility scan.
import {spawnSync} from 'node:child_process';
import {openSync,closeSync,mkdirSync} from 'node:fs';
const logDir='docs/visual-qa/immersive/logs';mkdirSync(logDir,{recursive:true});
const checks=[['baseline',['scripts/visual-qa/baseline.mjs']],['capture',['scripts/visual-qa/capture.mjs','final']],['accessibility',['scripts/visual-qa/verify.mjs']],['community',['scripts/visual-qa/community.mjs']],['browser',['scripts/browser-check/run-all.mjs']]];
let failures=0;
for(const [name,args]of checks){console.log('Starting '+name);const fd=openSync(`${logDir}/${name}.log`,'w');const result=spawnSync(process.execPath,args,{stdio:['ignore',fd,fd]});closeSync(fd);console.log(`${name}: ${result.status===0?'PASS':'FAIL'}`);if(result.status!==0)failures++;}
process.exitCode=failures?1:0;
