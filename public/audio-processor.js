/**
 * NSOffice Live Audio Pipeline
 * Handles 16kHz PCM audio capture, downsampling, 24kHz PCM playback queue,
 * visualizer analysis, and instantaneous barge-in interruption cutoff.
 */

class AudioStreamManager {
  constructor(options = {}) {
    // Called for every captured mic frame with 16kHz PCM (base64), its RMS
    // level and duration. Voice-activity decisions live in the app.
    this.onAudioFrame = options.onAudioFrame || (() => {});
    this.onUserVolume = options.onUserVolume || (() => {});
    this.onAiVolume = options.onAiVolume || (() => {});
    this.onBargeIn = options.onBargeIn || (() => {});
    this.onPlaybackStarted = options.onPlaybackStarted || (() => {});
    this.onPlaybackFinished = options.onPlaybackFinished || (() => {});
    // Minimum silence gap enforced between two DISTINCT speaking turns (e.g.
    // one question ending and the next question/dialogue starting), so that
    // even if a stray/duplicate turn slips through, it can never sound like
    // it overlaps or talks over the previous one.
    this.turnPauseSeconds = options.turnPauseSeconds || 2.5;
    this.lastTurnEndTime = 0;

    this.inputAudioContext = null;
    this.outputAudioContext = null;
    this.mediaStream = null;
    this.processorNode = null;
    this.sourceNode = null;
    this.inputAnalyser = null;
    this.outputAnalyser = null;
    this.muteGain = null;

    this.isRecording = false;
    this.isMuted = false;

    // Playback state
    this.scheduledSources = [];
    this.nextPlayTime = 0;
    this.isPlayingAi = false;
  }

  ensureOutputContext() {
    if (!this.outputAudioContext) {
      // Use standard system audio context without forcing 24000Hz (which errors on many Windows sound drivers)
      this.outputAudioContext = new (window.AudioContext || window.webkitAudioContext)();
      this.outputAnalyser = this.outputAudioContext.createAnalyser();
      this.outputAnalyser.fftSize = 256;
      this.outputAnalyser.connect(this.outputAudioContext.destination);
    }
    if (this.outputAudioContext.state === 'suspended') {
      this.outputAudioContext.resume().catch(e => console.warn('Output AudioContext resume:', e));
    }
    return this.outputAudioContext;
  }

  async startInput() {
    if (this.isRecording) return;

    try {
      // 1. Ensure both input and output contexts are unlocked within this user gesture
      this.ensureOutputContext();
      if (this.outputAudioContext && this.outputAudioContext.state === 'suspended') {
        await this.outputAudioContext.resume();
      }

      this.inputAudioContext = new (window.AudioContext || window.webkitAudioContext)();
      if (this.inputAudioContext.state === 'suspended') {
        await this.inputAudioContext.resume();
      }

      this.mediaStream = await navigator.mediaDevices.getUserMedia(this.micConstraints());

      this.inputAnalyser = this.inputAudioContext.createAnalyser();
      this.inputAnalyser.fftSize = 256;
      this.sourceNode = this.inputAudioContext.createMediaStreamSource(this.mediaStream);
      this.sourceNode.connect(this.inputAnalyser);

      // ScriptProcessorNode for downsampling to 16kHz
      const bufferSize = 4096;
      this.processorNode = this.inputAudioContext.createScriptProcessor(bufferSize, 1, 1);

      const inputSampleRate = this.inputAudioContext.sampleRate;
      const targetSampleRate = 16000;

      this.processorNode.onaudioprocess = (e) => {
        if (!this.isRecording || this.isMuted) return;

        const inputData = e.inputBuffer.getChannelData(0);

        // Calculate input volume for visualizer
        let sum = 0;
        for (let i = 0; i < inputData.length; i++) {
          sum += inputData[i] * inputData[i];
        }
        const rms = Math.sqrt(sum / inputData.length);
        const normalizedVol = Math.min(1, rms * 4);
        this.onUserVolume(normalizedVol);

        const frameMs = (inputData.length / inputSampleRate) * 1000;
        const downsampled = this.downsampleTo16k(inputData, inputSampleRate, targetSampleRate);
        this.onAudioFrame(this.floatTo16BitPCMBase64(downsampled), rms, frameMs);
      };

      this.sourceNode.connect(this.processorNode);

      // Connect to zero-gain node to keep processor active without feeding mic back into speakers!
      this.muteGain = this.inputAudioContext.createGain();
      this.muteGain.gain.value = 0;
      this.processorNode.connect(this.muteGain);
      this.muteGain.connect(this.inputAudioContext.destination);

      this.isRecording = true;
      console.log('[AudioStreamManager] Input and Output audio pipelines active.');
    } catch (err) {
      console.error('Error starting audio input:', err);
      throw err;
    }
  }

  micConstraints(deviceId) {
    return {
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    };
  }

  getInputDevice() {
    const track = this.mediaStream && this.mediaStream.getAudioTracks()[0];
    return track ? { deviceId: track.getSettings().deviceId, label: track.label } : null;
  }

  // Swaps the capture device mid-session; the processing graph stays as is.
  async switchInputDevice(deviceId) {
    const newStream = await navigator.mediaDevices.getUserMedia(this.micConstraints(deviceId));
    if (this.sourceNode) this.sourceNode.disconnect();
    if (this.mediaStream) this.mediaStream.getTracks().forEach(t => t.stop());
    this.mediaStream = newStream;
    this.sourceNode = this.inputAudioContext.createMediaStreamSource(newStream);
    this.sourceNode.connect(this.inputAnalyser);
    this.sourceNode.connect(this.processorNode);
    return this.getInputDevice();
  }

  downsampleTo16k(buffer, fromRate, toRate) {
    if (fromRate === toRate) return buffer;
    const ratio = fromRate / toRate;
    const newLength = Math.round(buffer.length / ratio);
    const result = new Float32Array(newLength);
    let offsetResult = 0;
    let offsetBuffer = 0;

    while (offsetResult < result.length) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
      let accum = 0;
      let count = 0;
      for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
        accum += buffer[i];
        count++;
      }
      result[offsetResult] = count > 0 ? accum / count : 0;
      offsetResult++;
      offsetBuffer = nextOffsetBuffer;
    }
    return result;
  }

  floatTo16BitPCMBase64(float32Array) {
    const buffer = new ArrayBuffer(float32Array.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < float32Array.length; i++) {
      let s = Math.max(-1, Math.min(1, float32Array[i]));
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true); // Little endian
    }
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  /**
   * Play base64-encoded PCM audio from Gemini Live (24kHz standard).
   * Pass isNewTurn=true for the first chunk of a fresh AI turn (e.g. right
   * after a turnComplete / a brand new question) so it gets held back by
   * `turnPauseSeconds` from when the previous turn's audio actually finishes,
   * instead of butting up against it with zero gap.
   */
  queueAudioChunk(base64Audio, sampleRate = 24000, isNewTurn = false) {
    this.ensureOutputContext();

    if (this.playbackFinishTimer) {
      clearTimeout(this.playbackFinishTimer);
      this.playbackFinishTimer = null;
    }

    try {
      const binaryString = window.atob(base64Audio);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      // 16-bit PCM little-endian to Float32
      const dataView = new DataView(bytes.buffer);
      const numSamples = Math.floor(len / 2);
      if (numSamples <= 0) return;

      const float32Samples = new Float32Array(numSamples);
      for (let i = 0; i < numSamples; i++) {
        const int16 = dataView.getInt16(i * 2, true);
        float32Samples[i] = int16 / 32768.0;
      }

      // Create buffer at Gemini's native 24000Hz sample rate.
      // Web Audio will automatically and cleanly resample it to the system output rate.
      const audioBuffer = this.outputAudioContext.createBuffer(1, numSamples, sampleRate);
      audioBuffer.getChannelData(0).set(float32Samples);

      const source = this.outputAudioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.outputAnalyser);

      const currentTime = this.outputAudioContext.currentTime;
      // Only catch up if we've fallen BEHIND real time. Gemini streams audio
      // faster than real time, so the queue legitimately runs many seconds
      // ahead; resetting to "now" when it's far ahead (the old `> +3.0s`
      // check) started new chunks on top of audio still playing — the same
      // voice overlapping itself.
      if (this.nextPlayTime < currentTime) {
        this.nextPlayTime = currentTime;
      }
      if (isNewTurn && this.lastTurnEndTime > 0) {
        // Enforce a minimum silence gap after the previous turn's audio
        // actually finishes, so a new turn never plays back-to-back or
        // overlapping with the one before it.
        const earliestNewTurnStart = this.lastTurnEndTime + this.turnPauseSeconds;
        if (earliestNewTurnStart > this.nextPlayTime) {
          this.nextPlayTime = earliestNewTurnStart;
        }
      }
      const startTime = this.nextPlayTime;
      source.start(startTime);

      const wasPlaying = this.isPlayingAi;
      this.nextPlayTime = startTime + audioBuffer.duration;
      this.scheduledSources.push(source);
      this.isPlayingAi = true;

      if (!wasPlaying) {
        this.onPlaybackStarted();
      }

      // Track AI volume for visualizer
      this.monitorAiVolume();

      source.onended = () => {
        const idx = this.scheduledSources.indexOf(source);
        if (idx !== -1) {
          this.scheduledSources.splice(idx, 1);
        }
        if (this.scheduledSources.length === 0) {
          if (this.playbackFinishTimer) {
            clearTimeout(this.playbackFinishTimer);
          }
          // Debounce by 450ms to ensure no subsequent stream chunks arrive and room echo settles
          this.playbackFinishTimer = setTimeout(() => {
            this.playbackFinishTimer = null;
            if (this.scheduledSources.length === 0) {
              this.isPlayingAi = false;
              this.onAiVolume(0);
              this.onPlaybackFinished();
            }
          }, 450);
        }
      };
    } catch (err) {
      console.error('[AudioStreamManager] Error queuing audio chunk:', err);
    }
  }

  monitorAiVolume() {
    if (!this.outputAnalyser || !this.isPlayingAi) return;
    const dataArray = new Uint8Array(this.outputAnalyser.frequencyBinCount);
    const check = () => {
      if (!this.isPlayingAi || this.scheduledSources.length === 0) {
        this.onAiVolume(0);
        return;
      }
      this.outputAnalyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
      }
      const avg = sum / (dataArray.length * 255);
      this.onAiVolume(avg);
      requestAnimationFrame(check);
    };
    check();
  }

  /**
   * Call once a turn's server-side turnComplete signal arrives, so the NEXT
   * turn's first chunk (isNewTurn=true) knows the earliest moment it's
   * allowed to start (this turn's scheduled end + turnPauseSeconds).
   */
  markTurnComplete() {
    this.lastTurnEndTime = this.outputAudioContext
      ? Math.max(this.nextPlayTime, this.outputAudioContext.currentTime)
      : this.nextPlayTime;
  }

  stopAllPlayback() {
    if (this.playbackFinishTimer) {
      clearTimeout(this.playbackFinishTimer);
      this.playbackFinishTimer = null;
    }
    for (const source of this.scheduledSources) {
      try {
        source.stop(0);
        source.disconnect();
      } catch (e) {
        // ignore already stopped sources
      }
    }
    this.scheduledSources = [];
    if (this.outputAudioContext) {
      this.nextPlayTime = this.outputAudioContext.currentTime;
      // Whatever interrupted this turn (barge-in, end, etc.), the next turn
      // should still wait out the pause from this moment rather than
      // resuming immediately.
      this.lastTurnEndTime = this.outputAudioContext.currentTime;
    }
    this.isPlayingAi = false;
    this.onAiVolume(0);
    if ('speechSynthesis' in window) {
      try { window.speechSynthesis.cancel(); } catch (e) {}
    }
  }

  /**
   * Barge-in interruption: Immediately silence and abort all playing AI audio
   */
  handleBargeIn() {
    console.log('[AudioStreamManager] Barge-in triggered! Halting AI playback.');
    this.stopAllPlayback();
    this.onBargeIn();
  }

  toggleMute() {
    this.isMuted = !this.isMuted;
    return this.isMuted;
  }

  stop() {
    this.isRecording = false;
    // Plain teardown — must NOT go through handleBargeIn()/onBargeIn(): that
    // callback re-enters app-level state (toast, transitionState) which was
    // calling right back into this manager, causing unbounded recursion and
    // a stack-overflow crash every time a session was torn down while an
    // AudioStreamManager still existed (e.g. "Start New Rehearsal Session").
    this.stopAllPlayback();

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }
    if (this.processorNode) {
      this.processorNode.disconnect();
      this.processorNode = null;
    }
    if (this.muteGain) {
      this.muteGain.disconnect();
      this.muteGain = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.inputAudioContext) {
      this.inputAudioContext.close().catch(() => {});
      this.inputAudioContext = null;
    }
    if (this.outputAudioContext) {
      this.outputAudioContext.close().catch(() => {});
      this.outputAudioContext = null;
    }
  }
}

if (typeof window !== 'undefined') {
  window.AudioStreamManager = AudioStreamManager;
}
