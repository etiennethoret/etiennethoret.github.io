'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const base = path.join(__dirname, '..', 'modulationscope');
const html = fs.readFileSync(path.join(base, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(base, 'app.js'), 'utf8');
const dsp = fs.readFileSync(path.join(base, 'dsp-worker.js'), 'utf8');
assert.match(html, /22 rates signés/);
assert.match(html, /-0\.25;0\.25;0\.5;1;/);
assert.match(html, /0\.71;1;1\.41;2;2\.83;4;5\.66;8/);
assert.match(html, /<option value="custom" selected>/);
assert.match(html, /<option selected>128<\/option>/);
assert.match(app, /function panelsForView\(\)/);
assert.match(html, /<option value="curves-all">Courbes · toutes \(sans moyenne\)<\/option>/);
assert.match(app, /function allCurveInfo\(projection\)/);
assert.match(app, /state\.viewMode==='curves-all'/);
assert.match(app, /Touchez une courbe pour identifier sa tranche/);
assert.match(app, /ModulationScope_toutes_courbes_/);
assert.match(app, /\['sr','fr','fs'\]/);
assert.match(app, /\['tr','ts','tf'\]/);
assert.match(app, /Math\.max\(\.\.\.cfg\.ratesVector\.map\(Math\.abs\)\)/);
assert.match(dsp, /Math\.cos\(2\*Math\.PI\*Math\.abs\(r\)\*lag\)/);
const messages=[];
const context=vm.createContext({postMessage:m=>messages.push(m),performance:{now:()=>1000},console});
vm.runInContext(dsp,context,{filename:'dsp-worker.js'});
const rates=[-32,-22.6,-16,-11.3,-8,-5.70,-4,-2,-1,-.5,-.25,.25,.5,1,2,4,5.70,8,11.3,16,22.6,32];
const scales=[.71,1,1.41,2,2.83,4,5.66,8];
const cfg={mode:'log',bands:128,refreshHz:2,cycles:3,integration:6,capEnabled:false,
  gridMode:'custom',maxRate:32,ratesCount:7,scalesCount:6,
  direction:'both',ratesVector:rates,scalesVector:scales,sampleRate:48000,
  fftSize:1024,fftWindow:2,overlap:50,stftOverlap:75};
context.onmessage({data:{kind:'config',config:cfg}});
const configured=messages.find(x=>x.kind==='configured');
assert.equal(configured.hop,192);
assert.equal(Math.round(configured.frameHz),250);
const f=250;
const data=Array.from({length:1200},(_,t)=>{
 const row=new Float32Array(128);
 for(let b=0;b<128;b++){
  const logF=b*Math.log2(10000/125)/127;
  row[b]=-30+7*Math.cos(2*Math.PI*(logF-8*t/f));
 }
 return row;
});
context.testFrames=data;
vm.runInContext('frames=testFrames; calculateLog();',context);
const result=messages.find(x=>x.kind==='result');
assert.ok(result,'Expected Gabor result');
assert.equal(result.axes.rates.length,22);
assert.equal(result.axes.scales.length,8);
assert.equal(result.axes.acoustic.length,128);
assert.equal(result.sr.length,8);
assert.equal(result.sr[0].length,22);
assert.equal(result.fr.length,128);
assert.equal(result.fr[0].length,22);
assert.equal(result.fs.length,128);
assert.equal(result.fs[0].length,8);
assert.ok(result.sr.some(row=>row.some(Number.isFinite)),'Expected finite power');
assert.ok(result.integrations.every(x=>x>0),'Expected finite integration durations');
console.log('PASS: published 2021 grid, 250-Hz frontend, three coherent map dimensions and signed rates');
