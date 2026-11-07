/* Streaming port of Thoret et al. (Nature Human Behaviour, 2021) cochlear front end.
 * Original COCHBA coefficients bundled separately in nhb-filterbank.js.
 * Uses fixed microphone amplitude (offline paper normalizes each entire stimulus).
 * Causal windowed-sinc sample-rate conversion replaces offline FFT resampling.
 */
'use strict';
(function (root) {
  class NHBAuditory {
    constructor(inputRate, bank) {
      if (!bank || !bank.filters || bank.filters.length !== 129) throw Error('Missing NHB COCHBA filters');
      if (!Number.isFinite(inputRate) || inputRate < 16000) throw Error('Invalid audio input sample rate');
      this.inputRate=inputRate;
      this.bank=bank;
      this.coeffs=bank.filters;
      this.delay=this.coeffs.map(f=>new Float64Array(f.a.length-1));
      this.alpha=Math.exp(-1/(8*16));
      this.integrators=new Float64Array(128);
      this.ring=new Float64Array(49);
      this.ringWrite=0;
      this.samplesSeen=0;
      this.nextTarget=24;
      this.processed=0;
      this.fps=250;
      this.maxFrames=15100;
      this.frames=new Array(this.maxFrames);
      this.framesSeen=0;
      this.frameSum=new Float64Array(128);
      this.cutoff=.46*Math.min(1,16000/inputRate);
      this.centers=bank.centerHz.slice();
    }
    filter(ch,x){
      const f=this.coeffs[ch],z=this.delay[ch],n=z.length;
      const y=f.b[0]*x+z[0];
      for(let i=0;i<n-1;i++)z[i]=f.b[i+1]*x-f.a[i+1]*y+z[i+1];
      z[n-1]=f.b[n]*x-f.a[n]*y;
      return y;
    }
    consume16k(x){
      let higher=this.filter(128,x);
      for(let ch=127;ch>=0;ch--){
        const here=this.filter(ch,x);
        const rectified=Math.max(0,here-higher);
        higher=here;
        this.integrators[ch]=this.alpha*this.integrators[ch]+rectified;
      }
      if(++this.processed%64===0){
        const row=new Float32Array(128);
        for(let ch=0;ch<128;ch++)row[ch]=this.integrators[ch]*this.integrators[ch];
        this.frames[this.framesSeen%this.maxFrames]=row;
        this.framesSeen++;
      }
    }
    add(input){
      for(let j=0;j<input.length;j++){
        const currentIndex=this.samplesSeen++;
        this.ring[this.ringWrite]=input[j];
        this.ringWrite=(this.ringWrite+1)%49;
        while(currentIndex>=this.nextTarget+24){
          let sum=0,norm=0;
          for(let i=0;i<49;i++){
            const index=currentIndex-i;
            const delta=index-this.nextTarget;
            const z=2*this.cutoff*delta;
            const sinc=Math.abs(z)<1e-12?1:Math.sin(Math.PI*z)/(Math.PI*z);
            const w=.54+.46*Math.cos(Math.PI*delta/24);
            const h=2*this.cutoff*sinc*w;
            const k=(this.ringWrite-1-i+49)%49;
            sum+=this.ring[k]*h;
            norm+=h;
          }
          this.consume16k(sum/Math.max(1e-12,norm));
          this.nextTarget+=this.inputRate/16000;
        }
      }
    }
    snapshot(seconds=30,columns=151){
      const xs=Array.from({length:columns},(_,j)=>-seconds+j*seconds/(columns-1));
      const map=Array.from({length:128},()=>Array(columns).fill(NaN));
      const newest=this.framesSeen-1;
      if(newest<0)return {xs,ys:this.centers,map};
      for(let j=0;j<columns;j++){
        const offset=Math.round(xs[j]*250);
        const index=newest+offset;
        if(index<0||index<newest-this.maxFrames+1)continue;
        const values=this.frames[index%this.maxFrames];
        if(values)for(let ch=0;ch<128;ch++)map[ch][j]=values[ch];
      }
      return {xs,ys:this.centers,map};
    }
  }
  root.NHBAuditory=NHBAuditory;
})(typeof self!=='undefined'?self:globalThis);
