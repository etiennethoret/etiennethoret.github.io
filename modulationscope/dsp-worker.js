/* Offline audio DSP worker — no network calls. */
'use strict';
let cfg = null, samples = [], frames = [], latestRms = -90, sampleClock = 0;
let hop = 256, fftSize = 2048, frameHz = 44100/256, nfftBands = 64;
let framesSeen = 0, lastLogAnalysis = 0, lastLinearAt = -1;
let weights = [], norms = [], hann = [], fftRe = null, fftIm = null;
const OCT = Math.log2(10000/125), minHz = 125, maxHz = 10000;
const message = (kind, value={})=>postMessage({kind,...value});
function fft(re,im,inverse=false){
  const n=re.length;
  for(let i=1,j=0;i<n;i++){let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j){[re[i],re[j]]=[re[j],re[i]];[im[i],im[j]]=[im[j],im[i]];}}
  for(let len=2;len<=n;len<<=1){const a=(inverse?2:-2)*Math.PI/len,wr0=Math.cos(a),wi0=Math.sin(a);
    for(let i=0;i<n;i+=len){let wr=1,wi=0;for(let k=0;k<len/2;k++){let j=i+k,l=j+len/2;const tr=wr*re[l]-wi*im[l],ti=wr*im[l]+wi*re[l];re[l]=re[j]-tr;im[l]=im[j]-ti;re[j]+=tr;im[j]+=ti;const r=wr*wr0-wi*wi0;wi=wr*wi0+wi*wr0;wr=r;}}
  }
  if(inverse)for(let i=0;i<n;i++){re[i]/=n;im[i]/=n;}
}
function pow2(x){let n=1;while(n<x)n<<=1;return n;}
function linspace(a,b,n){return Array.from({length:n},(_,i)=>a+(b-a)*i/(n-1));}
function logspace(a,b,n){return Array.from({length:n},(_,i)=>a*Math.pow(b/a,i/(n-1)));}
function mkAxes(){const rates=cfg.ratesVector||logspace(.5,cfg.maxRate,cfg.ratesCount);const scales=cfg.scalesVector||(cfg.scalesCount===6?[0,.5,1,2,3,4]:linspace(0,4,cfg.scalesCount));return {rates,scales,acoustic:logspace(minHz,maxHz,cfg.bands)};}
function reset(){samples=[];frames=[];sampleClock=0;framesSeen=0;lastLinearAt=-1;lastLogAnalysis=0;latestRms=-90;
  fftSize=cfg.mode==='log'?(cfg.maxRate>64?256:cfg.maxRate>32?512:2048):cfg.fftSize;
  hop=cfg.mode==='log'?(cfg.maxRate>64?64:cfg.maxRate>32?128:Math.round(cfg.sampleRate/250)):Math.max(32,Math.round(fftSize*(1-cfg.stftOverlap/100)/32)*32);
  frameHz=cfg.sampleRate/hop;nfftBands=pow2(cfg.bands);
  hann=Float64Array.from({length:fftSize},(_,i)=>.5-.5*Math.cos(2*Math.PI*i/(fftSize-1)));
  const oct=OCT, hzStep=cfg.sampleRate/fftSize;
  weights=Array.from({length:cfg.bands},()=>[]);norms=Array(cfg.bands).fill(0);
  for(let b=0;b<cfg.bands;b++){
    const center=b*oct/(cfg.bands-1),f=minHz*Math.pow(2,center);
    const sigma=Math.max(.10,25/(f*Math.LN2));
    for(let k=1;k<=fftSize/2;k++){const hz=k*hzStep;if(hz<minHz/1.5||hz>maxHz*1.12)continue;
      const z=(Math.log2(hz/minHz)-center)/sigma;
      if(Math.abs(z)>3)continue;let w=Math.exp(-.5*z*z);weights[b].push([k,w]);norms[b]+=w;}
  }
  fftRe=new Float64Array(fftSize);fftIm=new Float64Array(fftSize);
  message('configured',{fftSize,hop,frameHz});
}
function computeFrame(){const recent=samples.slice(-fftSize);let e=0;
  for(let i=0;i<fftSize;i++){const z=recent[i];e+=z*z;fftRe[i]=z*hann[i];fftIm[i]=0;}
  latestRms=20*Math.log10(Math.max(1e-8,Math.sqrt(e/fftSize)));
  fft(fftRe,fftIm);const p=new Float64Array(fftSize/2+1),norm=4/(fftSize*fftSize);
  for(let i=0;i<p.length;i++)p[i]=(fftRe[i]*fftRe[i]+fftIm[i]*fftIm[i])*norm;
  const row=Float32Array.from({length:cfg.bands},(_,b)=>{
    let sum=0;for(const [k,w] of weights[b])sum+=p[k]*w;
    return Math.max(-100,10*Math.log10(Math.max(1e-12,sum/Math.max(1e-12,norms[b]))));
  });
  frames.push(row);framesSeen++;
  // Keep enough history for the longest selected Gabor window, up to 24 s
  // with 12 cycles at 0.5 Hz. A disabled cap no longer silently truncates it.
  const slowest=cfg.mode==='log'?(cfg.ratesVector?Math.min(...cfg.ratesVector.map(Math.abs)):.5):1;
  const required=cfg.mode==='log'?(cfg.capEnabled?
    Math.min(cfg.integration,cfg.cycles/slowest):cfg.cycles/slowest):cfg.fftWindow;
  const maxFrames=Math.min(26000,Math.ceil((required+1)*frameHz)+20);
  if(frames.length>maxFrames)frames.splice(0,frames.length-maxFrames);
}
function receiveAudio(chunk){
  const x=new Float32Array(chunk);
  // Retain only what's necessary to form successive overlapping STFT windows.
  for(let i=0;i<x.length;i++){
    samples.push(x[i]);sampleClock++;
    if(samples.length>=fftSize && (sampleClock-fftSize)%hop===0)computeFrame();
  }
  if(samples.length>fftSize+hop)samples.splice(0,samples.length-(fftSize+hop));
  const t=performance.now();
  if(cfg.mode==='log'){
    if(t-lastLogAnalysis>=1000/cfg.refreshHz){lastLogAnalysis=t;calculateLog();}
  }else{
    const N=linearCount(),stride=Math.max(1,Math.round(N*(1-cfg.overlap/100)));
    if(frames.length>=N && (lastLinearAt<0||framesSeen-lastLinearAt>=stride) && t-lastLogAnalysis>=1000/cfg.refreshHz){lastLogAnalysis=t;lastLinearAt=framesSeen;calculateLin(N);}
  }
}
function linearCount(){return Math.max(16,Math.min(2048,pow2(cfg.fftWindow*frameHz)));}
function gaussianKernels(rates){return rates.map(r=>{
  const seconds=cfg.capEnabled?Math.min(cfg.integration,cfg.cycles/Math.abs(r)):cfg.cycles/Math.abs(r);
  const n=Math.max(8,Math.round(seconds*frameHz));
  const re=new Float64Array(n),im=new Float64Array(n);let z=0,dcR=0,dcI=0;
  for(let k=0;k<n;k++){const lag=(n-1-k)/frameHz,w=.5-.5*Math.cos(2*Math.PI*(k+.5)/n);z+=w;re[k]=w*Math.cos(2*Math.PI*r*lag);im[k]=w*Math.sin(2*Math.PI*r*lag);dcR+=re[k];dcI+=im[k];}
  dcR/=z;dcI/=z;
  for(let k=0;k<n;k++){const w=.5-.5*Math.cos(2*Math.PI*(k+.5)/n);re[k]=2*(re[k]-w*dcR)/z;im[k]=2*(im[k]-w*dcI)/z;}
  return {n,re,im,seconds:n/frameHz};
});}
function specFilters(scales,bands){
  const step=OCT/(bands-1);
  return scales.map(s=>Array.from({length:bands},(_,center)=>{
    const sigma=s===0?.65:.60/s,half=Math.ceil(3*sigma/step);
    const start=Math.max(0,center-half),stop=Math.min(bands-1,center+half),n=stop-start+1;
    let g=new Float64Array(n),re=new Float64Array(n),im=new Float64Array(n),total=0,dcR=0,dcI=0;
    for(let k=0;k<n;k++){
      const x=(start+k-center)*step,w=Math.exp(-.5*Math.pow(x/sigma,2));g[k]=w;total+=w;
      re[k]=Math.cos(2*Math.PI*s*x);im[k]=-Math.sin(2*Math.PI*s*x);dcR+=w*re[k];dcI+=w*im[k];
    }
    dcR/=total;dcI/=total;
    for(let k=0;k<n;k++){re[k]=g[k]*(s===0?1:re[k]-dcR)/total;im[k]=s===0?0:g[k]*(im[k]-dcI)/total;}
    return {start,re,im};
  }));
}
function empty(rows,cols){return Array.from({length:rows},()=>new Float64Array(cols));}
function finalizeAxes(sr,fr,fs,axes,integrations,mode){
  const nr=axes.rates.length,ns=axes.scales.length,nf=axes.acoustic.length;
  for(let i=0;i<ns;i++)for(let j=0;j<nr;j++)sr[i][j]/=nf;
  for(let i=0;i<nf;i++){for(let j=0;j<nr;j++)fr[i][j]/=ns;for(let j=0;j<ns;j++)fs[i][j]/=nr;}
  const meanTime=Array.from({length:nr},(_,j)=>sr.reduce((sum,row)=>sum+row[j],0)/ns);
  message('result',{mode,axes,integrations,sr:sr.map(a=>Array.from(a)),fr:fr.map(a=>Array.from(a)),fs:fs.map(a=>Array.from(a)),marginal:meanTime,
    rms:latestRms,computedAt:performance.now(),audioFrames:framesSeen});
}
function calculateLog(){
  if(frames.length<16)return;
  const axes=mkAxes(),rates=axes.rates,scales=axes.scales,nf=cfg.bands,nr=rates.length,ns=scales.length;
  const temp=gaussianKernels(rates),spec=specFilters(scales,nf),sr=empty(ns,nr),fr=empty(nf,nr),fs=empty(nf,ns);
  const integrations=temp.map(t=>t.seconds);
  let valid=0;
  for(let ri=0;ri<nr;ri++){
    const kernel=temp[ri];if(frames.length<kernel.n)continue;
    const tRe=new Float64Array(nf),tIm=new Float64Array(nf),start=frames.length-kernel.n;
    for(let k=0;k<kernel.n;k++){
      const row=frames[start+k],a=kernel.re[k],b=kernel.im[k];
      for(let fi=0;fi<nf;fi++){tRe[fi]+=row[fi]*a;tIm[fi]+=row[fi]*b;}
    }
    valid++;
    for(let si=0;si<ns;si++)for(let fi=0;fi<nf;fi++){
      const f=spec[si][fi];let ur=0,ui=0,dr=0,di=0;
      for(let k=0;k<f.re.length;k++){
        const tr=tRe[f.start+k],ti=tIm[f.start+k],a=f.re[k],b=f.im[k];
        ur+=tr*a+ti*b;ui+=ti*a-tr*b;dr+=tr*a-ti*b;di+=tr*b+ti*a;
      }
      const up=ur*ur+ui*ui,down=dr*dr+di*di;
      // Signed reference rates encode opposite spectrotemporal orientations.
      // Current Gabor frontend is an approximation of the published NSL filters.
      const energy=cfg.ratesVector?.some(v=>v<0)
        ? (rates[ri]<0?down:up)
        : cfg.direction==='up'?up:cfg.direction==='down'?down:(up+down)/2;
      sr[si][ri]+=energy;fr[fi][ri]+=energy;fs[fi][si]+=energy;
    }
  }
  if(valid===0)return;
  for(let fi=0;fi<nf;fi++)for(let si=0;si<ns;si++)fs[fi][si]*=nr/valid;
  finalizeAxes(sr,fr,fs,axes,integrations,'log');
}
function calculateLin(N){
  // A classical two-dimensional FFT of a Hann-windowed time x log-frequency spectrogram.
  // Rows: N time samples, columns: nf acoustic log bands. Nonnegative modulation
  // magnitudes (both ripple orientations averaged in energy) are retained.
  if(frames.length<N)return;
  const nf=nfftBands,nt=N,nR=nt/2+1,nS=nf/2+1;
  const matRe=Array.from({length:nt},()=>new Float64Array(nf));
  const matIm=Array.from({length:nt},()=>new Float64Array(nf));
  let dcMean=0;for(let t=0;t<nt;t++){const row=frames[frames.length-nt+t];for(let f=0;f<cfg.bands;f++)dcMean+=row[f];}dcMean/=nt*cfg.bands;
  for(let t=0;t<nt;t++){
    const tw=.5-.5*Math.cos(2*Math.PI*t/(nt-1)),raw=frames[frames.length-nt+t];
    for(let f=0;f<cfg.bands;f++){
      const fw=.5-.5*Math.cos(2*Math.PI*f/(cfg.bands-1));
      matRe[t][f]=(raw[f]-dcMean)*tw*fw;
    }
    fft(matRe[t],matIm[t]);
  }
  const colRe=new Float64Array(nt),colIm=new Float64Array(nt);
  for(let f=0;f<nf;f++){
    for(let t=0;t<nt;t++){colRe[t]=matRe[t][f];colIm[t]=matIm[t][f];}
    fft(colRe,colIm);
    for(let t=0;t<nt;t++){matRe[t][f]=colRe[t];matIm[t][f]=colIm[t];}
  }
  const octaveExtent=OCT*(nf/cfg.bands),scales=Array.from({length:nS},(_,i)=>i/octaveExtent);
  const rates=Array.from({length:nR},(_,i)=>i*frameHz/nt);
  const sr=empty(nS,nR),norm=1/(nt*nt*nf*nf);
  for(let si=0;si<nS;si++)for(let ri=0;ri<nR;ri++){
    const ps=[si,(nf-si)%nf],pr=[ri,(nt-ri)%nt];let e=0,n=0;
    for(const sj of ps)for(const rj of pr){const re=matRe[rj][sj],im=matIm[rj][sj];e+=(re*re+im*im)*norm;n++;}
    sr[si][ri]=e/n;
  }
  message('result',{mode:'lin',axes:{rates,scales,acoustic:logspace(minHz,maxHz,cfg.bands)},integrations:[],
    sr:sr.map(a=>Array.from(a)),fr:null,fs:null,
    marginal:rates.map((_,j)=>sr.reduce((sum,row)=>sum+row[j],0)/nS),
    rms:latestRms,computedAt:performance.now(),audioFrames:framesSeen,linearN:nt,
    effectiveWindow:nt/frameHz,
    mpsStepSeconds:Math.max(1,Math.round(nt*(1-cfg.overlap/100)))/frameHz});
}
onmessage=ev=>{
  try{
    const {kind}=ev.data;
    if(kind==='config'){
      cfg=ev.data.config;
      if(!cfg||!Number.isFinite(cfg.sampleRate)||cfg.bands<16)throw Error('Réglages non valides');
      reset();
    }else if(kind==='audio'&&cfg){receiveAudio(ev.data.data);}
    else if(kind==='clear'){samples=[];frames=[];framesSeen=0;}
  }catch(e){message('error',{message:String(e&&e.message||e)});}
};
