(function initDrakonPitch() {
  if (!window.__orcaTuneRuntimeBaseUrl) {
    const runtime = (typeof chrome !== "undefined" && chrome.runtime) || (typeof browser !== "undefined" && browser.runtime);
    if (runtime?.getURL) {
      window.__orcaTuneRuntimeBaseUrl = runtime.getURL("");
    }
  }

  let currentTone = 0;
  let downshiftWarmupPromise = null;
  let exportInProgress = false;
  let exportCancelRequested = false;
  let exportProgressPercent = 0;
  let exportEtaSec = null;
  function setExportTelemetry(percent, etaSec) {
    exportProgressPercent = Math.max(0, Math.min(100, Number(percent) || 0));
    exportEtaSec = Number.isFinite(etaSec) ? Math.max(0, etaSec) : null;
  }
  function resetExportTelemetry() {
    exportCancelRequested = false;
    setExportTelemetry(0, null);
  }
  function clampTone(n) {
    const step = 0.5;
    const rounded = Math.round(Number(n) / step) * step;
    return Math.max(-6, Math.min(6, rounded));
  }

  function isMiniPlayerVisible() {
    const mini = document.querySelector("ytd-miniplayer");
    if (!mini) return false;
    if (mini.hasAttribute("hidden")) return false;
    const style = window.getComputedStyle(mini);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = mini.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isInsideMiniPlayer(video) {
    return !!(video && typeof video.closest === "function" && video.closest("ytd-miniplayer"));
  }

  function findVideo() {
    const miniVisible = isMiniPlayerVisible();

    if (miniVisible) {
      const miniVideos = Array.from(document.querySelectorAll("ytd-miniplayer video"));
      const playingInMini = miniVideos.find((v) => !v.paused && v.readyState >= 2 && !v.ended);
      if (playingInMini) return playingInMini;
      const miniVid =
        document.querySelector("ytd-miniplayer video.video-stream") ||
        document.querySelector("ytd-miniplayer video");
      if (miniVid) return miniVid;
    }

    const mainSelectors = [
      "#movie_player video.video-stream",
      "#movie_player video",
      "video.html5-main-video"
    ];
    for (const sel of mainSelectors) {
      const v = document.querySelector(sel);
      if (v && !isInsideMiniPlayer(v)) return v;
    }

    const rest = Array.from(document.querySelectorAll("video")).filter((v) => !isInsideMiniPlayer(v));
    const active = rest.find((v) => !v.paused && v.readyState >= 2 && !v.ended);
    return active || rest[0] || null;
  }

  async function syncGraphAndTone(video, semitones) {
    if (!window.__orcaTuneAudioGraph) return;
    const graph = window.__orcaTuneAudioGraph;

    if (semitones !== 0) graph._activated = true;
    if (!video) return;
    if (!graph._activated) return;

    const videoChanged = graph.video != null && graph.video !== video;

    await graph.ensureGraph(video, { forceReconnect: videoChanged });
    await graph.setTone(semitones);
    await graph.resumeAudioContext();
  }

  async function applyTone(semitones) {
    if (!window.__orcaTuneAudioGraph) {
      throw new Error("Audio engine not ready");
    }
    await syncGraphAndTone(findVideo(), semitones);
    currentTone = semitones;
  }

  function getRuntimeAssetUrl(path) {
    const runtime = (typeof chrome !== "undefined" && chrome.runtime) || (typeof browser !== "undefined" && browser.runtime);
    if (runtime?.getURL) return runtime.getURL(path);
    if (window.__orcaTuneRuntimeBaseUrl) return `${window.__orcaTuneRuntimeBaseUrl}${path}`;
    throw new Error("Runtime URL unavailable");
  }

  function formatLooksAudioCapable(f) {
    const m = (f?.mimeType || "").toLowerCase();
    if (m.startsWith("audio/")) return true;
    return m.includes("opus") || m.includes("mp4a") || m.includes("aac");
  }

  function streamUrlFromFormat(f) {
    if (!f) return null;
    if (typeof f.url === "string" && f.url.length > 0) return f.url;
    if (f.signatureCipher) {
      try {
        return parseSignatureCipher(f.signatureCipher);
      } catch (_) {
        return null;
      }
    }
    if (f.cipher) {
      try {
        return parseSignatureCipher(f.cipher);
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  function resolveStreamableAudioUrl(playerResponse) {
    const sd = playerResponse?.streamingData;
    if (!sd) throw new Error("No streamingData");
    const sortByBitrate = (a, b) => Number(b?.bitrate || 0) - Number(a?.bitrate || 0);
    const adaptive = Array.isArray(sd.adaptiveFormats) ? sd.adaptiveFormats : [];
    const audioOnly = adaptive
      .filter((f) => typeof f?.mimeType === "string" && f.mimeType.startsWith("audio/"))
      .sort(sortByBitrate);
    for (let i = 0; i < audioOnly.length; i++) {
      const u = streamUrlFromFormat(audioOnly[i]);
      if (u) return u;
    }
    const progressive = Array.isArray(sd.formats) ? sd.formats : [];
    const withAudio = progressive.filter(formatLooksAudioCapable).sort(sortByBitrate);
    for (let j = 0; j < withAudio.length; j++) {
      const u = streamUrlFromFormat(withAudio[j]);
      if (u) return u;
    }
    throw new Error(
      "Audio URL unavailable (no plain url or sig= stream in this player response)"
    );
  }

  function parseSignatureCipher(cipher) {
    const params = new URLSearchParams(cipher);
    const url = params.get("url");
    const sig = params.get("sig");
    const s = params.get("s");
    const sp = params.get("sp") || "signature";
    if (!url) throw new Error("Missing URL in signatureCipher");
    if (s && !sig) {
      throw new Error("Ciphered signature is not supported yet");
    }
    if (!sig) return url;
    const u = new URL(url);
    u.searchParams.set(sp, sig);
    return u.toString();
  }

  function getYoutubeVideoIdFromPage() {
    try {
      const u = new URL(location.href);
      const v = u.searchParams.get("v");
      if (v && /^[\w-]{11}$/.test(v)) return v;
      let m = u.pathname.match(/^\/shorts\/([\w-]{11})/);
      if (m) return m[1];
      m = u.pathname.match(/^\/embed\/([\w-]{11})/);
      if (m) return m[1];
    } catch (e) {}
    return null;
  }

  /**
   * YouTube CSP blocks inline <script> in the page. Use background + scripting API
   * with world: "MAIN" instead (no unsafe-inline).
   */
  function fetchYtStreamingDataFromMainWorld() {
    return new Promise((resolve, reject) => {
      const runtime = (typeof chrome !== "undefined" && chrome.runtime) || (typeof browser !== "undefined" && browser.runtime);
      if (!runtime?.sendMessage) {
        reject(new Error("chrome.runtime.sendMessage unavailable"));
        return;
      }
      runtime.sendMessage({ type: "drakonpitch:fetch-yt-player-response" }, (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!resp?.ok) {
          reject(new Error(resp?.error || "Failed to read player response"));
          return;
        }
        resolve(resp.payload);
      });
    });
  }

  function fetchYtStreamingDataInnertube() {
    return new Promise((resolve, reject) => {
      const videoId = getYoutubeVideoIdFromPage();
      if (!videoId) {
        reject(new Error("Cannot read video id from this page"));
        return;
      }
      const runtime =
        (typeof chrome !== "undefined" && chrome.runtime) || (typeof browser !== "undefined" && browser.runtime);
      if (!runtime?.sendMessage) {
        reject(new Error("chrome.runtime.sendMessage unavailable"));
        return;
      }
      runtime.sendMessage({ type: "drakonpitch:innertube-streaming-data", videoId }, (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!resp?.ok) {
          reject(new Error(resp?.error || "Innertube fallback failed"));
          return;
        }
        resolve({ streamingData: resp.streamingData });
      });
    });
  }

  async function getYouTubeAudioUrl() {
    console.log("[DrakonPitch][Export] Reading streamingData via background (MAIN world)…");
    const response = await fetchYtStreamingDataFromMainWorld();
    try {
      return resolveStreamableAudioUrl(response);
    } catch (firstErr) {
      const vid = getYoutubeVideoIdFromPage();
      if (!vid) throw firstErr;
      console.log("[DrakonPitch][Export] Page streams need decipher; trying Innertube (other clients)…");
      const alt = await fetchYtStreamingDataInnertube();
      return resolveStreamableAudioUrl(alt);
    }
  }

  /**
   * MAIN-world fetch; return bytes via postMessage (transferable ArrayBuffer).
   */
  function fetchAudioUrlInMainWorldAsArrayBufferCore(audioUrl) {
    return new Promise((resolve, reject) => {
      const origin = location.origin;
      const token = `drakon_audio_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const timeoutMs = 600000;
      const timer = setTimeout(() => {
        window.removeEventListener("message", onMsg);
        reject(new Error("Audio fetch timeout"));
      }, timeoutMs);
      function onMsg(e) {
        if (e.source !== window || e.origin !== origin) return;
        const d = e.data;
        if (!d || d.type !== "DRAKON_AUDIO_FETCH" || d.token !== token) return;
        clearTimeout(timer);
        window.removeEventListener("message", onMsg);
        if (!d.ok) {
          reject(new Error(d.error || `Audio fetch failed: ${d.status}`));
          return;
        }
        if (!d.arrayBuffer) {
          reject(new Error("No audio buffer received"));
          return;
        }
        resolve(d.arrayBuffer);
      }
      window.addEventListener("message", onMsg);
      const runtime =
        (typeof chrome !== "undefined" && chrome.runtime) || (typeof browser !== "undefined" && browser.runtime);
      runtime.sendMessage({ type: "drakonpitch:fetch-audio-main", url: audioUrl, token }, (resp) => {
        if (chrome.runtime.lastError) {
          clearTimeout(timer);
          window.removeEventListener("message", onMsg);
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!resp?.ok) {
          clearTimeout(timer);
          window.removeEventListener("message", onMsg);
          reject(new Error(resp?.error || "Background audio fetch failed"));
        }
      });
    });
  }

  /** Session DNR rule so googlevideo sees Referer/Origin from a real watch URL. */
  async function fetchAudioUrlInMainWorldAsArrayBuffer(audioUrl) {
    const referer = location.href;
    const runtime =
      (typeof chrome !== "undefined" && chrome.runtime) || (typeof browser !== "undefined" && browser.runtime);
    let ruleId = null;
    await new Promise((res) => {
      runtime.sendMessage({ type: "drakonpitch:googlevideo-dnr", action: "start", referer }, (r) => {
        if (!chrome.runtime.lastError && r?.ok && Number.isInteger(r.ruleId)) {
          ruleId = r.ruleId;
        }
        res();
      });
    });
    try {
      return await fetchAudioUrlInMainWorldAsArrayBufferCore(audioUrl);
    } finally {
      if (ruleId != null) {
        runtime.sendMessage({ type: "drakonpitch:googlevideo-dnr", action: "stop", ruleId }, () => {});
      }
    }
  }

  function waitVideoSeeked(video, time) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        video.removeEventListener("seeked", onSeeked);
        resolve();
      }, 12000);
      const onSeeked = () => {
        clearTimeout(timeout);
        video.removeEventListener("seeked", onSeeked);
        resolve();
      };
      video.addEventListener("seeked", onSeeked, { once: true });
      try {
        video.currentTime = time;
      } catch (e) {
        clearTimeout(timeout);
        video.removeEventListener("seeked", onSeeked);
        reject(e);
      }
    });
  }

  /**
   * Realtime MP3 export: encode while playing, so end-of-video download is near-instant.
   */
  async function recordProcessedAudioFromGraphRealtime(semitones, video) {
    const graph = window.__orcaTuneAudioGraph;
    if (!graph) throw new Error("Audio engine not ready");
    graph._activated = true;
    await syncGraphAndTone(video, semitones);
    await graph.resumeAudioContext();

    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      throw new Error("Realtime export needs a finite duration (not live streams)");
    }

    const lame =
      (typeof globalThis !== "undefined" && globalThis.lamejs) ||
      (typeof window !== "undefined" && window.lamejs);
    if (!lame?.Mp3Encoder) throw new Error("lamejs Mp3Encoder not available");
    const ctx = graph.audioContext;
    const outputGain = graph.outputGainNode;
    if (!ctx || !outputGain) throw new Error("Audio graph output is not ready");

    const channels = 2;
    const sampleRate = ctx.sampleRate;
    const encoder = new lame.Mp3Encoder(channels, sampleRate, 192);
    const mp3Chunks = [];

    const captureNode = ctx.createScriptProcessor(4096, channels, channels);
    const silentSink = ctx.createGain();
    silentSink.gain.value = 0;
    captureNode.connect(silentSink);
    silentSink.connect(ctx.destination);

    captureNode.onaudioprocess = (event) => {
      const input = event.inputBuffer;
      const frames = input.length;
      if (frames <= 0) return;
      const leftF = input.getChannelData(0);
      const rightF = input.numberOfChannels > 1 ? input.getChannelData(1) : leftF;
      const left = new Int16Array(frames);
      const right = new Int16Array(frames);
      for (let i = 0; i < frames; i++) {
        const lv = Math.max(-1, Math.min(1, leftF[i]));
        const rv = Math.max(-1, Math.min(1, rightF[i]));
        left[i] = lv < 0 ? Math.round(lv * 32768) : Math.round(lv * 32767);
        right[i] = rv < 0 ? Math.round(rv * 32768) : Math.round(rv * 32767);
      }
      const encoded = encoder.encodeBuffer(left, right);
      if (encoded?.length) mp3Chunks.push(new Uint8Array(encoded));
    };

    const durMin = ((video.duration || 0) / 60).toFixed(1);
    console.log(
      "[DrakonPitch][Export] Realtime graph capture ~",
      durMin,
      "min wall-clock (audio already pitch-shifted, encoding MP3 in realtime)"
    );

    outputGain.connect(captureNode);
    const savedRate = video.playbackRate;
    const savedLoop = video.loop;
    const savedTime = video.currentTime;
    const wasPaused = video.paused;
    try {
      setExportTelemetry(0, Math.ceil(video.duration || 0));
      video.loop = false;
      video.playbackRate = 1;
      await waitVideoSeeked(video, 0);

      try {
        await video.play();
      } catch (playErr) {
        console.warn("[DrakonPitch][Export] play() warning:", playErr);
        if (video.paused) await video.play();
      }

      await new Promise((resolve, reject) => {
        // Give enough margin for buffering; user can wait full playback.
        const estimated = Math.ceil(video.duration * 1000);
        const durMs = Math.min(12 * 60 * 60 * 1000, Math.max(120000, estimated + 30000));
        let settled = false;
        let progressTimer;
        let t;
        const cleanup = () => {
          if (settled) return;
          settled = true;
          clearInterval(progressTimer);
          clearTimeout(t);
          video.removeEventListener("ended", onEnded);
          video.removeEventListener("pause", onPauseLike);
          video.removeEventListener("emptied", onPauseLike);
          video.removeEventListener("abort", onPauseLike);
        };
        const finish = () => {
          cleanup();
          setExportTelemetry(100, 0);
          resolve();
        };
        progressTimer = setInterval(() => {
          const dur = video.duration || 0;
          const cur = Math.max(0, video.currentTime || 0);
          if (dur > 0 && Number.isFinite(dur)) {
            const percent = (cur / dur) * 100;
            const remain = Math.max(0, Math.ceil(dur - cur));
            setExportTelemetry(percent, remain);
          }
          if (exportCancelRequested) {
            cleanup();
            reject(new Error("Export cancelled by user"));
            return;
          }
          if (
            video.ended ||
            (Number.isFinite(dur) && dur > 0 && cur >= dur - 0.05)
          ) {
            finish();
          }
        }, 200);
        const onEnded = () => finish();
        const onPauseLike = () => {
          const dur = video.duration || 0;
          const cur = video.currentTime || 0;
          if (video.ended || (dur > 0 && cur >= dur - 0.25)) {
            finish();
          }
        };
        t = setTimeout(() => {
          cleanup();
          reject(new Error("Timeout waiting for video end"));
        }, durMs);
        video.addEventListener("ended", onEnded);
        video.addEventListener("pause", onPauseLike);
        video.addEventListener("emptied", onPauseLike);
        video.addEventListener("abort", onPauseLike);
        if (video.ended) finish();
      });
    } finally {
      captureNode.onaudioprocess = null;
      try {
        outputGain.disconnect(captureNode);
      } catch (_) {}
      try {
        captureNode.disconnect();
      } catch (_) {}
      try {
        silentSink.disconnect();
      } catch (_) {}
    }

    const tail = encoder.flush();
    if (tail?.length) mp3Chunks.push(new Uint8Array(tail));
    if (mp3Chunks.length === 0) throw new Error("No MP3 frames captured");
    const blob = new Blob(mp3Chunks, { type: "audio/mpeg" });
    if (blob.size === 0) throw new Error("Empty MP3 output");
    console.log("[DrakonPitch][Export] Realtime MP3 done:", {
      sizeBytes: blob.size,
      sampleRate,
      channels
    });

    // Restore video state asynchronously; do not block the download trigger.
    (async () => {
      try {
        const live = findVideo();
        if (!live || live !== video) return;
        live.playbackRate = savedRate;
        live.loop = savedLoop;
        if (Number.isFinite(savedTime) && savedTime >= 0) {
          try {
            await waitVideoSeeked(live, savedTime);
          } catch (_) {}
        }
        if (wasPaused) {
          try {
            live.pause();
          } catch (_) {}
        } else {
          try {
            await live.play();
          } catch (_) {}
        }
      } catch (_) {}
    })();

    return blob;
  }

  async function fetchAndDecodeSourceAudio(audioUrl) {
    console.log("[DrakonPitch][Export] Fetch audio url:", audioUrl);
    const bytes = await fetchAudioUrlInMainWorldAsArrayBuffer(audioUrl);
    console.log("[DrakonPitch][Export] Audio bytes:", bytes.byteLength);
    const decodeCtx = new AudioContext({ latencyHint: "playback" });
    try {
      const decoded = await decodeCtx.decodeAudioData(bytes.slice(0));
      console.log("[DrakonPitch][Export] Decoded buffer:", {
        channels: decoded.numberOfChannels,
        sampleRate: decoded.sampleRate,
        durationSec: Number(decoded.duration.toFixed(2))
      });
      return decoded;
    } finally {
      decodeCtx.close().catch(() => {});
    }
  }

  async function renderPitchShiftedOffline(inputBuffer, semitones) {
    console.log("[DrakonPitch][Export] Offline render start:", { semitones });
    const channels = Math.min(2, inputBuffer.numberOfChannels || 1);
    const sr = inputBuffer.sampleRate;
    const length = inputBuffer.length;
    const offline = new OfflineAudioContext(channels, length, sr);
    await offline.audioWorklet.addModule(getRuntimeAssetUrl("audio/orcatune-worklet.js"));
    const node = new AudioWorkletNode(offline, "orcatune-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [channels],
      processorOptions: {
        wasmUrl: getRuntimeAssetUrl("wasm/orcatune_bungee.wasm"),
        wasmJsUrl: getRuntimeAssetUrl("wasm/orcatune_bungee.js"),
        channels,
        maxBlockSize: 2048
      }
    });
    const payload = await window.__orcaTuneAudioGraph?.getWasmPayload?.();
    if (!payload?.jsText || !payload?.wasmBytes) {
      throw new Error("WASM payload unavailable");
    }
    const wasmCopy = payload.wasmBytes.slice(0);
    node.port.postMessage(
      { type: "wasmPayload", jsText: payload.jsText, wasmBytes: wasmCopy },
      [wasmCopy]
    );
    node.port.postMessage({ type: "setTone", semitones });

    const source = offline.createBufferSource();
    source.buffer = inputBuffer;
    source.connect(node);
    node.connect(offline.destination);
    source.start(0);

    const rendered = await offline.startRendering();
    console.log("[DrakonPitch][Export] Offline render done:", {
      channels: rendered.numberOfChannels,
      sampleRate: rendered.sampleRate,
      durationSec: Number(rendered.duration.toFixed(2))
    });
    return rendered;
  }

  function interleaveToI16(audioBuffer, startFrame, frameCount, channels) {
    const out = new Int16Array(frameCount * channels);
    let k = 0;
    for (let i = 0; i < frameCount; i++) {
      for (let ch = 0; ch < channels; ch++) {
        const channelData = audioBuffer.getChannelData(ch);
        const x = Math.max(-1, Math.min(1, channelData[startFrame + i]));
        out[k++] = x < 0 ? Math.round(x * 32768) : Math.round(x * 32767);
      }
    }
    return out;
  }

  async function encodeMp3WithWebCodecs(audioBuffer) {
    console.log("[DrakonPitch][Export] MP3 encode start");
    if (typeof AudioEncoder === "undefined") {
      throw new Error("AudioEncoder is not available in this browser");
    }
    const channels = Math.max(1, Math.min(2, audioBuffer.numberOfChannels));
    const sampleRate = audioBuffer.sampleRate;
    const config = { codec: "mp3", sampleRate, numberOfChannels: channels, bitrate: 192000 };
    const support = await AudioEncoder.isConfigSupported(config);
    if (!support?.supported) {
      throw new Error("MP3 encoding is not supported by this browser");
    }

    const chunks = [];
    const encoder = new AudioEncoder({
      output: (chunk) => {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        chunks.push(bytes);
      },
      error: (e) => {
        throw e;
      }
    });
    encoder.configure(config);

    const frameSize = 1152;
    const frames = audioBuffer.length;
    for (let offset = 0; offset < frames; offset += frameSize) {
      const count = Math.min(frameSize, frames - offset);
      const interleaved = interleaveToI16(audioBuffer, offset, count, channels);
      const audioData = new AudioData({
        format: "s16",
        sampleRate,
        numberOfFrames: count,
        numberOfChannels: channels,
        timestamp: Math.round((offset * 1_000_000) / sampleRate),
        data: interleaved
      });
      encoder.encode(audioData);
      audioData.close();
    }
    await encoder.flush();
    encoder.close();
    const blob = new Blob(chunks, { type: "audio/mpeg" });
    console.log("[DrakonPitch][Export] MP3 encode done:", {
      chunks: chunks.length,
      sizeBytes: blob.size
    });
    return blob;
  }

  async function resampleAudioBufferIfNeeded(audioBuffer) {
    const allowed = [32000, 44100, 48000];
    if (allowed.includes(audioBuffer.sampleRate)) return audioBuffer;
    const channels = Math.max(1, Math.min(2, audioBuffer.numberOfChannels));
    const targetRate = 44100;
    const targetLength = Math.max(1, Math.ceil(audioBuffer.duration * targetRate));
    const offline = new OfflineAudioContext(channels, targetLength, targetRate);
    const src = offline.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(offline.destination);
    src.start(0);
    return offline.startRendering();
  }

  async function encodeMp3WithLameJs(audioBuffer) {
    const lame =
      (typeof globalThis !== "undefined" && globalThis.lamejs) ||
      (typeof window !== "undefined" && window.lamejs);
    if (!lame?.Mp3Encoder) {
      throw new Error("lamejs Mp3Encoder not available");
    }
    const normalized = await resampleAudioBufferIfNeeded(audioBuffer);
    const channels = Math.max(1, Math.min(2, normalized.numberOfChannels));
    const sampleRate = normalized.sampleRate;
    const kbps = 192;
    const encoder = new lame.Mp3Encoder(channels, sampleRate, kbps);
    const left = normalized.getChannelData(0);
    const right = channels > 1 ? normalized.getChannelData(1) : null;
    const blockSize = 1152;
    const out = [];
    for (let i = 0; i < left.length; i += blockSize) {
      const end = Math.min(i + blockSize, left.length);
      const leftChunk = new Int16Array(end - i);
      const rightChunk = channels > 1 ? new Int16Array(end - i) : null;
      for (let j = 0; j < end - i; j++) {
        const lv = Math.max(-1, Math.min(1, left[i + j]));
        leftChunk[j] = lv < 0 ? Math.round(lv * 32768) : Math.round(lv * 32767);
        if (rightChunk) {
          const rv = Math.max(-1, Math.min(1, right[i + j]));
          rightChunk[j] = rv < 0 ? Math.round(rv * 32768) : Math.round(rv * 32767);
        }
      }
      const mp3buf = rightChunk ? encoder.encodeBuffer(leftChunk, rightChunk) : encoder.encodeBuffer(leftChunk);
      if (mp3buf?.length) out.push(new Uint8Array(mp3buf));
    }
    const flushed = encoder.flush();
    if (flushed?.length) out.push(new Uint8Array(flushed));
    const blob = new Blob(out, { type: "audio/mpeg" });
    if (blob.size === 0) {
      throw new Error("lamejs produced empty MP3");
    }
    console.log("[DrakonPitch][Export] MP3 encode done (lamejs):", { sizeBytes: blob.size, sampleRate, channels });
    return blob;
  }

  async function encodeForDownload(audioBuffer) {
    try {
      const mp3 = await encodeMp3WithWebCodecs(audioBuffer);
      return { blob: mp3, ext: "mp3", format: "MP3(WebCodecs)" };
    } catch (e) {
      const msg = String(e?.message != null ? e.message : e);
      console.warn("[DrakonPitch][Export] WebCodecs MP3 unavailable, fallback lamejs:", msg);
      const mp3 = await encodeMp3WithLameJs(audioBuffer);
      return { blob: mp3, ext: "mp3", format: "MP3(lamejs)" };
    }
  }

  function sanitizeFileName(name) {
    return String(name || "drakonpitch-export")
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
  }

  function getStableExportTitleSnapshot() {
    const h1 =
      document.querySelector("ytd-watch-metadata h1 yt-formatted-string") ||
      document.querySelector("h1.title yt-formatted-string") ||
      document.querySelector("h1.ytd-watch-metadata");
    const fromH1 = h1?.textContent?.trim();
    if (fromH1) return fromH1;
    const fromDocTitle = String(document.title || "").replace(/\s*-\s*YouTube\s*$/i, "").trim();
    if (fromDocTitle) return fromDocTitle;
    return "youtube-audio";
  }

  function downloadBlob(blob, fileName) {
    console.log("[DrakonPitch][Export] Trigger download:", { fileName, sizeBytes: blob.size });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function exportProcessedAudioMp3(semitones) {
    if (exportInProgress) throw new Error("Export is already running");
    exportInProgress = true;
    exportCancelRequested = false;
    setExportTelemetry(0, null);
    try {
      chrome.runtime?.sendMessage?.({ type: "drakonpitch:export-state-update", exporting: true }, () => {});
    } catch (_) {}
    console.log("[DrakonPitch][Export] ===== START =====");
    try {
      const tone = clampTone(semitones);
      console.log("[DrakonPitch][Export] Target tone:", tone);
      const video = findVideo();
      if (!video) throw new Error("No video on page");
      const exportTitleSnapshot = getStableExportTitleSnapshot();
      console.log("[DrakonPitch][Export] Title snapshot:", exportTitleSnapshot);
      const graph = window.__orcaTuneAudioGraph;
      if (graph) graph._activated = true;
      await syncGraphAndTone(video, tone);

      console.log("[DrakonPitch][Export] Realtime mode enabled: encode MP3 while video is playing.");
      const mp3Blob = await recordProcessedAudioFromGraphRealtime(tone, video);
      const title = sanitizeFileName(exportTitleSnapshot);
      const toneLabel = tone >= 0 ? `+${tone}` : `${tone}`;
      downloadBlob(mp3Blob, `${title} [DrakonPitch ${toneLabel}st].mp3`);
      console.log("[DrakonPitch][Export] Download format: MP3(realtime)");
      console.log("[DrakonPitch][Export] ===== SUCCESS =====");
    } finally {
      exportInProgress = false;
      resetExportTelemetry();
      try {
        chrome.runtime?.sendMessage?.({ type: "drakonpitch:export-state-update", exporting: false }, () => {});
      } catch (_) {}
    }
  }

  async function prepareDownshift() {
    if (downshiftWarmupPromise) {
      await downshiftWarmupPromise;
      return;
    }
    downshiftWarmupPromise = (async () => {
      if (!window.__orcaTuneAudioGraph) {
        throw new Error("Audio graph unavailable");
      }
      // Hidden warmup: do not bind YouTube video/source yet, so user audio stays normal.
      await window.__orcaTuneAudioGraph.prepareDownshiftWarmup();
    })();
    try {
      await downshiftWarmupPromise;
    } catch (err) {
      downshiftWarmupPromise = null;
      throw err;
    }
  }

  function clearDownshiftWarmupState() {
    downshiftWarmupPromise = null;
  }

  window.addEventListener("drakonpitch:warmup-reset", clearDownshiftWarmupState);

  let rebindDebounceTimer = null;
  async function rebindIfVideoSwapped() {
    const graph = window.__orcaTuneAudioGraph;
    if (!graph || !graph._activated) return;
    const video = findVideo();
    if (!video || graph.video === video) return;
    await syncGraphAndTone(video, currentTone);
  }

  function scheduleVideoRebindCheck() {
    clearTimeout(rebindDebounceTimer);
    rebindDebounceTimer = setTimeout(() => {
      rebindIfVideoSwapped().catch(() => {});
    }, 120);
  }

  setInterval(() => {
    rebindIfVideoSwapped().catch(() => {});
  }, 450);

  window.addEventListener("yt-navigate-finish", scheduleVideoRebindCheck);
  document.addEventListener("yt-page-data-updated", scheduleVideoRebindCheck);

  // Listen for messages from popup
  const runtime = (typeof chrome !== "undefined" && chrome.runtime) || (typeof browser !== "undefined" && browser.runtime);
  let setToneQueue = Promise.resolve();
  if (runtime?.onMessage) {
    runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === "drakonpitch:set-tone") {
        const semitones = clampTone(msg.tone ?? 0);
        setToneQueue = setToneQueue
          .catch(() => {})
          .then(async () => {
            try {
              await applyTone(semitones);
              sendResponse({ ok: true, tone: currentTone });
            } catch (err) {
              sendResponse({
                ok: false,
                error: String(err?.message != null ? err.message : err)
              });
            }
          });
        return true;
      }
      if (msg?.type === "drakonpitch:prepare-downshift") {
        setToneQueue = setToneQueue
          .catch(() => {})
          .then(async () => {
            try {
              await prepareDownshift();
              sendResponse({ ok: true, prepared: downshiftWarmupPromise !== null, tone: currentTone });
            } catch (err) {
              sendResponse({
                ok: false,
                error: String(err?.message != null ? err.message : err)
              });
            }
          });
        return true;
      }
      if (msg?.type === "drakonpitch:export-audio") {
        const semitones = clampTone(msg.tone ?? currentTone);
        console.log("[DrakonPitch][Export] Message received:", { semitones });
        setToneQueue = setToneQueue
          .catch(() => {})
          .then(async () => {
            try {
              await exportProcessedAudioMp3(semitones);
              sendResponse({ ok: true, tone: currentTone });
            } catch (err) {
              const errText = String(err?.message != null ? err.message : err);
              if (errText.toLowerCase().includes("cancel")) {
                console.info("[DrakonPitch][Export] Cancelled by user");
              } else {
                console.error("[DrakonPitch][Export] FAILED:", err);
              }
              sendResponse({
                ok: false,
                error: errText
              });
            }
          });
        return true;
      }
      if (msg?.type === "drakonpitch:get-tone") {
        sendResponse({ tone: currentTone, prepared: downshiftWarmupPromise !== null });
        return false;
      }
      if (msg?.type === "drakonpitch:get-export-status") {
        sendResponse({
          ok: true,
          exporting: exportInProgress,
          progressPercent: exportProgressPercent,
          etaSec: exportEtaSec,
          canCancel: exportInProgress
        });
        return false;
      }
      if (msg?.type === "drakonpitch:cancel-export") {
        if (!exportInProgress) {
          sendResponse({ ok: false, error: "No export is currently running" });
          return false;
        }
        exportCancelRequested = true;
        sendResponse({ ok: true });
        return false;
      }
    });
  }

  // Resume audio context on visibility change
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    window.__orcaTuneAudioGraph?.resumeAudioContext?.().catch(() => {});
  });
})();
