import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {createHash} from 'node:crypto';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const read=file=>readFileSync(join(root,file),'utf8');
const pngSize=file=>{
  const data=readFileSync(join(root,file));
  assert.equal(data.subarray(1,4).toString(),'PNG',`${file} must be a PNG`);
  return [data.readUInt32BE(16),data.readUInt32BE(20)];
};
const html=read('index.html');

const inlineScripts=[...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(match=>match[1]);
assert.ok(inlineScripts.length>=3,'expected app, title, and service-worker registration scripts');
inlineScripts.forEach((source,index)=>assert.doesNotThrow(()=>new Function(source),`inline script ${index+1} must parse`));

const manifest=JSON.parse(read('manifest.webmanifest'));
assert.equal(manifest.display,'standalone');
assert.equal(manifest.start_url,'./');
assert.ok(manifest.icons.some(icon=>icon.src==='./icon.svg'));
assert.ok(manifest.icons.some(icon=>icon.src==='./icon-192.png'&&icon.sizes==='192x192'));
assert.ok(manifest.icons.some(icon=>icon.src==='./icon-512.png'&&icon.sizes==='512x512'));
read('tokens.css');
read('icon.svg');
const sw=read('sw.js');
assert.deepEqual(pngSize('icon-192.png'),[192,192]);
assert.deepEqual(pngSize('icon-512.png'),[512,512]);
assert.deepEqual(pngSize('apple-touch-icon.png'),[180,180]);
const three=readFileSync(join(root,'vendor/three.r128.min.js'));
assert.equal(createHash('sha512').update(three).digest('base64'),'dLxUelApnYxpLt6K2iomGngnHO83iUvZytA3YjDUCjT0HDOHKXnVYdf3hU4JjM8uEhxf9nD1/ey98U3t2vZ0qQ==');
assert.match(sw,/vendor\/three\.r128\.min\.js/,'offline shell must include the 3D runtime');
assert.match(sw,/isAppEntry&&response\.ok&&response\.type==='basic'/,'navigation errors must not replace the cached app entry');

assert.match(html,/const SEC_PER_MIN=DEMO_MODE\?0\.52:60/,'production timer must use real minutes');
assert.match(html,/const DEMO_MODE=LOCAL_DEVELOPMENT&&queryParams\.get\('demo'\)==='1'/,'accelerated mode must be local-only');
assert.match(html,/window\.ojimateForce2D=\(location\.hostname==='localhost'\|\|location\.hostname==='127\.0\.0\.1'\)/,'2D test mode must be local-only');
assert.match(html,/const STORE_KEY=DEMO_MODE\?'ojimate_memory_demo_v1':'ojimate_memory_v1'/,'demo records must be isolated');
assert.match(html,/appMain\.inert=false/,'START must unlock the application');
assert.match(html,/<main id="appMain" hidden inert aria-hidden="true">/,'the title must hide the inactive application');
assert.match(html,/function persistActiveSession\(/,'active sessions must be persisted');
assert.match(html,/renderRecentLogs\(\)/,'saved history must be restored');
assert.match(html,/@media \(min-width:48rem\)/,'wide layouts must switch to the workbench view');
assert.match(html,/integrity="sha512-/,'vendored runtime must keep its pinned integrity hash');
assert.doesNotMatch(html,/cdnjs\.cloudflare\.com\/ajax\/libs\/three/,'the core 3D runtime must not depend on a CDN');
assert.match(html,/rel="apple-touch-icon"/,'iOS must have an install icon');
assert.match(html,/phone\.classList\.toggle\('is-2d',!rendererReady\)/,'WebGL failure must keep the timer UI available');

const outcomeBody=html.match(/function recordSessionOutcome\([^)]*\)\{([\s\S]*?)\n\}/)?.[1]||'';
assert.doesNotMatch(outcomeBody,/totalFocusMin\s*\+=/,'session totals must not be added twice');

const wrangler=JSON.parse(read('worker/wrangler.jsonc'));
assert.equal(wrangler.ai.binding,'AI');
assert.equal(wrangler.observability.enabled,true);

console.log(`OjiMate smoke checks passed (${inlineScripts.length} inline scripts).`);
