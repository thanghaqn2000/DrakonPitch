(function initOrcaTuneAudioBridge() {
  if (window.__orcaTuneAudioGraph) {
    return;
  }

  function getAssetUrl(path) {
    const runtime = (typeof chrome !== "undefined" && chrome.runtime) || (typeof browser !== "undefined" && browser.runtime);
    if (runtime?.getURL) return runtime.getURL(path);

    const base = window.__orcaTuneRuntimeBaseUrl;
    if (base) return `${base}${path}`;

    throw new Error("DrakonPitch runtime URL is unavailable");
  }

  class OrcaTuneAudioGraph {
    constructor() {
      this.audioContext = null;
      this.workletNode = null;
      this.outputGainNode = null;
      this.elementSourceNodeMap = new WeakMap();
      // Currently connected video + its source node
      this.video = null;
      this._activeSource = null;
      this.currentTone = 0;
      this.wasmPayload = null;
      this._workletModuleLoaded = false;
      this._downshiftPrepared = false;
      this._downshiftPreparePromise = null;
      // Must be explicitly activated (user set non-zero tone) before any
      // audio capture happens. Prevents auto-capture on page load.
      this._activated = false;
    }

    async getWasmPayload() {
      if (this.wasmPayload) return this.wasmPayload;
      const wasmUrl = getAssetUrl("wasm/orcatune_bungee.wasm");
      const wasmJsUrl = getAssetUrl("wasm/orcatune_bungee.js");
      const [jsText, wasmBytes] = await Promise.all([
        fetch(wasmJsUrl).then((r) => r.text()),
        fetch(wasmUrl).then((r) => r.arrayBuffer())
      ]);
      this.wasmPayload = { jsText, wasmBytes };
      return this.wasmPayload;
    }

    // Create the worklet chain ONCE. Never recreate unless emergencyBypass.
    async _initWorklet() {
      this.audioContext = this.audioContext || new AudioContext({ latencyHint: "interactive" });
      if (!this._workletModuleLoaded) {
        await this.audioContext.audioWorklet.addModule(getAssetUrl("audio/orcatune-worklet.js"));
        this._workletModuleLoaded = true;
      }
      if (this.workletNode) return;

      this.workletNode = new AudioWorkletNode(this.audioContext, "orcatune-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: {
          wasmUrl: getAssetUrl("wasm/orcatune_bungee.wasm"),
          wasmJsUrl: getAssetUrl("wasm/orcatune_bungee.js"),
          channels: 2,
          maxBlockSize: 2048
        }
      });

      this.outputGainNode = this.audioContext.createGain();
      this.outputGainNode.gain.value = 1;
      try {
        this.workletNode.connect(this.outputGainNode);
        this.outputGainNode.connect(this.audioContext.destination);
      } catch (_) {}

      this.workletNode.port.onmessage = (event) => {
        if (event?.data?.type === "error") {
          console.error("DrakonPitch worklet error:", event.data.message);
          this.emergencyBypass();
        }
      };

      const payload = await this.getWasmPayload();
      const copy = payload.wasmBytes.slice(0);
      this.workletNode.port.postMessage(
        { type: "wasmPayload", jsText: payload.jsText, wasmBytes: copy },
        [copy]
      );
      this.workletNode.port.postMessage({ type: "setTone", semitones: this.currentTone });
    }

    _setMuted(muted) {
      if (!this.outputGainNode || !this.audioContext) return;
      const now = this.audioContext.currentTime;
      const target = muted ? 0 : 1;
      this.outputGainNode.gain.cancelScheduledValues(now);
      this.outputGainNode.gain.setTargetAtTime(target, now, 0.01);
    }

    async prepareDownshiftWarmup() {
      if (this._downshiftPrepared) return;
      if (this._downshiftPreparePromise) {
        await this._downshiftPreparePromise;
        return;
      }
      this._downshiftPreparePromise = (async () => {
        await this._initWorklet();
        await this.audioContext.resume();

        // Feed silent signal into worklet so DSP state warms without affecting user audio.
        const source = this.audioContext.createConstantSource();
        source.offset.value = 0;
        source.connect(this.workletNode);
        source.start();
        this._setMuted(true);

        try {
          // Drive both cascaded smoothers (JS 400 ms + C++ 450 ms) to full convergence at -6.
          // ~3500 ms covers WASM load time (~500 ms) + 99%+ cascade convergence (~2100 ms)
          // with comfortable margin. Engine is intentionally LEFT at -6 after warmup so that
          // every subsequent user-facing transition goes UPWARD (fast, artifact-free).
          this.workletNode.port.postMessage({ type: "setTone", semitones: -6 });
          await new Promise((resolve) => setTimeout(resolve, 3500));
          // Do NOT reset to 0. Keeping target at -6 means any user tone ≥ -6
          // causes an upward (clean) transition, never a downward one.
          this._downshiftPrepared = true;
        } finally {
          this._setMuted(false);
          try {
            source.stop();
          } catch (_) {}
          try {
            source.disconnect();
          } catch (_) {}
        }
      })();

      try {
        await this._downshiftPreparePromise;
      } finally {
        this._downshiftPreparePromise = null;
      }
    }

    // Only swap SourceNode. Never recreate the worklet.
    // NOTE: createMediaElementSource() automatically reroutes audio through Web
    // Audio, so we do NOT manually mute the video element. Setting video.muted=true
    // would cause Chrome to suppress the audio pipeline feeding into the source
    // node, resulting in permanent silence.
    async ensureGraph(videoElement, options = {}) {
      if (!videoElement) return false;
      // Hard gate: never capture audio unless user has explicitly requested pitch shift.
      if (!this._activated) return false;

      await this._initWorklet();
      await this.audioContext.resume();

      const videoChanged = this.video !== videoElement;

      if (!videoChanged && !options.forceReconnect) {
        return true;
      }

      // Disconnect current source from worklet (keeps worklet→destination alive).
      if (this._activeSource && this.workletNode) {
        try {
          this._activeSource.disconnect(this.workletNode);
        } catch (_) {}
      }

      this.video = videoElement;

      // Reuse cached MediaElementSource for this element (avoids InvalidStateError).
      let source = this.elementSourceNodeMap.get(videoElement);
      if (!source) {
        source = this.audioContext.createMediaElementSource(videoElement);
        this.elementSourceNodeMap.set(videoElement, source);
      }
      this._activeSource = source;

      try {
        this._activeSource.connect(this.workletNode);
      } catch (_) {}

      return true;
    }

    async resumeAudioContext() {
      if (this.audioContext?.state === "suspended") {
        await this.audioContext.resume();
      }
    }

    emergencyBypass() {
      try {
        if (this.workletNode) this.workletNode.disconnect();
      } catch (_) {}
      try {
        if (this._activeSource) this._activeSource.disconnect();
      } catch (_) {}
      this.workletNode = null;
      this.outputGainNode = null;
      this._activeSource = null;
      this.video = null;
      this._downshiftPrepared = false;
      this._downshiftPreparePromise = null;
      window.dispatchEvent(new CustomEvent("drakonpitch:warmup-reset"));
    }

    async setTone(semitones) {
      this.currentTone = semitones;
      if (semitones !== 0) this._activated = true;
      if (!this.video) return;
      try {
        await this.ensureGraph(this.video);
        if (this.workletNode) {
          this.workletNode.port.postMessage({ type: "setTone", semitones });
        }
      } catch (error) {
        console.error("DrakonPitch setTone failed:", error);
        this.emergencyBypass();
      }
    }

    async disconnect() {
      if (this.workletNode) {
        this.workletNode.port.postMessage({ type: "destroy" });
        this.workletNode.disconnect();
        this.workletNode = null;
      }
      if (this.outputGainNode) {
        this.outputGainNode.disconnect();
        this.outputGainNode = null;
      }
      if (this._activeSource) {
        this._activeSource.disconnect();
        this._activeSource = null;
      }
      this.video = null;
      this._downshiftPrepared = false;
      this._downshiftPreparePromise = null;
      window.dispatchEvent(new CustomEvent("drakonpitch:warmup-reset"));
    }
  }

  window.__orcaTuneAudioGraph = new OrcaTuneAudioGraph();
})();
