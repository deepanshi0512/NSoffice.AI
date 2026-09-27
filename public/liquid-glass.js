/**
 * NSOffice Liquid Glass Engine
 * Interactive Glassmorphism, Specular Reflections & Audio-Reactive Fluid Mechanics
 * AI Centre of Excellence - NSOFFICE.AI
 */

class LiquidGlassEngine {
  constructor() {
    this.mouse = { x: 0, y: 0, targetX: 0, targetY: 0 };
    this.elements = [];
    this.audioLevel = 0;
    this.smoothedAudioLevel = 0;
    this.isBargeInActive = false;
    this.rafId = null;

    this.init();
  }

  init() {
    if (typeof window === 'undefined') return;

    this.bindEvents();
    this.scanElements();
    this.startRenderLoop();
  }

  scanElements() {
    this.elements = Array.from(document.querySelectorAll('.liquid-glass, .glass-panel, .glass-card, .glass-button, .voice-orb-container'));
  }

  bindEvents() {
    window.addEventListener('mousemove', (e) => {
      this.mouse.targetX = e.clientX;
      this.mouse.targetY = e.clientY;
    }, { passive: true });

    // Handle dynamic DOM additions
    const observer = new MutationObserver(() => this.scanElements());
    observer.observe(document.body, { childList: true, subtree: true });
  }

  startRenderLoop() {
    const render = () => {
      // Smooth mouse lerp
      this.mouse.x += (this.mouse.targetX - this.mouse.x) * 0.12;
      this.mouse.y += (this.mouse.targetY - this.mouse.y) * 0.12;

      // Smooth audio level lerp
      this.smoothedAudioLevel += (this.audioLevel - this.smoothedAudioLevel) * 0.15;

      // Update specular highlights on all glass panels
      const count = this.elements.length;
      for (let i = 0; i < count; i++) {
        const el = this.elements[i];
        if (!el || !el.isConnected) continue;

        const rect = el.getBoundingClientRect();
        // Check if on screen
        if (
          rect.bottom < 0 ||
          rect.top > window.innerHeight ||
          rect.right < 0 ||
          rect.left > window.innerWidth
        ) continue;

        const localX = this.mouse.x - rect.left;
        const localY = this.mouse.y - rect.top;

        el.style.setProperty('--mouse-x', `${localX.toFixed(1)}px`);
        el.style.setProperty('--mouse-y', `${localY.toFixed(1)}px`);
        el.style.setProperty('--mouse-percent-x', `${(localX / rect.width * 100).toFixed(1)}%`);
        el.style.setProperty('--mouse-percent-y', `${(localY / rect.height * 100).toFixed(1)}%`);
        el.style.setProperty('--audio-energy', `${this.smoothedAudioLevel.toFixed(3)}`);
      }

      this.rafId = requestAnimationFrame(render);
    };

    this.rafId = requestAnimationFrame(render);
  }

  /**
   * Feed normalized audio energy (0.0 to 1.0) into the liquid glass visualizer
   */
  setAudioLevel(level) {
    this.audioLevel = Math.max(0, Math.min(1, level));
  }

  /**
   * Flash an electric blue refraction wave across all glass panels when barge-in occurs
   */
  triggerBargeInPulse() {
    document.body.classList.add('barge-in-pulse');
    setTimeout(() => {
      document.body.classList.remove('barge-in-pulse');
    }, 600);
  }
}

// Global singleton instance
const LiquidGlass = new LiquidGlassEngine();
if (typeof window !== 'undefined') {
  window.LiquidGlass = LiquidGlass;
}
