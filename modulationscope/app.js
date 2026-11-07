'use strict';
(() => {
const $=id=>document.getElementById(id);
let plot=$('chart'),ctx=plot.getContext('2d',{alpha:false});
const state={running:false,frozen:false,worker:null,stream:null,audioCtx:null,source:null,recorder:null,
  config:null,data:null,history:[],current:null,projection:'sr',span:30,selected:null,
  timeLast:null,observedHz:null,generation:0,plotRect:null,dims:null,restartTimeout:null};
const axisLabels={sr:['Rate (Hz)','Scale (cyc/oct)'],fr:['Rate (Hz)','Fréquence (Hz)'],fs:['Scale (cyc/oct)','Fréquence (Hz)'],
  tr:['Temps relatif (s)','Rate (Hz)'],ts:['Temps relatif (s)','Scale (cyc/oct)'],tf:['Temps relatif (s)','Fréquence (Hz)']};
const titles={sr:'SCALE × RATE',fr:'FRÉQUENCE × RATE',fs:'FRÉQUENCE × SCALE',tr:'TEMPS × RATE',ts:'TEMPS × SCALE',tf:'TEMPS × FRÉQUENCE'};
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
  ratesVector:null,scalesVector:null,sampleRate:state.audioCtx?.sampleRate||44100
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
 const menu=$('projection');for(const option of menu.options)option.disabled=lin&&option.value!=='sr';
 if(lin){menu.value='sr';state.projection='sr';}
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
  const cfg=configFromUI();warn();state.config=cfg;state.history=[];state.data=null;
  state.selected=null;state.current=null;state.timeLast=null;state.observedHz=null;
  updateLinearInfo(cfg);
  if(state.running&&state.worker){cfg.sampleRate=state.audioCtx.sampleRate;state.worker.postMessage({kind:'config',config:cfg});}
  updateChart();
 }catch(e){warn(e.message);}
}
function scheduleSettings(){clearTimeout(state.restartTimeout);state.restartTimeout=setTimeout(applyConfig,650);}
values.forEach(el=>{
 const fn=el.tagName==='SELECT'?'change':'input';el.addEventListener(fn,()=>{
  if(el.id==='projection'){state.projection=el.value;state.selected=null;updateChart();return;}
  if(el.id==='timeSpan'){state.span=Number(el.value);updateChart();return;}
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
  else if(e.data.kind==='configured')$('details').textContent=`Micro ${Math.round(audioCtx.sampleRate)} Hz · STFT ${e.data.fftSize} / hop ${e.data.hop}`;
 };
 worker.onerror=e=>warn('Erreur du moteur de calcul : '+e.message);
 worker.postMessage({kind:'config',config:cfg});
 const source=audioCtx.createMediaStreamSource(stream);
 const recorder=new AudioWorkletNode(audioCtx,'modulation-capture',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});
 recorder.port.onmessage=e=>{if(state.running&&generation===state.generation&&state.worker)state.worker.postMessage({kind:'audio',data:e.data},[e.data.buffer]);};
 const silent=audioCtx.createGain();silent.gain.value=0;
 source.connect(recorder);recorder.connect(silent);silent.connect(audioCtx.destination);
 state.source=source;state.recorder=recorder;state.stream=stream;state.running=true;state.frozen=false;state.history=[];state.config=cfg;
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
 if(data.mode==='log'){
  const avgColumns=(matrix,which)=>{
   if(!matrix)return[];if(which==='column'){const n=matrix[0].length;return Array.from({length:n},(_,j)=>matrix.reduce((s,row)=>s+(Number.isFinite(row[j])?row[j]:0),0)/matrix.length);}
   return matrix.map(row=>row.reduce((s,x)=>s+(Number.isFinite(x)?x:0),0)/row.length);
  };
  state.history.push({t:now/1000,rate:avgColumns(data.sr,'column'),scale:avgColumns(data.sr,'row'),freq:avgColumns(data.fs,'row')});
  while(state.history.length>4000||state.history.length&&now/1000-state.history[0].t>75)state.history.shift();
 }
 const basics=`Micro ${Math.round(state.audioCtx?.sampleRate||0)} Hz · niveau ${data.rms.toFixed(1)} dBFS · cadence observée ${state.observedHz?.toFixed(1)||'—'} Hz`;
 $('details').textContent=data.mode==='lin'
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
function relativeDb(map){let max=1e-20;for(const row of map)for(const x of row)if(Number.isFinite(x))max=Math.max(max,x);
 return map.map(row=>row.map(v=>Number.isFinite(v)?Math.max(-90,10*Math.log10(Math.max(1e-21,v)/max)):NaN));
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
function formatAxis(v,code,axis){const kind=code[0]==='t'&&axis==='x'?'time':code==='sr'?(axis==='x'?'rate':'scale'):
 code==='fr'?(axis==='x'?'rate':'frequency'):code==='fs'?(axis==='x'?'scale':'frequency'):
 code==='tr'?'rate':code==='ts'?'scale':'frequency';
 if(kind==='time')return `${v.toFixed(1)} s`;if(kind==='scale')return `${v.toFixed(2)} cyc/oct`;
 if(kind==='rate')return `${v.toFixed(2)} Hz`;return`${v.toFixed(1)} Hz`;
}
function tickValues(values,code,axis){if(code[0]==='t'&&axis==='x')return[-state.span,-.75*state.span,-.5*state.span,-.25*state.span,0];
 const kind=code==='sr'?(axis==='x'?'rate':'scale'):code==='fr'?(axis==='x'?'rate':'frequency'):
 code==='fs'?(axis==='x'?'scale':'frequency'):code==='tr'?'rate':code==='ts'?'scale':'frequency';
 if(kind==='scale')return[0,1,2,3,4];if(kind==='frequency')return[125,500,2000,8000];
 const last=values.at(-1)||32;return last<=16?[.5,2,8,16]:last<=32?[.5,2,8,32]:last<=64?[.5,2,8,32,64]:[.5,2,8,32,128];
}
function closest(values,target){let best=0,err=Infinity;for(let i=0;i<values.length;i++){const d=Math.abs(values[i]-target);if(d<err){err=d;best=i;}}return best;}
function updateChart(){const w=plot.clientWidth,h=plot.clientHeight;if(!w||!h)return;
 const dpr=Math.min(2,devicePixelRatio||1);if(plot.width!==Math.round(w*dpr)||plot.height!==Math.round(h*dpr)){plot.width=Math.round(w*dpr);plot.height=Math.round(h*dpr);}ctx.setTransform(dpr,0,0,dpr,0,0);
 ctx.fillStyle='#0d1620';ctx.fillRect(0,0,w,h);
 $('plotTitle').textContent=titles[state.projection];
 const d=state.data,projection=selectedProjection();$('plotSubtitle').textContent=d?(d.mode==='lin'?'FFT 2D':'Gabor multirésolution'):'En attente du microphone';
 const L=w<430?48:64,R=Math.max(L+45,w-(w<430?89:122)),T=12,B=Math.max(T+52,h-91),verticalX=R+13,verticalW=Math.min(46,w-verticalX-9),horizontalT=B+27,horizontalB=Math.min(h-30,horizontalT+42);
 state.plotRect={L,R,T,B};ctx.fillStyle='#13202d';ctx.fillRect(L,T,R-L,B-T);ctx.fillRect(verticalX,T,verticalW,B-T);ctx.fillRect(L,horizontalT,R-L,horizontalB-horizontalT);
 if(!projection){label('Démarre le microphone pour afficher les modulations.',L+8,T+27,'left','#a5bac8',12);state.current=null;return;}
 state.current=projection;
 const db=relativeDb(projection.map),rows=db.length,cols=db[0]?.length||0;if(!rows||!cols)return;
 const cw=(R-L)/cols,ch=(B-T)/rows;
 for(let i=0;i<rows;i++)for(let j=0;j<cols;j++){
  const v=db[i][j];if(Number.isFinite(v)){ctx.fillStyle=blend(v);ctx.fillRect(L+j*cw,T+(rows-i-1)*ch,Math.ceil(cw+.2),Math.ceil(ch+.2));}
 }
 ctx.strokeStyle='#5b7180';ctx.lineWidth=1;ctx.strokeRect(L+.5,T+.5,R-L,B-T);
 const mx=dbVector(marginal(projection.map,'x')),my=dbVector(marginal(projection.map,'y')),xr=range(mx),yr=range(my);
 drawLine(mx.map((v,j)=>Number.isFinite(v)?[L+(j+.5)*cw,horizontalB-clamp((v-xr[0])/(xr[1]-xr[0]),0,1)*(horizontalB-horizontalT)]:null),'#65ddc6',1.7);
 drawLine(my.map((v,i)=>Number.isFinite(v)?[verticalX+clamp((v-yr[0])/(yr[1]-yr[0]),0,1)*verticalW,T+(rows-i-.5)*ch]:null),'#65ddc6',1.7);
 label('Marg. X',L+3,h-9,'left','#9fb9c7',10);label(`${xr[0].toFixed(1)}…${xr[1].toFixed(1)} dB`,R,h-9,'right','#9fb9c7',10);
 label(`Y ${yr[0].toFixed(0)}…${yr[1].toFixed(0)} dB`,verticalX,T-2,'left','#9fb9c7',9);
 const labels=axisLabels[state.projection];label(labels[0],(L+R)/2,B+22,'center','#d9e7ee',10);
 ctx.save();ctx.translate(12,(T+B)/2);ctx.rotate(-Math.PI/2);label(labels[1],0,0,'center','#d9e7ee',10);ctx.restore();
 for(const value of tickValues(projection.xs,state.projection,'x')){
  const j=closest(projection.xs,value),x=L+(j+.5)*cw;if(x>=L&&x<=R)label(formatShort(value),x,B+11,'center','#92acba',9);
 }
 for(const value of tickValues(projection.ys,state.projection,'y')){
  const i=closest(projection.ys,value),y=T+(rows-i-.5)*ch;if(y>=T&&y<=B)label(formatShort(value),L-5,y+3,'right','#92acba',9);
 }
 if(state.selected&&state.selected.projection===state.projection){const j=clamp(state.selected.j,0,cols-1),i=clamp(state.selected.i,0,rows-1),x=L+(j+.5)*cw,y=T+(rows-i-.5)*ch;
  ctx.strokeStyle='#ffffff';ctx.lineWidth=1.1;ctx.beginPath();ctx.moveTo(L,y);ctx.lineTo(R,y);ctx.moveTo(x,T);ctx.lineTo(x,B);ctx.stroke();
  ctx.beginPath();ctx.arc(x,y,4,0,Math.PI*2);ctx.stroke();const v=db[i][j];
  $('readout').textContent=`X ${formatAxis(projection.xs[j],state.projection,'x')} · Y ${formatAxis(projection.ys[i],state.projection,'y')} · ${Number.isFinite(v)?v.toFixed(2)+' dB':'non mesuré'}`;
 }else $('readout').textContent='Touchez le graphique pour afficher les coordonnées X, Y et les dB relatifs.';
 state.dims={rows,cols};
}
function formatShort(v){if(v===0)return '0';if(v>=1000)return`${(v/1000).toFixed(v%1000?1:0)}k`;return Number.isInteger(v)?`${v}`:Math.abs(v)>=10?v.toFixed(0):v.toFixed(1);}
function selectPoint(e){const rect=plot.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top,r=state.plotRect,dim=state.dims;
 if(!r||!dim||x<r.L||x>=r.R||y<r.T||y>=r.B)return;
 const j=clamp(Math.floor((x-r.L)/(r.R-r.L)*dim.cols),0,dim.cols-1),i=dim.rows-1-clamp(Math.floor((y-r.T)/(r.B-r.T)*dim.rows),0,dim.rows-1);
 state.selected={i,j,projection:state.projection};updateChart();}
plot.addEventListener('pointerdown',e=>{selectPoint(e);plot.setPointerCapture(e.pointerId);});plot.addEventListener('pointermove',e=>{if(e.buttons)selectPoint(e);});
function download(name,blob){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}
$('exportPng').onclick=()=>plot.toBlob(b=>{if(b)download(`ModulationScope_${state.projection}_${Date.now()}.png`,b);},'image/png');
$('exportCsv').onclick=()=>{const a=state.current,d=state.data;if(!a||!d)return;
 const db=relativeDb(a.map),lines=['projection,x_value,y_value,x_unit,y_unit,power_linear,relative_db,mode'];
 const units=axisLabels[state.projection].map(x=>x.match(/\(([^)]+)\)/)?.[1]||'');
 for(let i=0;i<a.ys.length;i++)for(let j=0;j<a.xs.length;j++){
 const v=a.map[i][j],dec=db[i][j];lines.push([state.projection,a.xs[j],a.ys[i],units[0],units[1],Number.isFinite(v)?v:'NaN',Number.isFinite(dec)?dec:'NaN',d.mode].join(','));}
 download(`ModulationScope_${state.projection}_${Date.now()}.csv`,new Blob([lines.join('\n')],{type:'text/csv;charset=utf-8'}));
};
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
