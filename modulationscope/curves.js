/* Line-profile math shared by MPS, STRF and NHB time-frequency views. */
'use strict';
(function(root){
function marginal(map,axis){
 if(!map||!map.length||!map[0]?.length)return [];
 const ny=map.length,nx=map[0].length;
 if(axis==='x')return Array.from({length:nx},(_,j)=>{
  let sum=0,n=0;
  for(let i=0;i<ny;i++){const v=map[i][j];if(Number.isFinite(v)){sum+=v;n++;}}
  return n?sum/n:NaN;
 });
 if(axis==='y')return map.map(row=>{
  let sum=0,n=0;
  for(const v of row){if(Number.isFinite(v)){sum+=v;n++;}}
  return n?sum/n:NaN;
 });
 throw Error('axis must be x or y');
}
function toDb(power,reference){
 const ref=Number.isFinite(reference)&&reference>0?reference:1e-12;
 return power.map(v=>Number.isFinite(v)?10*Math.log10(Math.max(1e-21,v)/ref):NaN);
}
function autoRange(values){
 const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);
 if(!sorted.length)return[-12,0];
 const lo=sorted[Math.floor(.05*(sorted.length-1))];
 const hi=sorted[Math.ceil(.95*(sorted.length-1))];
 const span=Math.max(3,hi-lo),mid=.5*(hi+lo);
 return[mid-.58*span,mid+.58*span];
}
function selectRange(values,limits=null){
 if(limits===null)return autoRange(values);
 if(!Array.isArray(limits)||limits.length!==2||!limits.every(Number.isFinite)
    ||limits[0]>=limits[1])
  throw new RangeError('dB min doit être inférieur à dB max');
 return limits.slice();
}
root.ModulationCurves={marginal,toDb,autoRange,selectRange};
if(typeof module!=='undefined'&&module.exports)module.exports=root.ModulationCurves;
})(typeof window!=='undefined'?window:globalThis);
