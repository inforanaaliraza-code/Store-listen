class StoreListenPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(4096);
    this.offset = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel?.length) return true;
    let sourceOffset = 0;
    while (sourceOffset < channel.length) {
      const length = Math.min(this.frame.length - this.offset, channel.length - sourceOffset);
      this.frame.set(channel.subarray(sourceOffset, sourceOffset + length), this.offset);
      this.offset += length;
      sourceOffset += length;
      if (this.offset === this.frame.length) {
        const pcm = new Int16Array(this.frame.length);
        for (let index = 0; index < this.frame.length; index += 1) {
          const sample = Math.max(-1, Math.min(1, this.frame[index]));
          pcm[index] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
        }
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('store-listen-pcm-capture', StoreListenPcmProcessor);