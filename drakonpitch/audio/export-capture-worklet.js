/**
 * Passthrough + PCM tap for realtime MP3 export (main thread runs lamejs).
 * Buffers to match prior ScriptProcessor buffer size (4096) for consistent encode chunks.
 */
class DrakonPitchExportCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const po = options?.processorOptions || {};
    this.bufferSize = Math.max(128, Math.min(16384, Number(po.bufferSize) || 4096));
    this.leftAcc = new Float32Array(this.bufferSize);
    this.rightAcc = new Float32Array(this.bufferSize);
    this.accCount = 0;

    this.port.onmessage = (e) => {
      if (e.data?.type === "flush") {
        this._flushAccumulator();
        this.port.postMessage({ type: "flush-done" });
      }
    };
  }

  _flushAccumulator() {
    if (this.accCount <= 0) return;
    const n = this.accCount;
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    left.set(this.leftAcc.subarray(0, n));
    right.set(this.rightAcc.subarray(0, n));
    this.accCount = 0;
    this.port.postMessage({ type: "pcm", frames: n, left, right }, [left.buffer, right.buffer]);
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    if (input && input.length > 0 && output && output.length > 0) {
      const ch0 = input[0];
      const ch1 = input.length > 1 ? input[1] : ch0;
      const out0 = output[0];
      const out1 = output.length > 1 ? output[1] : out0;

      if (ch0 && out0) {
        out0.set(ch0);
        if (ch1 && out1) {
          out1.set(ch1);
        } else if (out1) {
          out1.set(ch0);
        }
      }

      if (ch0 && ch0.length > 0) {
        const rightSrc = input.length > 1 ? input[1] : ch0;
        let offset = 0;
        const len = ch0.length;
        while (offset < len) {
          const need = this.bufferSize - this.accCount;
          const take = Math.min(need, len - offset);
          this.leftAcc.set(ch0.subarray(offset, offset + take), this.accCount);
          this.rightAcc.set(rightSrc.subarray(offset, offset + take), this.accCount);
          this.accCount += take;
          offset += take;
          if (this.accCount >= this.bufferSize) {
            const left = new Float32Array(this.bufferSize);
            const right = new Float32Array(this.bufferSize);
            left.set(this.leftAcc);
            right.set(this.rightAcc);
            this.accCount = 0;
            this.port.postMessage(
              { type: "pcm", frames: this.bufferSize, left, right },
              [left.buffer, right.buffer]
            );
          }
        }
      }
    } else if (output && output.length > 0) {
      for (let c = 0; c < output.length; c++) {
        if (output[c]) output[c].fill(0);
      }
    }

    return true;
  }
}

registerProcessor("drakonpitch-export-capture", DrakonPitchExportCaptureProcessor);
