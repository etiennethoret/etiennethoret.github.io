'use strict';
(() => {
const $=id=>document.getElementById(id);
let plot=$('chart'),ctx=plot.getContext('2d',{alpha:false});
const state={running:false,frozen:false,worker:null,stream:null,audioCtx:null,source:null,recorder:null,
  config:null,data:null,history:[],current:null,projection:'sr',span:30,selected:null,
  timeLast:null,observedHz:null,generation:0,plotRect:null,dims:null,restartTimeout:null,viewMode:'map',curveAxis:'x',curveScaleManual:false,curveMinDb:-60,curveMaxDb:0,
  colorRef:null};
const axisLabels={sr:['Rate (Hz)','Scale (cyc/oct)'],fr:['Rate (Hz)','Fréquence (Hz)'],fs:['Scale (cyc/oct)','Fréquence (Hz)'],
  tr:['Temps relatif (s)','Rate (Hz)'],ts:['Temps relatif (s)','Scale (cyc/oct)'],tf:['Temps relatif (s)','Fréquence (Hz)'],nhb:['Temps relatif (s)','Fréquence cochléaire (Hz)']};
const titles={sr:'SCALE × RATE',fr:'FRÉQUENCE × RATE',fs:'FRÉQUENCE × SCALE',tr:'TEMPS × RATE',ts:'TEMPS × SCALE',tf:'TEMPS × FRÉQUENCE · ÉNERGIE STRF',nhb:'TEMPS × FRÉQUENCE · SPECTROGRAMME NHB'};
const viridis=['#440154','#482878','#3e4989','#31688e','#26828e','#1f9e89','#35b779','#6ece58','#b5de2b','#fde725'];
const rgb=viridis.map(c=>[parseInt(c.slice(1,3),16),parseInt(c.slice(3,5),16),parseInt(c.slice(5,7),16)]);
const values=[...document.querySelectorAll('input[type=number],select,textarea')];
function validateVector(text,label,min,max){if(!text.trim())return null;
 const a=text.trim().split(/[;,\s]+/).filter(Boolean).map(v=>Number(v));
 if(a.length<2||a.length>64||a.some(v=>!Number.isFinite(v)||v<min||v>max)||a.some((v,i)=>i&&v<=a[i-1]))throw Error(label+': 2 à 64 valeurs croissantes dans ['+min+', '+max+']');
 return a;
}
function configFromUI(){
 const n=id=>Number($(id).value),mode=document.querySelector('input[name=mode]:checked').value;
 const linLimited=$('linRefreshLimit').checked;
 const cfg={
  mode,bands:n('bands'),
  refreshHz:mode==='log'?n('refreshHz'):linLimited?n('linRefreshHz'):30,
  linRefreshLimited:linLimited,
  cycles:n('cycles'),integration:n('integration'),capEnabled:$('capEnabled').checked,
  gridMode:$('gridMode').value,maxRate:n('maxRate'),
  ratesCount:n('ratesCount'),scalesCount:n('scalesCount'),direction:$('direction').value,
  fftSize:n('fftSize'),fftWindow:n('fftWindow'),overlap:n('overlap'),stftOverlap:n('stftOverlap'),
  ratesVector:null,scalesVector:null,nhb:state.projection==='nhb',nhbSpan:state.span,sampleRate:state.audioCtx?.sampleRate||44100
 };
 if(mode==='log'){
  if(!Number.isFinite(cfg.cycles)||cfg.cycles<1||cfg.cycles>12)throw Error('Cycles : 1 à 12');
  if(cfg.capEnabled&&(!Number.isFinite(cfg.integration)||cfg.integration<.1||cfg.integration>20))
    throw Error('Plafond d’intégration : 0,1 à 20 s');
  if(cfg.gridMode==='custom'){
    cfg.ratesVector=validateVector($('ratesVector').value,'Rates',-128,128);
    if(cfg.ratesVector.some(r=>r===0))throw Error('Rates : zéro interdit');
    if(cfg.ratesVector.some(r=>Math.abs(r)<.25))throw Error('Rates : magnitude minimale 0,25 Hz');
    cfg.scalesVector=validateVector($('scalesVector').value,'Scales',0,8);
    if(!cfg.ratesVector||!cfg.scalesVector)throw Error('Saisir les deux vecteurs : rates et scales');
    cfg.maxRate=Math.max(...cfg.ratesVector.map(Math.abs));
  }
 }else{
  if(!Number.isFinite(cfg.fftWindow)||cfg.fftWindow<.1||cfg.fftWindow>20)
    throw Error('Fenêtre FFT 2D : 0,1 à 20 s');
  if(!Number.isFinite(cfg.overlap)||cfg.overlap<0||cfg.overlap>95)
    throw Error('Recouvrement MPS : 0 à 95 %');
 }
 if(cfg.nhb)cfg.refreshHz=Math.min(8,n('refreshHz')); // NHB cochlear filtering is CPU-intensive.
 if(!Number.isFinite(cfg.refreshHz)||cfg.refreshHz<.2||cfg.refreshHz>30)
    throw Error('Cadence : 0,2 à 30 Hz');
 return cfg;
}
function warn(msg=''){$('error').textContent=msg;}
function updateGridControls(){
 const custom=$('gridMode').value==='custom';
 $('automaticGrids').classList.toggle('hidden',custom);
 $('customGrids').classList.toggle('hidden',!custom);
 $('capField').classList.toggle('hidden',!$('capEnabled').checked);
 $('linRefreshField').classList.toggle('hidden',!$('linRefreshLimit').checked);
 $('directionControl').classList.toggle('hidden',custom);
 $('gridSummary').textContent=custom
 ? 'Grille du papier 2021 : les 22 rates signés intègrent les deux directions, et les 8 scales couvrent 0,71 à 8 cyc/oct. Les filtres restent une approximation Gabor.'
 : 'Grilles automatiques : rates positifs logarithmiques, scales de 0 à 4 cyc/oct. La direction est sélectionnable.';
}
function updateMode(){
 const lin=document.querySelector('input[name=mode]:checked').value==='lin';
 $('logSettings').classList.toggle('hidden',lin);
 $('linSettings').classList.toggle('hidden',!lin);
 $('logCadenceControl').classList.toggle('hidden',lin);
 $('modeNote').textContent=lin
 ? 'FFT 2D du spectrogramme : l’overlap MPS règle le pas de calcul. Le plafond de cadence est facultatif.'
 : 'Filtres Gabor locaux multirésolution : grille automatique ou vecteurs personnalisés.';
 const menu=$('projection');for(const option of menu.options)option.disabled=lin&&option.value!=='sr'&&option.value!=='nhb';
 if(lin && state.projection!=='nhb'){menu.value='sr';state.projection='sr';}
 updateGridControls();updateChart();
}
function updateLinearInfo(cfg){
 if(cfg.mode!=='lin')return;
 const hop=Math.max(32,Math.round(cfg.fftSize*(1-cfg.stftOverlap/100)/32)*32);
 const hz=cfg.sampleRate/hop,requested=cfg.fftWindow*hz;
 const n=Math.max(16,Math.min(2048,Math.pow(2,Math.ceil(Math.log2(Math.max(1,requested))))));
 const stride=Math.max(1,Math.round(n*(1-cfg.overlap/100)));
 const effective=n/hz,step=stride/hz;
 $('linStepNote').textContent='Fenêtre MPS effective : '+effective.toFixed(2)+' s'+
 ' · pas entre fenêtres : '+step.toFixed(2)+' s'+
 ' · cadence intrinsèque : '+(1/step).toFixed(2)+' Hz.'+
 (cfg.linRefreshLimited?' Plafond supplémentaire : '+cfg.refreshHz.toFixed(1)+' Hz.':' Aucun plafond supplémentaire.')+
 ' La FFT MPS est arrondie à une puissance de deux, 2048 trames max.';
}
function applyConfig(){clearTimeout(state.restartTimeout);
 try{
  const cfg=configFromUI();warn();state.config=cfg;state.history=[];state.data=null;state.colorRef=null;
  state.selected=null;state.current=null;state.timeLast=null;state.observedHz=null;
  updateLinearInfo(cfg);
  if(state.running&&state.worker){cfg.sampleRate=state.audioCtx.sampleRate;state.worker.postMessage({kind:'config',config:cfg});}
  updateChart();
 }catch(e){warn(e.message);}
}
function scheduleSettings(){clearTimeout(state.restartTimeout);state.restartTimeout=setTimeout(applyConfig,650);}
// dB range is display-only; editing it must never restart the microphone or DSP.
function updateCurveRange(){
 const note=$('curveScaleNote');
 if(!state.curveScaleManual){
  note.textContent='Échelle automatique indépendante pour chaque courbe.';
  note.style.color='';
  return true;
 }
 const a=$('curveDbMin').value.trim(),b=$('curveDbMax').value.trim();
 const lo=Number(a),hi=Number(b);
 if(!a||!b||!Number.isFinite(lo)||!Number.isFinite(hi)||lo>=hi){
  note.textContent='Plage invalide : dB min doit être inférieur à dB max. Dernières limites valides conservées.';
  note.style.color='#f5a48e';
  return false;
 }
 state.curveMinDb=lo;state.curveMaxDb=hi;
 note.textContent='Échelle fixe commune : '+lo.toLocaleString('fr-FR')+' à '+hi.toLocaleString('fr-FR')+
  ' dB (référence de puissance verrouillée).';
 note.style.color='';
 return true;
}
values.forEach(el=>{
 const fn=el.tagName==='SELECT'?'change':'input';el.addEventListener(fn,()=>{
  if(el.id==='displayMode'){
    state.viewMode=el.value;state.selected=null;
    $('curveAxisControl').classList.toggle('hidden',state.viewMode!=='curves');
    $('curveScaleControl').classList.toggle('hidden',state.viewMode!=='curves');
    $('curveScaleNote').classList.toggle('hidden',state.viewMode!=='curves');
    updateChart();return;
  }
  if(el.id==='curveAxis'){
    state.curveAxis=el.value;state.selected=null;updateChart();return;
  }
  if(el.id==='curveScaleMode'){
    state.curveScaleManual=el.value==='manual';
    $('curveMinField').classList.toggle('hidden',!state.curveScaleManual);
    $('curveMaxField').classList.toggle('hidden',!state.curveScaleManual);
    updateCurveRange();updateChart();return;
  }
  if(el.id==='curveDbMin'||el.id==='curveDbMax'){
    updateCurveRange();updateChart();return;
  }
  if(el.id==='projection'){
    const wasNHB=state.projection==='nhb';
    state.projection=el.value;state.selected=null;
    if(wasNHB!==(state.projection==='nhb'))applyConfig();else updateChart();
    return;
  }
  if(el.id==='timeSpan'){
    state.span=Number(el.value);
    if(state.projection==='nhb'){
      if(state.config)state.config.nhbSpan=state.span;
      if(state.running&&state.worker)state.worker.postMessage({kind:'nhbSpan',span:state.span});
    }
    updateChart();return;
  }
  if(el.id==='gridMode')updateGridControls();
  if(el.tagName==='SELECT')applyConfig();else scheduleSettings();
 });
});
['capEnabled','linRefreshLimit'].forEach(id=>{
 $(id).addEventListener('change',()=>{updateGridControls();applyConfig();});
});
document.querySelectorAll('input[name=mode]').forEach(el=>el.addEventListener('change',()=>{updateMode();applyConfig();}));
async function start(){if(state.running)return;
 if(!window.isSecureContext)throw Error('Microphone disponible uniquement sur HTTPS ou localhost');
 if(!navigator.mediaDevices?.getUserMedia)throw Error('Microphone indisponible dans ce navigateur');
 warn();const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false,channelCount:1},video:false});
 const audioCtx=new (window.AudioContext||window.webkitAudioContext)();
 try{
 await audioCtx.audioWorklet.addModule('capture-processor.js');
 state.audioCtx=audioCtx;let cfg=configFromUI();cfg.sampleRate=audioCtx.sampleRate;
 const worker=new Worker('dsp-worker.js');const generation=++state.generation;state.worker=worker;
 worker.onmessage=e=>{if(!state.running||generation!==state.generation)return;
  if(e.data.kind==='error')warn(e.data.message);
  else if(e.data.kind==='result')onResult(e.data);
  else if(e.data.kind==='configured')$('details').textContent=e.data.nhb
    ? `Micro ${Math.round(audioCtx.sampleRate)} Hz · NHB 16 kHz / 250 Hz / 128 canaux`
    : `Micro ${Math.round(audioCtx.sampleRate)} Hz · STFT ${e.data.fftSize} / hop ${e.data.hop}`;
 };
 worker.onerror=e=>warn('Erreur du moteur de calcul : '+e.message);
 worker.postMessage({kind:'config',config:cfg});
 const source=audioCtx.createMediaStreamSource(stream);
 const recorder=new AudioWorkletNode(audioCtx,'modulation-capture',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});
 recorder.port.onmessage=e=>{if(state.running&&generation===state.generation&&state.worker)state.worker.postMessage({kind:'audio',data:e.data},[e.data.buffer]);};
 const silent=audioCtx.createGain();silent.gain.value=0;
 source.connect(recorder);recorder.connect(silent);silent.connect(audioCtx.destination);
 state.source=source;state.recorder=recorder;state.stream=stream;state.running=true;state.frozen=false;state.history=[];state.config=cfg;state.colorRef=null;
 $('toggleMicro').textContent='Arrêter';$('state').textContent='● Micro actif';$('state').style.color='#65ddc6';$('freeze').textContent='Figer';
 $('freeze').disabled=false;await audioCtx.resume();updateChart();
 }catch(e){stream.getTracks().forEach(track=>track.stop());try{await audioCtx.close();}catch(_){/*ignore*/}state.stream=null;state.audioCtx=null;state.worker?.terminate();state.worker=null;throw e;}
}
function stop(){state.running=false;state.generation++;
 if(state.stream)state.stream.getTracks().forEach(track=>track.stop());
 try{state.source?.disconnect();state.recorder?.disconnect();}catch(_){/*ignore*/}
 state.worker?.terminate();state.worker=null;state.stream=null;
 state.audioCtx?.close().catch(()=>{});state.audioCtx=null;
 $('toggleMicro').textContent='Démarrer';$('state').textContent='● Micro arrêté';$('state').style.color='';updateChart();
}
$('toggleMicro').onclick=async()=>{if(state.running)stop();else try{await start();}catch(e){warn(e.message);}};
$('freeze').onclick=()=>{state.frozen=!state.frozen;$('freeze').textContent=state.frozen?'Reprendre':'Figer';};
function onResult(data){if(state.frozen)return;
 const now=performance.now();if(state.timeLast){const hz=1000/(now-state.timeLast);state.observedHz=state.observedHz==null?hz:.75*state.observedHz+.25*hz;}
 state.timeLast=now;state.data=data;
 // Choose a fixed power reference once per configuration, never every refresh.
 if(state.colorRef===null)state.colorRef=powerReference(data);
 if(data.mode==='log'){
  const avgColumns=(matrix,which)=>{
   if(!matrix)return[];if(which==='column'){const n=matrix[0].length;return Array.from({length:n},(_,j)=>matrix.reduce((s,row)=>s+(Number.isFinite(row[j])?row[j]:0),0)/matrix.length);}
   return matrix.map(row=>row.reduce((s,x)=>s+(Number.isFinite(x)?x:0),0)/row.length);
  };
  state.history.push({t:now/1000,rate:avgColumns(data.sr,'column'),scale:avgColumns(data.sr,'row'),freq:avgColumns(data.fs,'row')});
  while(state.history.length>4000||state.history.length&&now/1000-state.history[0].t>75)state.history.shift();
 }
 const basics=`Micro ${Math.round(state.audioCtx?.sampleRate||0)} Hz · niveau ${data.rms.toFixed(1)} dBFS · cadence observée ${state.observedHz?.toFixed(1)||'—'} Hz`;
 $('details').textContent=data.mode==='nhb'
  ? `${basics} · NHB 2021 · 128 canaux cochléaires · 250 trames/s · affichage ${state.config.refreshHz.toFixed(1)} Hz`
  : data.mode==='lin'
  ? `${basics} · FFT2 ${(data.effectiveWindow||0).toFixed(2)} s · pas MPS ${(data.mpsStepSeconds||0).toFixed(2)} s`+
    (state.config.linRefreshLimited?` · plafond ${state.config.refreshHz.toFixed(1)} Hz`:'')
  : `${basics} · cible ${state.config.refreshHz.toFixed(1)} Hz · rate max ${state.config.maxRate} Hz`;
 $('exportPng').disabled=false;$('exportCsv').disabled=false;updateChart();
}
function timeProjection(code){if(!state.history.length||!state.data)return null;
 const a=state.data.axes,axis=code==='tr'?a.rates:code==='ts'?a.scales:a.acoustic;
 const n=151,duration=state.span,step=duration/(n-1),newest=state.history[state.history.length-1].t;
 const xs=Array.from({length:n},(_,i)=>-duration+i*step);
 const map=axis.map(()=>Array(n).fill(NaN));let idx=0;
 let hold=1.5;if(state.history.length>=2)hold=Math.max(1.5,Math.min(15,(state.history.at(-1).t-state.history.at(-2).t)*1.25));
 for(let j=0;j<n;j++){
  const t=newest+xs[j];while(idx+1<state.history.length&&state.history[idx+1].t<=t+1e-7)idx++;
  const s=state.history[idx];if(t<s.t-1e-7||t-s.t>hold)continue;
  const values=code==='tr'?s.rate:code==='ts'?s.scale:s.freq;
  for(let i=0;i<axis.length;i++)map[i][j]=values[i];
 }
 return {xs,ys:axis,map};
}
function selectedProjection(){const d=state.data;if(!d)return null;
 const code=state.projection,axes=d.axes;
 if(code==='sr')return {xs:axes.rates,ys:axes.scales,map:d.sr};
 if(code==='fr'&&d.fr)return {xs:axes.rates,ys:axes.acoustic,map:d.fr};
 if(code==='fs'&&d.fs)return {xs:axes.scales,ys:axes.acoustic,map:d.fs};
 return timeProjection(code);
}
// Fixed color normalization: no automatic normalization by the current image peak.
function powerReference(data){
 if(!data)return null;
 const matrix=data.mode==='nhb'?data.nhb?.map:data.sr;
 if(!matrix||!matrix.length)return null;
 let maximum=0;
 if(data.mode==='nhb'){
  // Use only recent cochlear frames, not earlier, louder history.
  for(const row of matrix){
   for(let j=Math.max(0,row.length-3);j<row.length;j++){
    const value=row[j];if(Number.isFinite(value))maximum=Math.max(maximum,value);
   }
  }
 }else for(const row of matrix)for(const value of row)
  if(Number.isFinite(value))maximum=Math.max(maximum,value);
 return maximum>1e-20?maximum:null;
}
function relativeDb(map){
 const reference=state.colorRef||1e-12;
 return map.map(row=>row.map(v=>Number.isFinite(v)?
  10*Math.log10(Math.max(1e-21,v)/reference):NaN));
}
function marginal(map,axis){if(!map)return[];const ny=map.length,nx=map[0]?.length||0;
 if(axis==='x')return Array.from({length:nx},(_,j)=>{let sum=0,n=0;for(let i=0;i<ny;i++){let v=map[i][j];if(Number.isFinite(v)){sum+=v;n++;}}return n?sum/n:NaN;});
 return map.map(row=>{let sum=0,n=0;for(let v of row)if(Number.isFinite(v)){sum+=v;n++;}return n?sum/n:NaN;});
}
function dbVector(power){const max=Math.max(1e-20,...power.filter(Number.isFinite));return power.map(v=>Number.isFinite(v)?Math.max(-90,10*Math.log10(Math.max(v,1e-21)/max)):NaN);}
function range(values){const a=values.filter(Number.isFinite).sort((x,y)=>x-y);if(!a.length)return[-12,0];const lo=a[Math.floor(.05*(a.length-1))],hi=a[Math.ceil(.95*(a.length-1))];const span=Math.max(3,hi-lo),mid=(hi+lo)/2;return[mid-.58*span,mid+.58*span];}
function clamp(x,a,b){return Math.max(a,Math.min(b,x));}
function blend(v){const z=clamp((v+60)/60,0,1)*(rgb.length-1),i=Math.min(rgb.length-2,Math.floor(z)),f=z-i;const a=rgb[i],b=rgb[i+1];return`rgb(${Math.round(a[0]+f*(b[0]-a[0]))},${Math.round(a[1]+f*(b[1]-a[1]))},${Math.round(a[2]+f*(b[2]-a[2]))})`;}
function drawLine(points,color,width=1.5){ctx.beginPath();let active=false;for(let i=0;i<points.length;i++){
 const p=points[i];if(!p||!Number.isFinite(p[0])||!Number.isFinite(p[1])){active=false;continue;}
 if(!active)ctx.moveTo(p[0],p[1]);else ctx.lineTo(p[0],p[1]);active=true;
 }ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke();}
function label(t,x,y,align='left',color='#b8cbd5',size=11){ctx.fillStyle=color;ctx.textAlign=align;ctx.font=`${size}px system-ui,sans-serif`;ctx.fillText(t,x,y);ctx.textAlign='left';}
function formatAxis(v,code,axis){const kind=(code[0]==='t'||code==='nhb')&&axis==='x'?'time':code==='sr'?(axis==='x'?'rate':'scale'):
 code==='fr'?(axis==='x'?'rate':'frequency'):code==='fs'?(axis==='x'?'scale':'frequency'):
 code==='tr'?'rate':code==='ts'?'scale':'frequency';
 if(kind==='time')return `${v.toFixed(1)} s`;if(kind==='scale')return `${v.toFixed(2)} cyc/oct`;
 if(kind==='rate')return `${v.toFixed(2)} Hz`;return`${v.toFixed(1)} Hz`;
}

function tickValues(values,code,axis){
 if((code[0]==='t'||code==='nhb')&&axis==='x')return[-state.span,-state.span/2,0];
 const axisName=axisLabels[code][axis==='x'?0:1],min=values[0],max=values.at(-1);
 let ticks;
 if(axisName.startsWith('Rate'))ticks=min<0?[-128,-64,-32,-16,-4,-1,1,4,16,32,64,128]:[0,.5,1,2,4,8,16,32,64,128];
 else if(axisName.startsWith('Scale'))ticks=max>4?[0,.71,1,2,4,5.66,8]:[0,.5,1,2,3,4];
 else ticks=code==='nhb'?[250,500,1000,2000,4000,7000]:[125,500,2000,8000];
 ticks=ticks.filter(v=>v>=min-1e-7&&v<=max+1e-7);
 if(ticks.length>4)return Array.from({length:4},(_,i)=>ticks[Math.round(i*(ticks.length-1)/3)]);
 return ticks;
}
function closest(values,target){let best=0,err=Infinity;for(let i=0;i<values.length;i++){const d=Math.abs(values[i]-target);if(d<err){err=d;best=i;}}return best;}
function formatShort(v){if(v===0)return '0';if(Math.abs(v)>=1000)return (v/1000).toFixed(0)+'k';if(Math.abs(v)<1)return v.toFixed(2);return Number.isInteger(v)?''+v:v.toFixed(1);}
function projectionForCode(code){
 const d=state.data;if(!d)return null;
 if(code==='nhb')return d.mode==='nhb'?d.nhb:null;
 if(d.mode==='nhb')return null;
 const axes=d.axes;
 if(code==='sr')return {xs:axes.rates,ys:axes.scales,map:d.sr};
 if(code==='fr')return d.fr?{xs:axes.rates,ys:axes.acoustic,map:d.fr}:null;
 if(code==='fs')return d.fs?{xs:axes.scales,ys:axes.acoustic,map:d.fs}:null;
 if(code[0]==='t'&&d.mode==='log')return timeProjection(code);
 return null;
}
function panelsForView(){
 const group=state.projection==='nhb'?['nhb']:state.projection==='tr'?['tr','ts','tf']:['sr','fr','fs'];
 return group.map(code=>({code,projection:projectionForCode(code)}));
}
/** Draw power-averaged 1D profile with independent labelled ordinate range. */
function drawCurvePanel(projection,code,left,right,top,bottom){
 const alongX=state.curveAxis==='x';
 const power=window.ModulationCurves.marginal(projection.map,state.curveAxis);
 const axis=alongX?projection.xs:projection.ys;
 const dB=window.ModulationCurves.toDb(power,state.colorRef||1e-12);
 const [lo,hi]=window.ModulationCurves.selectRange(dB,
  state.curveScaleManual?[state.curveMinDb,state.curveMaxDb]:null);
 const n=dB.length,w=right-left,h=bottom-top;
 ctx.fillStyle='#142533';ctx.fillRect(left,top,w,h);
 ctx.strokeStyle='#344b5a';ctx.lineWidth=.8;
 for(let i=0;i<=4;i++){
  const y=top+h*i/4;
  ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(right,y);ctx.stroke();
  label((hi-(hi-lo)*i/4).toFixed(1),left-3,y+3,'right','#98adba',8);
 }
 const pts=[];
 for(let i=0;i<n;i++)pts.push(Number.isFinite(dB[i])
   ?[left+(i+.5)*w/n,bottom-(dB[i]-lo)/(hi-lo)*h]:null);
 // Clip values outside the chosen range instead of flattening them to its edges.
 ctx.save();ctx.beginPath();ctx.rect(left,top,w,h);ctx.clip();
 drawLine(pts,'#65ddc6',2);
 ctx.restore();
 for(let k=0;k<3;k++){
  const j=Math.round(k*(axis.length-1)/2);
  label(formatShort(axis[j]),left+(j+.5)*w/n,bottom+11,'center','#a8bac6',9);
 }
 label(alongX?'Profil X · moyenne sur Y':'Profil Y · moyenne sur X',
   left+w/2,top-8,'center','#dce9ee',10);
 label(axisLabels[code][alongX?0:1],left+w/2,bottom+26,'center','#dce9ee',9);
 const selected=state.selected?.code===code?
   (alongX?state.selected.j:state.selected.i):-1;
 if(selected>=0 && selected<n && Number.isFinite(dB[selected])){
  const x=left+(selected+.5)*w/n;
  const y=bottom-(dB[selected]-lo)/(hi-lo)*h;
  ctx.strokeStyle='#fff';ctx.lineWidth=1;
  ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,bottom);ctx.stroke();
  if(y>=top&&y<=bottom){
   ctx.beginPath();ctx.arc(x,y,3.3,0,Math.PI*2);ctx.stroke();
  }
  return titles[code]+' · '+formatAxis(axis[selected],code,alongX?'x':'y')+
   ' · '+dB[selected].toFixed(2)+' dB (référence fixe)';
 }
 return '';
}

function updateChart(){
 const legend=$('colorRefInfo');
 if(legend)legend.textContent=state.colorRef===null
  ? 'En attente du premier signal'
  : 'Référence verrouillée (0 dB = '+state.colorRef.toExponential(2)+' unité de puissance)';
 const w=plot.clientWidth,h=plot.clientHeight;if(!w||!h)return;
 const dpr=Math.min(2,devicePixelRatio||1);
 if(plot.width!==Math.round(w*dpr)||plot.height!==Math.round(h*dpr)){plot.width=Math.round(w*dpr);plot.height=Math.round(h*dpr);}
 ctx.setTransform(dpr,0,0,dpr,0,0);ctx.fillStyle='#0d1620';ctx.fillRect(0,0,w,h);
 const panels=panelsForView(),count=panels.length,vertical=count>1&&w<820,
  wide=vertical?w:w/count,tall=vertical?h/count:h;
 state.currentPanels=panels;state.plotRects=[];
 $('plotTitle').textContent=state.projection==='nhb'
  ? 'SPECTROGRAMME AUDITIF NHB · TEMPS × FRÉQUENCE'
  : state.projection==='tr'
  ? 'TEMPS × RATE / TEMPS × SCALE / TEMPS × FRÉQUENCE · STRF'
  : 'SCALE × RATE / FRÉQUENCE × RATE / FRÉQUENCE × SCALE';
 $('plotSubtitle').textContent=state.data?(state.data.mode==='nhb'
  ? 'NHB 2021 · 128 canaux cochléaires · 250 Hz'
  : state.data.mode==='lin'?'FFT 2D':'Gabor multirésolution'):'Micro non actif';
 if(state.viewMode==='curves')$('plotSubtitle').textContent+=' · COURBES '+state.curveAxis.toUpperCase()+
  (state.curveScaleManual?' · '+state.curveMinDb+' à '+state.curveMaxDb+' dB':' · dB auto');
 let readout=count===1?'Touchez le spectrogramme pour lire temps, fréquence et dB relatifs.'
  :'Touchez un des trois cadrans pour lire X, Y et les dB relatifs.';
 for(let p=0;p<count;p++){
  const code=panels[p].code,projection=panels[p].projection,ox=vertical?0:p*wide,oy=vertical?p*tall:0;
  const left=ox+(wide<290?34:42),right=ox+wide-(count===1?43:38),top=oy+21,bottom=oy+tall-(count===1?51:45);
  state.plotRects.push({left,right,top,bottom,code,projection});
  ctx.fillStyle=p%2?'#0f1c26':'#0e1923';ctx.fillRect(ox,oy,wide,tall);
  if(p>0){ctx.strokeStyle='#263746';ctx.beginPath();if(vertical){ctx.moveTo(0,oy);ctx.lineTo(w,oy);}else{ctx.moveTo(ox,0);ctx.lineTo(ox,h);}ctx.stroke();}
  label(titles[code],ox+wide/2,oy+12,'center','#e5eef4',10);
  if(right-left<35||bottom-top<18)continue;
  ctx.fillStyle='#142533';ctx.fillRect(left,top,right-left,bottom-top);
  if(!projection||!projection.map){
   label(state.data?.mode==='lin'?'Indisponible en FFT 2D':'En attente du micro',left+3,top+20,'left','#8ca5b5',10);continue;
  }
  if(state.viewMode==='curves'){
   const r=drawCurvePanel(projection,code,left,right,top,bottom);
   if(r)readout=r;
   continue;
  }
  const db=relativeDb(projection.map),rows=db.length,cols=db[0]?.length||0;
  if(!rows||!cols)continue;
  const cw=(right-left)/cols,ch=(bottom-top)/rows;
  for(let i=0;i<rows;i++)for(let j=0;j<cols;j++){
   const v=db[i][j];if(Number.isFinite(v)){ctx.fillStyle=blend(v);ctx.fillRect(left+j*cw,top+(rows-i-1)*ch,Math.ceil(cw+.1),Math.ceil(ch+.1));}
  }
  ctx.strokeStyle='#607687';ctx.lineWidth=.7;ctx.strokeRect(left+.5,top+.5,right-left,bottom-top);
  const mx=dbVector(marginal(projection.map,'x')),my=dbVector(marginal(projection.map,'y')),xr=range(mx),yr=range(my);
  const ht=bottom+14,hb=bottom+25,vx=right+5,vw=15;
  ctx.fillStyle='#172a35';ctx.fillRect(left,ht,right-left,hb-ht);ctx.fillRect(vx,top,vw,bottom-top);
  drawLine(mx.map((v,j)=>Number.isFinite(v)?[left+(j+.5)*cw,hb-clamp((v-xr[0])/(xr[1]-xr[0]),0,1)*(hb-ht)]:null),'#65ddc6',1.2);
  drawLine(my.map((v,i)=>Number.isFinite(v)?[vx+clamp((v-yr[0])/(yr[1]-yr[0]),0,1)*vw,top+(rows-i-.5)*ch]:null),'#65ddc6',1.2);
  for(const value of tickValues(projection.xs,code,'x')){const j=closest(projection.xs,value);label(formatShort(value),left+(j+.5)*cw,bottom+9,'center','#a8bac6',8);}
  for(const value of tickValues(projection.ys,code,'y')){const i=closest(projection.ys,value);label(formatShort(value),left-3,top+(rows-i-.5)*ch+2,'right','#a8bac6',8);}
  const axes=axisLabels[code];label(axes[0],(left+right)/2,oy+tall-7,'center','#c0d3dc',9);
  ctx.save();ctx.translate(ox+10,(top+bottom)/2);ctx.rotate(-Math.PI/2);label(axes[1],0,0,'center','#c0d3dc',9);ctx.restore();
  if(state.selected?.code===code){
   const i=clamp(state.selected.i,0,rows-1),j=clamp(state.selected.j,0,cols-1),xx=left+(j+.5)*cw,yy=top+(rows-i-.5)*ch;
   ctx.strokeStyle='#fff';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(right,yy);ctx.moveTo(xx,top);ctx.lineTo(xx,bottom);ctx.stroke();
   ctx.beginPath();ctx.arc(xx,yy,3,0,2*Math.PI);ctx.stroke();
   const v=db[i][j];
   readout=titles[code]+' · X '+formatAxis(projection.xs[j],code,'x')+' · Y '+formatAxis(projection.ys[i],code,'y')+' · '+(Number.isFinite(v)?v.toFixed(2)+' dB':'non mesuré');
  }
 }
 $('readout').textContent=readout;
}
function selectPoint(e){
 const bounds=plot.getBoundingClientRect(),x=e.clientX-bounds.left,y=e.clientY-bounds.top;
 for(const rect of state.plotRects||[]){
  const {left,right,top,bottom,code,projection}=rect;
  if(!projection||x<left||x>=right||y<top||y>=bottom)continue;
  const rows=projection.map.length,cols=projection.map[0]?.length||0;
  if(state.viewMode==='curves'){
   const alongX=state.curveAxis==='x';
   const n=alongX?cols:rows;
   const index=clamp(Math.floor((x-left)/(right-left)*n),0,n-1);
   state.selected={code,i:alongX?0:index,j:alongX?index:0};
   updateChart();return;
  }
  if(!rows||!cols)continue;
  const j=clamp(Math.floor((x-left)/(right-left)*cols),0,cols-1);
  const i=rows-1-clamp(Math.floor((y-top)/(bottom-top)*rows),0,rows-1);
  state.selected={code,i,j};updateChart();return;
 }
}
plot.addEventListener('pointerdown',e=>{selectPoint(e);plot.setPointerCapture(e.pointerId);});
plot.addEventListener('pointermove',e=>{if(e.buttons)selectPoint(e);});
function download(name,blob){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}
$('exportPng').onclick=()=>plot.toBlob(b=>{if(b)download('ModulationScope_'+state.projection+'_'+Date.now()+'.png',b);},'image/png');
$('exportCsv').onclick=()=>{
 const panels=panelsForView(),lines=['projection,x_value,y_value,x_unit,y_unit,power_linear,relative_db,mode,fixed_reference_power'];
 if(state.viewMode==='curves'){
  const rows=['projection,curve_axis,coordinate,unit,power_linear,db_relative,reference_power,mode,db_scale_mode,db_axis_min,db_axis_max'];
  for(const item of panels){
   const p=item.projection;if(!p)continue;
   const alongX=state.curveAxis==='x',axis=alongX?p.xs:p.ys;
   const power=window.ModulationCurves.marginal(p.map,state.curveAxis);
   const db=window.ModulationCurves.toDb(power,state.colorRef||1e-12);
   const [lowDb,highDb]=window.ModulationCurves.selectRange(db,
    state.curveScaleManual?[state.curveMinDb,state.curveMaxDb]:null);
   const unit=axisLabels[item.code][alongX?0:1].match(/\(([^)]+)\)/)?.[1]||'';
   for(let j=0;j<axis.length;j++)rows.push([item.code,state.curveAxis,axis[j],unit,
    Number.isFinite(power[j])?power[j]:'NaN',Number.isFinite(db[j])?db[j]:'NaN',
    state.colorRef??'NaN',state.data.mode,state.curveScaleManual?'manual':'auto',lowDb,highDb].join(','));
  }
  download('ModulationScope_profils_'+state.projection+'_'+Date.now()+'.csv',
   new Blob([rows.join('\n')],{type:'text/csv;charset=utf-8'}));
  return;
 }
 for(const item of panels){
  const code=item.code,p=item.projection;if(!p)continue;
  const db=relativeDb(p.map),units=axisLabels[code].map(s=>s.match(/\(([^)]+)\)/)?.[1]||'');
  for(let i=0;i<p.ys.length;i++)for(let j=0;j<p.xs.length;j++){
   const v=p.map[i][j],dec=db[i][j];
   lines.push([code,p.xs[j],p.ys[i],units[0],units[1],Number.isFinite(v)?v:'NaN',Number.isFinite(dec)?dec:'NaN',state.data.mode,state.colorRef??'NaN'].join(','));
  }
 }
 download('ModulationScope_'+state.projection+'_'+Date.now()+'.csv',new Blob([lines.join('\n')],{type:'text/csv;charset=utf-8'}));
};
$('recalibrateColors').addEventListener('click',()=>{
 state.colorRef=powerReference(state.data);
 updateChart();
});
const panel=$('chartPanel'),splitter=$('splitter'),app=$('app');let dragging=false;
function resizeChart(height){const available=app.getBoundingClientRect().height-95;const px=clamp(height,150,Math.max(170,available-120));panel.style.height=`${px}px`;try { localStorage.setItem('modulationscope-panel-height',String(px)); } catch (_) { /* storage disabled */ }updateChart();}
splitter.addEventListener('pointerdown',e=>{dragging=true;splitter.setPointerCapture(e.pointerId);e.preventDefault();});
splitter.addEventListener('pointermove',e=>{if(dragging){resizeChart(e.clientY-app.getBoundingClientRect().top-60);e.preventDefault();}});
splitter.addEventListener('pointerup',()=>{dragging=false;});splitter.addEventListener('pointercancel',()=>{dragging=false;});
splitter.addEventListener('keydown',e=>{if(e.key==='ArrowUp'||e.key==='ArrowDown'){resizeChart(panel.getBoundingClientRect().height+(e.key==='ArrowDown'?20:-20));e.preventDefault();}});
let saved = 0;
try { saved=Number(localStorage.getItem('modulationscope-panel-height')); } catch (_) { /* storage disabled */ }
if(Number.isFinite(saved)&&saved>0)resizeChart(saved);
new ResizeObserver(updateChart).observe(plot.parentElement);
window.addEventListener('resize',updateChart);
updateMode();applyConfig();updateChart();
})();
