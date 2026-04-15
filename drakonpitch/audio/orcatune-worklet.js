class OrcaTuneProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const processorOptions = options?.processorOptions || {};
    this.channels = processorOptions.channels || 2;
    this.maxBlockSize = processorOptions.maxBlockSize || 2048;
    this.wasmUrl = processorOptions.wasmUrl;
    this.wasmJsUrl = processorOptions.wasmJsUrl;

    this.toneTargetSemitones = 0;
    this.toneSmoothedSemitones = 0;
    this.ready = false;
    this.destroyed = false;

    this.instance = null;
    this.exports = null;
    this.memory = null;
    this.fn = null;
    this.handle = 0;
    this.inPtr = 0;
    this.outPtr = 0;

    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === "setTone") {
        this.toneTargetSemitones = Number(data.semitones) || 0;
      } else if (data.type === "wasmPayload") {
        this.loadWasmFromPayload(data).catch((error) => {
          this.ready = false;
          this.port.postMessage({ type: "error", message: String(error) });
        });
      } else if (data.type === "destroy") {
        this.destroy();
      }
    };
  }

  async loadWasmFromPayload(payload) {
    const jsText = payload?.jsText;
    const wasmBytes = payload?.wasmBytes;
    if (!jsText || !wasmBytes) {
      throw new Error("Invalid wasm payload");
    }

      const getExportName = (symbolName) => {
        const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(`Module\\["${escaped}"\\]\\s*=\\s*wasmExports\\["([^"]+)"\\]`);
        const m = jsText.match(regex);
        return m ? m[1] : null;
      }; 

      const wasm = await WebAssembly.instantiate(wasmBytes, {
        a: {
          a: () => {
            throw new Error("WASM cxa_throw");
          },
          b: () => 0,
          c: () => {
            throw new Error("WASM abort");
          }
        }
      });
      this.instance = wasm.instance;
      this.exports = this.instance.exports;

      const createName = getExportName("_orcatune_create_processor");
      const destroyName = getExportName("_orcatune_destroy_processor");
      const setName = getExportName("_orcatune_set_semitones");
      const processName = getExportName("_orcatune_process_interleaved");
      const mallocName = getExportName("_malloc");
      const freeName = getExportName("_free");
      if (!createName || !destroyName || !setName || !processName || !mallocName || !freeName) {
        throw new Error("Cannot map WASM exports");
      }

      this.fn = {
        create: this.exports[createName],
        destroy: this.exports[destroyName],
        setSemitones: this.exports[setName],
        process: this.exports[processName],
        malloc: this.exports[mallocName],
        free: this.exports[freeName]
      };
      this.memory = Object.values(this.exports).find((v) => v instanceof WebAssembly.Memory) || null;
      if (!this.memory) {
        throw new Error("WASM memory export not found");
      }

      this.handle = this.fn.create(sampleRate, this.channels, this.maxBlockSize);
      if (!this.handle) throw new Error("orcatune_create_processor failed");

      const bytesPerBuffer = this.maxBlockSize * this.channels * 4;
      this.inPtr = this.fn.malloc(bytesPerBuffer);
      this.outPtr = this.fn.malloc(bytesPerBuffer);
      this.fn.setSemitones(this.handle, this.toneTargetSemitones);
      this.toneSmoothedSemitones = this.toneTargetSemitones;
      this.ready = true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.fn && this.handle) this.fn.destroy(this.handle);
    if (this.fn && this.inPtr) this.fn.free(this.inPtr);
    if (this.fn && this.outPtr) this.fn.free(this.outPtr);
    this.handle = 0;
    this.inPtr = 0;
    this.outPtr = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0 || !output || output.length === 0) return true;

    const frames = input[0].length;
    const channels = Math.min(input.length, output.length, this.channels);

    if (!this.ready || !this.fn || !this.memory || !this.handle || frames > this.maxBlockSize) {
      for (let ch = 0; ch < channels; ch++) output[ch].set(input[ch]);
      return true;
    }

    const heapF32 = new Float32Array(this.memory.buffer);
    const inOffset = this.inPtr >> 2;
    const outOffset = this.outPtr >> 2;

    // Pre-smooth the target on the JS side, slower when going down to reduce
    // grain-rate artifacts from the phase vocoder.
    const delta = this.toneTargetSemitones - this.toneSmoothedSemitones;
    if (Math.abs(delta) > 0.001) {
      const timeSec = delta < 0 ? 0.4 : 0.08;
      const alpha = 1 - Math.exp(-frames / (sampleRate * timeSec));
      this.toneSmoothedSemitones += delta * alpha;
    } else {
      this.toneSmoothedSemitones = this.toneTargetSemitones;
    }
    this.fn.setSemitones(this.handle, this.toneSmoothedSemitones);

    for (let n = 0; n < frames; n++) {
      for (let ch = 0; ch < channels; ch++) {
        heapF32[inOffset + n * channels + ch] = input[ch][n];
      }
    }

    this.fn.process(this.handle, this.inPtr, this.outPtr, channels, frames);

    for (let n = 0; n < frames; n++) {
      for (let ch = 0; ch < channels; ch++) {
        const y = heapF32[outOffset + n * channels + ch];
        output[ch][n] = Number.isFinite(y) ? y : 0;
      }
    }

    return true;
  }
}

registerProcessor("orcatune-processor", OrcaTuneProcessor);
