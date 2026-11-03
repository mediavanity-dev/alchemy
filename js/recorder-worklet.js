// Collects raw microphone samples and posts them to the main thread in small blocks,
// each stamped with the audio-clock time of its first sample (used to align layers).
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(1024);
    this.i = 0;
    this.t0 = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let k = 0; k < ch.length; k++) {
        if (this.i === 0) this.t0 = currentTime + k / sampleRate;
        this.buf[this.i++] = ch[k];
        if (this.i === this.buf.length) {
          this.port.postMessage({ data: this.buf.slice(), time: this.t0 });
          this.i = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('recorder', RecorderProcessor);
