export type AudioBatch = { samples: Float32Array; blockSize: number };

export const TAP_WORKLET = `registerProcessor("tap", class extends AudioWorkletProcessor {
  constructor() {
    super();
    this.used = 0;
    this.done = false;
    this.port.onmessage = ({ data }) => {
      if (data !== "drain" || this.done) return;
      this.done = true;
      this.flush();
      this.port.postMessage("drained");
    };
  }

  flush() {
    if (!this.used) return;
    const samples = this.buffer.subarray(0, this.used);
    this.port.postMessage({ samples, blockSize: this.blockSize }, [samples.buffer]);
    this.buffer = null;
    this.used = 0;
  }

  process(inputs) {
    if (this.done) return false;
    const block = inputs[0][0];
    if (!block?.length) return true;
    if (this.blockSize !== block.length) this.flush();
    if (!this.buffer) {
      this.blockSize = block.length;
      this.buffer = new Float32Array(13 * this.blockSize);
    }
    this.buffer.set(block, this.used);
    this.used += block.length;
    if (this.used === this.buffer.length) this.flush();
    return true;
  }
});`;
