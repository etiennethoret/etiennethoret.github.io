class CaptureProcessor extends AudioWorkletProcessor {
  constructor(){super();this.buffer=new Float32Array(2048);this.pos=0;}
  process(inputs){const mono=inputs[0]?.[0];if(mono){for(let i=0;i<mono.length;i++){
    this.buffer[this.pos++]=mono[i];if(this.pos>=this.buffer.length){const buffer=this.buffer;this.port.postMessage(buffer,[buffer.buffer]);this.buffer=new Float32Array(2048);this.pos=0;}
  }}return true;}
}
registerProcessor('modulation-capture',CaptureProcessor);
