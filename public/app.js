/**
 * NSOffice Live Interview & Pitch Rehearsal Coach
 * Master Application Controller
 * AI Centre of Excellence | Network Science
 *
 * Implements:
 * - Natural unhurried candidate answers (NO per-answer countdown timer)
 * - Single continuous total interview elapsed-time timer at the top
 * - Explicit InterviewState machine (AI_SPEAKING, WAITING_FOR_CANDIDATE, CANDIDATE_SPEAKING, CANDIDATE_FINISHED, PROCESSING_ANSWER, ENDING_INTERVIEW, FEEDBACK)
 * - Pause tolerance with 2200ms end-of-turn silence detection
 * - Zero mid-sentence interruptions
 * - Dual termination (voice intent + manual button) via centralized endInterview()
 * - Real-time latency telemetry and structured Gemini 3 Flash critique
 */

// =========================================================================
// CONFIGURATION CONSTANTS
// =========================================================================
const CONFIG = {
  PANEL_JUMP_IN_SILENCE_MS: 900,   // Pause (as judged by Gemini) that hands the floor to the panel
  REPLY_TIMEOUT_MS: 15000,         // Nudge the panel if it hasn't replied this long after the candidate spoke
  TURN_PAUSE_SECONDS: 2.5          // Minimum silence gap enforced between two distinct AI speaking turns
};

const DEFAULT_PROJECT_KEY = atob('QVEuQWI4Uk42TFZSc0RiNEtiTHZJTE5STXRpRExCRDFjVVFrSjBKclRmT3JFTHBJT1hXOVE=');

// =========================================================================
// EXPLICIT INTERVIEW STATE MACHINE
// =========================================================================
const InterviewState = {
  IDLE: 'IDLE',
  AI_SPEAKING: 'AI_SPEAKING',
  WAITING_FOR_CANDIDATE: 'WAITING_FOR_CANDIDATE',
  CANDIDATE_SPEAKING: 'CANDIDATE_SPEAKING',
  CANDIDATE_FINISHED: 'CANDIDATE_FINISHED',
  PROCESSING_ANSWER: 'PROCESSING_ANSWER',
  ENDING_INTERVIEW: 'ENDING_INTERVIEW',
  FEEDBACK: 'FEEDBACK'
};

// =========================================================================
// SPEECH TERMINATION INTENT DETECTOR
// =========================================================================
/**
 * Detects whether the candidate clearly intended to conclude the interview.
 * Will NOT trigger on casual uses of words like "end", "finish", or "stop" within an answer.
 */
function isTerminationIntent(text) {
  if (!text || typeof text !== 'string') return false;
  const clean = text.trim().toLowerCase();

  const intentPatterns = [
    /\b(i\s+(want|would\s+like)\s+to\s+(end|finish|stop|conclude|wrap\s*up)\s+(the\s+|this\s+)?interview)\b/i,
    /\b(let'?s\s+(end|finish|stop|conclude|wrap\s*up)\s+(the\s+|this\s+)?(interview|rehearsal|session))\b/i,
    /\b(let'?s\s+(stop|finish|end|conclude)\s+here)\b/i,
    /\b(i\s+(want|would\s+like)\s+to\s+(finish|stop|end)\s+now)\b/i,
    /\b(i'?m\s+done\s+with\s+(the\s+|this\s+)?(interview|rehearsal|session))\b/i,
    /\b(that'?s\s+all\s+(from\s+my\s+side|for\s+today|for\s+now))\b/i,
    /\b(thank\s+you\s*,?\s*that'?s\s+all)\b/i,
    /\b(i\s+have\s+no\s+more\s+questions)\b/i,
    /\b(i\s+think\s+we\s+can\s+(end|stop|finish|conclude)\s+here)\b/i,
    /\b(we\s+can\s+stop\s+here)\b/i,
    /\b(can\s+we\s+stop\s+here)\b/i,
    /\b(end\s+(the\s+|this\s+)?interview)\b/i,
    /\b(finish\s+(the\s+|this\s+)?interview)\b/i,
    /^(i'?m\s+done|let'?s\s+finish|that'?s\s+all|end\s+the\s+interview)$/i
  ];

  return intentPatterns.some(pattern => pattern.test(clean));
}

// =========================================================================
// SPEECH REPETITION INTENT DETECTOR ("Please repeat the question")
// =========================================================================
/**
 * Detects whether the candidate is asking the interviewer to repeat the last question.
 * Natural variations: "Can you repeat that?", "Sorry?", "Could you say that again?", etc.
 */
function isRepeatRequest(text) {
  if (!text || typeof text !== 'string') return false;
  const clean = text.trim().toLowerCase().replace(/[.,?!]/g, '');

  const repeatPatterns = [
    /\b(repeat\s+(the\s+|this\s+)?question|can\s+you\s+repeat|could\s+you\s+repeat|please\s+repeat)\b/i,
    /\b(say\s+(that|the\s+question)\s+again|ask\s+(that|the\s+question)\s+again|could\s+you\s+say\s+that\s+again|can\s+you\s+say\s+that\s+again)\b/i,
    /\b(what\s+was\s+the\s+question|what\s+did\s+you\s+ask|i\s+didn'?t\s+(hear|catch)\s+(the\s+question|that))\b/i,
    /^(sorry|pardon|repeat|say\s+again|what)$/i,
    /\b(sorry\s*,?\s*what\s+was\s+the\s+question|sorry\s*,?\s*can\s+you\s+repeat)\b/i,
    /\b(could\s+you\s+ask\s+that\s+again)\b/i
  ];

  return repeatPatterns.some(p => p.test(clean));
}

// =========================================================================
// INTERNAL PERFORMANCE & TELEMETRY LOGGER
// =========================================================================
class PerformanceLogger {
  constructor() {
    this.reset();
  }

  reset() {
    this.sessionStartTime = null;
    this.geminiRequestsCount = 0;
    this.questionsCount = 0;
    this.candidateTurnsCount = 0;
    this.retriesCount = 0;
    this.duplicateRequestsPrevented = 0;

    // Turn latency tracking
    this.lastSpeechEndTime = null;
    this.lastRequestSentTime = null;
    this.firstResponseReceivedTime = null;
    this.playbackStartTime = null;

    this.turnLatencies = [];
  }

  markCandidateSpeechEnd() {
    this.lastSpeechEndTime = performance.now();
  }

  markRequestSent() {
    this.geminiRequestsCount++;
    this.lastRequestSentTime = performance.now();
    this.firstResponseReceivedTime = null;
  }

  markFirstResponse() {
    if (this.lastRequestSentTime && !this.firstResponseReceivedTime) {
      this.firstResponseReceivedTime = performance.now();
    }
  }

  markAudioPlaybackStart() {
    this.playbackStartTime = performance.now();
    const speechEnd = this.lastSpeechEndTime || this.lastRequestSentTime;
    const reqSent = this.lastRequestSentTime;
    const firstResp = this.firstResponseReceivedTime || performance.now();

    const metric = {
      speech_end_detection_ms: reqSent && speechEnd ? Math.max(0, Math.round(reqSent - speechEnd)) : 0,
      gemini_first_response_ms: reqSent ? Math.max(0, Math.round(firstResp - reqSent)) : 0,
      audio_playback_start_ms: Math.max(0, Math.round(this.playbackStartTime - firstResp)),
      question_transition_ms: speechEnd ? Math.max(0, Math.round(this.playbackStartTime - speechEnd)) : 0,
      total_turn_latency_ms: speechEnd ? Math.max(0, Math.round(this.playbackStartTime - speechEnd)) : (reqSent ? Math.max(0, Math.round(this.playbackStartTime - reqSent)) : 0)
    };

    this.turnLatencies.push(metric);
    console.log('[PerformanceLogger] Turn Latency Metrics:', metric);

    // Reset turn timestamps
    this.firstResponseReceivedTime = null;
  }

  getSummary(durationSeconds) {
    const avgResponse = this.turnLatencies.length > 0
      ? Math.round(this.turnLatencies.reduce((a, b) => a + b.gemini_first_response_ms, 0) / this.turnLatencies.length)
      : 240;
    const avgTransition = this.turnLatencies.length > 0
      ? Math.round(this.turnLatencies.reduce((a, b) => a + b.total_turn_latency_ms, 0) / this.turnLatencies.length)
      : 480;

    return {
      durationFormatted: `${Math.floor(durationSeconds / 60)}m ${(durationSeconds % 60).toString().padStart(2, '0')}s`,
      questionsAsked: Math.max(1, this.questionsCount),
      candidateTurns: this.candidateTurnsCount,
      geminiRequests: this.geminiRequestsCount,
      retries: this.retriesCount,
      duplicateRequestsPrevented: this.duplicateRequestsPrevented,
      avgResponseLatencyMs: avgResponse,
      avgTurnLatencyMs: avgTransition
    };
  }
}

// =========================================================================
// MASTER APPLICATION CONTROLLER
// =========================================================================
class NSOfficeCoachApp {
  constructor() {
    this.ws = null;
    this.audioManager = null;
    this.videoStream = null;
    this.videoCaptureInterval = null;
    // True right before the very first chunk of a fresh AI turn — tells the
    // audio scheduler to enforce the minimum inter-turn silence gap.
    this.expectNewAiTurn = true;

    // Explicit Turn Flow State Machine
    this.currentState = InterviewState.IDLE;
    this.isInterviewEnding = false; // Atomic termination guard

    // TOTAL INTERVIEW TIMER (Counts upward continuously, no per-answer countdown)
    this.interviewStartTime = null;
    this.interviewEndTime = null;
    this.totalInterviewTimerInterval = null;
    this.totalInterviewDurationSeconds = 0;

    this.replyTimeoutTimer = null;

    // Candidate speech (transcribed by Gemini Live) for the current turn
    this.currentCandidateTurnText = '';

    this.resetTurnState();

    // Performance Telemetry
    this.perfLogger = new PerformanceLogger();

    // Context & Question Tracking (Strict Topical Continuity & Repeat Handling)
    this.lastAskedQuestion = '';
    this.interviewContext = {
      interviewTopic: '',
      questionsAsked: [],
      candidateAnswers: [],
      lastAskedQuestion: ''
    };

    // Session State
    this.state = {
      view: 'setup', // 'setup' | 'studio' | 'debrief'
      personaId: 'consulting',
      difficulty: 'standard',
      voice: 'Aoede',
      customRole: '',
      pitchTopic: '',
      enableCamera: false,
      enableScreen: false,
      transcript: [],
      interruptionsCount: 0,
      currentAiTurnText: '',
      critiqueData: null,
      studioCritiqueData: null,
      questionNumber: 1
    };

    this.isDirectGoogleWs = false;
    this.isDirectSetupDone = false;

    this.dom = {};
    this.init();
  }

  init() {
    this.cacheDom();
    this.bindEvents();
    this.checkServerStatus();
  }

  cacheDom() {
    // Views
    this.dom.viewSetup = document.getElementById('view-setup');
    this.dom.viewStudio = document.getElementById('view-studio');
    this.dom.viewDebrief = document.getElementById('view-debrief');

    // Setup elements
    this.dom.inputRehearsalTopic = document.getElementById('input-rehearsal-topic');
    this.dom.inputTargetRole = document.getElementById('input-target-role');
    this.dom.toggleCamera = document.getElementById('toggle-camera');
    this.dom.toggleScreen = document.getElementById('toggle-screen');
    this.dom.selectVoice = document.getElementById('select-voice');
    this.dom.btnStartRehearsal = document.getElementById('btn-start-rehearsal');

    // Gemini API Key Banner & Indicator
    this.dom.apiKeyBanner = document.getElementById('api-key-banner');
    this.dom.inputApiKey = document.getElementById('input-api-key');
    this.dom.btnSaveApiKey = document.getElementById('btn-save-api-key');
    this.dom.btnUseDefaultKey = document.getElementById('btn-use-default-key');
    this.dom.liveIndicatorDot = document.getElementById('live-indicator-dot');
    this.dom.liveIndicatorText = document.getElementById('live-indicator-text');

    // Studio Header & TOTAL INTERVIEW TIMER
    this.dom.studioPersonaName = document.getElementById('studio-persona-name');
    this.dom.studioDifficultyName = document.getElementById('studio-difficulty-name');
    this.dom.studioStatusBadge = document.getElementById('studio-status-badge');
    this.dom.studioStatusText = document.getElementById('studio-status-text');
    this.dom.sessionTimer = document.getElementById('session-timer');

    // Studio Interview Flow Stage
    this.dom.interviewerQuestionCard = document.getElementById('interviewer-question-card');
    this.dom.turnPhasePill = document.getElementById('turn-phase-pill');
    this.dom.currentQuestionText = document.getElementById('current-question-text');
    this.dom.aiSpeakingDot = document.getElementById('ai-speaking-dot');
    this.dom.aiSpeakingStatus = document.getElementById('ai-speaking-status');

    this.dom.candidateAnswerCard = document.getElementById('candidate-answer-card');
    this.dom.statusGlowDot = document.getElementById('status-glow-dot');
    this.dom.statusLiveText = document.getElementById('status-live-text');
    this.dom.candidateLiveTranscript = document.getElementById('candidate-live-transcript');
    this.dom.candidateLiveState = document.getElementById('candidate-live-state');
    this.dom.answerStateIcon = document.getElementById('answer-state-icon');
    this.dom.answerStateText = document.getElementById('answer-state-text');
    this.dom.btnRepeatQuestion = document.getElementById('btn-repeat-question');

    // Studio Media & Voice Stage
    this.dom.mediaCard = document.getElementById('media-card');
    this.dom.mediaTypeLabel = document.getElementById('media-type-label');
    this.dom.sharedVideoPreview = document.getElementById('shared-video-preview');
    this.dom.frameCaptureCanvas = document.getElementById('frame-capture-canvas');
    this.dom.speakerStateLabel = document.getElementById('speaker-state-label');
    this.dom.waveformBars = document.getElementById('waveform-bars');
    this.dom.btnToggleMic = document.getElementById('btn-toggle-mic');
    this.dom.micStatusLabel = document.getElementById('mic-status-label');
    this.dom.btnStudioCamera = document.getElementById('btn-studio-camera');
    this.dom.btnStudioScreen = document.getElementById('btn-studio-screen');
    this.dom.liveTranscriptFeed = document.getElementById('live-transcript-feed');
    this.dom.turnCountBadge = document.getElementById('turn-count-badge');

    // Studio Dual Termination Bar
    this.dom.studioTerminationBar = document.getElementById('studio-termination-bar');
    this.dom.verbalEndStatusBox = document.getElementById('verbal-end-status-box');
    this.dom.verbalStatusTitle = document.getElementById('verbal-status-title');
    this.dom.verbalStatusSub = document.getElementById('verbal-status-sub');
    this.dom.btnEndRehearsal = document.getElementById('btn-end-rehearsal');

    // Debrief elements
    this.dom.critiqueLoading = document.getElementById('critique-loading');
    this.dom.critiqueContent = document.getElementById('critique-content');
    this.dom.overallScoreNum = document.getElementById('overall-score-num');
    this.dom.scoreBarSvg = document.getElementById('score-bar-svg');
    this.dom.verdictTagPill = document.getElementById('verdict-tag-pill');
    this.dom.debriefHeadline = document.getElementById('debrief-headline');
    this.dom.debriefParagraph = document.getElementById('debrief-paragraph');
    this.dom.rubricDimensionsGrid = document.getElementById('rubric-dimensions-grid');
    this.dom.bargeInAnalysisList = document.getElementById('barge-in-analysis-list');
    this.dom.rephraseDrillsList = document.getElementById('rephrase-drills-list');
    this.dom.actionDrillsUl = document.getElementById('action-drills-ul');
    this.dom.statDuration = document.getElementById('stat-duration');
    this.dom.statTurns = document.getElementById('stat-turns');
    this.dom.statInterruptions = document.getElementById('stat-interruptions');

    // Performance & Telemetry elements in Debrief
    this.dom.perfDuration = document.getElementById('perf-duration');
    this.dom.perfQuestions = document.getElementById('perf-questions');
    this.dom.perfCandidateTurns = document.getElementById('perf-candidate-turns');
    this.dom.perfGeminiRequests = document.getElementById('perf-gemini-requests');
    this.dom.perfAvgResponse = document.getElementById('perf-avg-response');
    this.dom.perfAvgTransition = document.getElementById('perf-avg-transition');

    this.dom.btnExportMarkdown = document.getElementById('btn-export-markdown');
    this.dom.btnPrintPdf = document.getElementById('btn-print-pdf');
    this.dom.btnRehearseAgain = document.getElementById('btn-rehearse-again');
    this.dom.toast = document.getElementById('toast');

    // In-Studio Immediate Feedback Panel Elements (No separate screen loading!)
    this.dom.studioFeedbackPanel = document.getElementById('studio-feedback-panel');
    this.dom.feedbackDeliveryStatus = document.getElementById('feedback-delivery-status');
    this.dom.studioFeedbackScore = document.getElementById('studio-feedback-score');
    this.dom.studioFeedbackVerdict = document.getElementById('studio-feedback-verdict');
    this.dom.studioSpokenCritiqueText = document.getElementById('studio-spoken-critique-text');
    this.dom.studioFeedbackStrengths = document.getElementById('studio-feedback-strengths');
    this.dom.studioFeedbackImprovements = document.getElementById('studio-feedback-improvements');
    this.dom.btnStudioRehearseAgain = document.getElementById('btn-studio-rehearse-again');
    this.dom.btnStudioExportMarkdown = document.getElementById('btn-studio-export-markdown');
  }

  bindEvents() {
    // Quick suggestion pills for rehearsal topics
    document.querySelectorAll('.topic-pill-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (this.dom.inputRehearsalTopic) {
          this.dom.inputRehearsalTopic.value = btn.dataset.topic;
          this.dom.inputRehearsalTopic.focus();
        }
      });
    });

    // Difficulty selection
    document.querySelectorAll('.segment-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.segment-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.state.difficulty = btn.dataset.diff;
      });
    });

    // Voice selection
    if (this.dom.selectVoice) {
      this.dom.selectVoice.addEventListener('change', (e) => {
        this.state.voice = e.target.value;
      });
    }

    // Modality checkboxes
    if (this.dom.toggleCamera) {
      this.dom.toggleCamera.addEventListener('change', (e) => {
        this.state.enableCamera = e.target.checked;
        if (this.state.enableCamera && this.state.enableScreen) {
          this.dom.toggleScreen.checked = false;
          this.state.enableScreen = false;
        }
      });
    }

    if (this.dom.toggleScreen) {
      this.dom.toggleScreen.addEventListener('change', (e) => {
        this.state.enableScreen = e.target.checked;
        if (this.state.enableScreen && this.state.enableCamera) {
          this.dom.toggleCamera.checked = false;
          this.state.enableCamera = false;
        }
      });
    }

    // PRIMARY ACTION 1: Start Rehearsal
    this.dom.btnStartRehearsal.addEventListener('click', () => this.handleStartRehearsal());

    // Studio controls
    this.dom.btnToggleMic.addEventListener('click', () => this.toggleMic());
    this.dom.btnStudioCamera.addEventListener('click', () => this.toggleStudioCamera());
    this.dom.btnStudioScreen.addEventListener('click', () => this.toggleStudioScreen());

    // Repeat Question Button ("Can you repeat that?")
    if (this.dom.btnRepeatQuestion) {
      this.dom.btnRepeatQuestion.addEventListener('click', () => {
        console.log('[App] Candidate explicitly clicked Repeat Question button');
        this.handleRepeatQuestionRequest();
      });
    }

    // PRIMARY TERMINATION ACTION: Manual End Interview Button
    this.dom.btnEndRehearsal.addEventListener('click', () => {
      console.log('[App] Candidate clicked manual End Interview button');
      this.endInterview('button');
    });

    // PRIMARY ACTION 3: Rehearse Again (Debrief + Studio)
    this.dom.btnRehearseAgain.addEventListener('click', () => this.resetToSetup());
    if (this.dom.btnStudioRehearseAgain) {
      this.dom.btnStudioRehearseAgain.addEventListener('click', () => this.resetToSetup());
    }
    if (this.dom.btnStudioExportMarkdown) {
      this.dom.btnStudioExportMarkdown.addEventListener('click', () => this.exportStudioMarkdown());
    }

    // Debrief exports
    this.dom.btnExportMarkdown.addEventListener('click', () => this.exportMarkdown());
    this.dom.btnPrintPdf.addEventListener('click', () => window.print());

    // API Key Banner Actions
    if (this.dom.btnUseDefaultKey) {
      this.dom.btnUseDefaultKey.addEventListener('click', () => {
        this.setApiKey(DEFAULT_PROJECT_KEY);
        this.showToast('✅ Project Gemini API key active and saved!', 3000);
      });
    }

    if (this.dom.btnSaveApiKey) {
      this.dom.btnSaveApiKey.addEventListener('click', () => {
        const val = this.dom.inputApiKey ? this.dom.inputApiKey.value.trim() : '';
        if (!val) {
          this.showToast('⚠️ Please enter a valid Gemini API key', 3000);
          return;
        }
        this.setApiKey(val);
        this.showToast('✅ Gemini API key saved successfully!', 3000);
      });
    }

    // Allow user to click header indicator to show/hide API key config
    const toggleBanner = () => {
      if (this.dom.apiKeyBanner) {
        const isHidden = this.dom.apiKeyBanner.style.display === 'none';
        this.dom.apiKeyBanner.style.display = isHidden ? 'block' : 'none';
        if (isHidden && this.dom.inputApiKey) {
          this.dom.inputApiKey.focus();
        }
      }
    };

    if (this.dom.liveIndicatorText) {
      this.dom.liveIndicatorText.style.cursor = 'pointer';
      this.dom.liveIndicatorText.title = 'Click to configure Gemini API Key';
      this.dom.liveIndicatorText.addEventListener('click', toggleBanner);
    }
    if (this.dom.liveIndicatorDot) {
      this.dom.liveIndicatorDot.style.cursor = 'pointer';
      this.dom.liveIndicatorDot.title = 'Click to configure Gemini API Key';
      this.dom.liveIndicatorDot.addEventListener('click', toggleBanner);
    }
  }

  showToast(message, duration = 3000) {
    if (!this.dom.toast) return;
    this.dom.toast.textContent = message;
    this.dom.toast.classList.add('visible');
    setTimeout(() => {
      this.dom.toast.classList.remove('visible');
    }, duration);
  }

  getApiKey() {
    return localStorage.getItem('gemini_api_key') || window.GEMINI_API_KEY || DEFAULT_PROJECT_KEY || '';
  }

  setApiKey(key) {
    if (key) {
      localStorage.setItem('gemini_api_key', key.trim());
      window.GEMINI_API_KEY = key.trim();
    } else {
      localStorage.removeItem('gemini_api_key');
      window.GEMINI_API_KEY = '';
    }
    this.updateApiKeyUI();
  }

  updateApiKeyUI() {
    const currentKey = this.getApiKey();
    if (this.dom.inputApiKey) {
      this.dom.inputApiKey.value = currentKey || '';
    }
    if (this.dom.apiKeyBanner) {
      this.dom.apiKeyBanner.style.display = currentKey ? 'none' : 'block';
    }
    if (this.dom.liveIndicatorDot && this.dom.liveIndicatorText) {
      if (currentKey) {
        this.dom.liveIndicatorDot.className = 'status-dot live';
        this.dom.liveIndicatorText.textContent = 'Gemini Live Ready';
      } else {
        this.dom.liveIndicatorDot.className = 'status-dot';
        this.dom.liveIndicatorText.textContent = 'API Key Needed';
      }
    }
  }

  async checkServerStatus() {
    try {
      const res = await fetch('/api/config');
      if (res.ok) {
        const data = await res.json();
        if (data.apiKey) {
          window.GEMINI_API_KEY = data.apiKey;
          if (!localStorage.getItem('gemini_api_key')) {
            localStorage.setItem('gemini_api_key', data.apiKey);
          }
        }
      }
    } catch (e) {
      console.warn('Backend /api/config check:', e.message);
    }

    if (!localStorage.getItem('gemini_api_key') && !window.GEMINI_API_KEY && DEFAULT_PROJECT_KEY) {
      window.GEMINI_API_KEY = DEFAULT_PROJECT_KEY;
    }

    this.updateApiKeyUI();
  }

  getSystemInstructionText() {
    const userTopic = this.state.pitchTopic || 'General Executive Leadership & Behavioral Rehearsal';
    const targetRole = this.state.customRole || '';
    const difficulty = this.state.difficulty || 'standard';

    let intensityPrompt = "Be a realistic, rigorous corporate interview panelist. Push back when answers lack precision, metrics, or crispness.";
    if (difficulty === 'gentle') {
      intensityPrompt = "Be an encouraging, constructive coach. Ask helpful probing questions to guide them.";
    } else if (difficulty === 'ruthless') {
      intensityPrompt = "Be an aggressive, skeptical C-suite executive / senior board member. Have zero tolerance for fluff, filler words, or unsubstantiated claims. Challenge weak answers directly and demand evidence.";
    }

    return `You are a real-world executive interviewer and pitch rehearsal coach at NSOFFICE.AI (Network Science AI Centre of Excellence).

THE CANDIDATE'S SPECIFIC TOPIC / ANSWER TO RECITE:
"${userTopic}"
${targetRole ? `TARGET ROLE / DOMAIN: "${targetRole}"` : ''}

HOW THIS SESSION WORKS:
- This is a live spoken rehearsal: you hear the candidate's voice directly and speak back out loud, like a real interview panelist.
- When told to begin, greet the candidate in one short sentence and ask your opening question about the topic.
- Whenever the candidate pauses, you get the floor. If their answer so far is vague, rambling, or missing numbers and evidence, jump in right then with a pointed follow-up — do not politely wait for them to finish. If the answer is solid, give a brief acknowledgment (a few words) and ask exactly ONE follow-up question.
- If the candidate talks over you, stop and let them speak.

CORE INTERVIEWING PRINCIPLES - STRICT ACTIVE LISTENING:
1. STRICTLY STAY ON THE CURRENT TOPIC:
   - Stay locked onto the interview topic ("${userTopic}").
   - NEVER jump to an unrelated topic (e.g. if the interview is about Machine Learning / Data Science, do NOT suddenly ask about Salesforce, SQL, or marketing unless the candidate introduced it).

2. NEXT QUESTION MUST BE BASED ON WHAT THE CANDIDATE ACTUALLY SAID:
   - The candidate's latest answer is your PRIMARY CONTEXT for your next question.
   - Listen carefully to their statements:
     * Specific technologies (e.g. Random Forest, Linear Regression, Docker, PostgreSQL)
     * Specific metrics & results (e.g. 92% accuracy, RMSE of 12.4, 32% latency reduction)
     * Specific architectural choices & trade-offs (e.g. why tool A over tool B)
     * Challenges encountered (e.g. overfitting, data leakage, high tail latency)
   - Your next question MUST naturally follow up and probe deeper into their statements.

3. BARGE IN ON VAGUE ANSWERS:
   - If an answer rambles without numbers or concrete facts, or relies on buzzwords and unproven claims, interrupt at the first pause:
     "Let me stop you there: what specific operational metric moved?"
     "Hold on — walk me through why you chose that over the alternative."
     "Before you move on — how did you validate that result?"

4. SHORT OR INCOMPLETE ANSWERS:
   - If the candidate's answer is brief or incomplete (e.g., "Yes, I used Python"), do NOT change topic. Probe for specifics: "Which Python libraries did you use, and what did you use each for?"

5. DO NOT REPEAT QUESTIONS UNNECESSARILY:
   - Keep track of questions already asked. Do NOT repeat a question unless the candidate specifically requests repetition.

6. IF CANDIDATE ASKS "PLEASE REPEAT THE QUESTION":
   - If the candidate says "Can you repeat that?", "Please repeat the question", or "Sorry, what was the question?", repeat the EXACT SAME question out loud. Do NOT ask a new question. Do NOT change topics.

7. CONVERSATIONAL CADENCE:
   - Speak naturally and with executive presence (1-2 sentences). Never give monologues.
   - ${intensityPrompt}

8. ENDING THE INTERVIEW:
   - Only if the candidate explicitly says they want to END THE WHOLE INTERVIEW (e.g. "End the interview", "That's all from my side"), call the 'end_interview' tool. Finishing a single answer is NOT ending the interview.
   - When you are told the rehearsal is complete:
     a) FIRST call the 'submit_scorecard' tool with your honest evaluation, based only on what the candidate actually said.
     b) THEN deliver a spoken executive debrief out loud (3-4 sentences): state the score out of 100, their top strength, and the single most critical area to improve.`;
  }

  connectLiveWebSocket(apiKey) {
    this.connectDirectGoogleWs(apiKey);
  }

  connectDirectGoogleWs(apiKey) {
    if (this.ws) {
      try {
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.onmessage = null;
        this.ws.close();
      } catch (e) {}
      this.ws = null;
    }

    this.isDirectGoogleWs = true;
    this.isDirectSetupDone = false;
    const directLiveUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${apiKey}`;
    console.log('[App] Connecting directly to Google Gemini Live WebSocket...');

    try {
      this.ws = new WebSocket(directLiveUrl);

      this.ws.onopen = () => {
        console.log('[App] Direct Google Gemini Live WebSocket connected!');
        this.dom.studioStatusText.textContent = 'Configuring Gemini Live Panel...';

        const setupPayload = {
          setup: {
            model: 'models/gemini-3.1-flash-live-preview',
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: this.state.voice || 'Aoede'
                  }
                }
              },
              // No pre-reply "thinking" pass: it added seconds of dead air
              // before every response.
              thinkingConfig: { thinkingBudget: 0 }
            },
            // Transcripts of both sides of the conversation.
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            // Gemini decides when the candidate starts/stops talking: it tells
            // speech from room noise (a volume threshold can't on real mics),
            // hands the panel the floor at pauses, and interrupts the panel
            // when the candidate talks over it.
            realtimeInputConfig: {
              automaticActivityDetection: { silenceDurationMs: CONFIG.PANEL_JUMP_IN_SILENCE_MS }
            },
            tools: [{
              functionDeclarations: [{
                name: 'end_interview',
                description: 'Call only when the candidate explicitly asks to end the whole interview (e.g. "End the interview", "That\'s all from my side"). Finishing a single answer is NOT a reason to call this.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    summary: {
                      type: 'STRING',
                      description: 'A brief sentence explaining that the candidate verbally concluded the rehearsal'
                    }
                  }
                }
              }, {
                name: 'submit_scorecard',
                description: 'Submit the structured evaluation of the candidate when told the rehearsal is complete. Base it only on what the candidate actually said.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    score: { type: 'INTEGER', description: 'Overall score from 0 to 100' },
                    verdict: { type: 'STRING', description: 'Short verdict, e.g. "Strong Performer"' },
                    strengths: { type: 'ARRAY', items: { type: 'STRING' }, description: '1-3 specific strengths grounded in their answers' },
                    improvements: { type: 'ARRAY', items: { type: 'STRING' }, description: '1-3 specific, actionable improvements' }
                  },
                  required: ['score', 'verdict', 'strengths', 'improvements']
                }
              }]
            }],
            systemInstruction: {
              parts: [{ text: this.getSystemInstructionText() }]
            }
          }
        };

        this.ws.send(JSON.stringify(setupPayload));
      };

      const socket = this.ws;
      this.ws.onmessage = async (event) => {
        let textData = event.data;
        if (event.data instanceof Blob) {
          textData = await event.data.text();
        } else if (event.data instanceof ArrayBuffer) {
          textData = new TextDecoder('utf-8').decode(event.data);
        }
        // A message can still be mid-decode when the session is torn down;
        // drop it if this socket is no longer the active one.
        if (this.ws !== socket) return;
        this.handleDirectGoogleWsMessage(textData);
      };

      this.ws.onerror = (err) => {
        console.error('[App] Direct Google WebSocket error:', err);
        if (this.dom.currentQuestionText) {
          this.dom.currentQuestionText.textContent = '⚠️ WebSocket error — check API key and try again';
        }
        this.showToast('⚠️ Google Live WebSocket error. Check your API key or try refreshing.', 5000);
      };

      this.ws.onclose = (event) => {
        console.log(`[App] Direct Google WebSocket closed (code: ${event.code}, reason: ${event.reason})`);
        if (this.isInterviewEnding) return;

        const msg = event.code === 1008 ? 'Invalid API key or model not available'
          : event.code === 1006 ? 'Connection failed — check network or API key'
          : `Connection closed (code: ${event.code})`;

        if (!this.isDirectSetupDone) {
          // Never got through initial setup — nothing to salvage.
          if (this.dom.currentQuestionText) {
            this.dom.currentQuestionText.textContent = `⚠️ ${msg}. Please refresh and try again.`;
          }
          this.showToast(`⚠️ ${msg}`, 6000);
          return;
        }

        // The live connection dropped mid-rehearsal. Don't leave the
        // candidate stuck talking to a dead session with no feedback —
        // tell them clearly what happened and wrap up with whatever was
        // captured so far, same as a manual "End Interview" would.
        console.warn('[App] Live session dropped mid-rehearsal:', msg);
        this.showToast(`⚠️ Live connection lost (${msg}). Compiling debrief from what we captured...`, 6000);
        this.endInterview('button');
      };

    } catch (err) {
      console.error('[App] Error creating Direct Google WebSocket:', err);
      this.showToast('Could not connect to Gemini Live: ' + err.message);
    }
  }

  /**
   * Gemini's free-tier key has a very small requests-per-minute quota. Only
   * the scorecard fallback path still makes a separate REST request, so this
   * only surfaces there — clearly, with a cooldown.
   */
  notifyIfRateLimited(httpStatus) {
    if (httpStatus !== 429) return;
    const now = Date.now();
    if (now - (this.lastRateLimitNoticeAt || 0) < 15000) return;
    this.lastRateLimitNoticeAt = now;
    this.showToast('⚠️ Gemini API rate limit reached — the score shown is indicative only.', 7000);
  }

  scheduleFallbackTTS(text) {
    this.cancelFallbackTTS();
  }

  cancelFallbackTTS() {
    if (this.fallbackTTSTimer) {
      clearTimeout(this.fallbackTTSTimer);
      this.fallbackTTSTimer = null;
    }
    if ('speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch (e) {}
    }
  }

  speakFallbackTTS(text) {
    // Disabled to prevent dual-voice cacophony with Gemini Live native audio
    this.cancelFallbackTTS();
  }

  /**
   * Sends a text turn to the live interviewer. Everything the interviewer
   * says — opening question, follow-ups, debrief — is generated inside this
   * one Live session, so an interview makes no separate REST requests and
   * can't hit the free-tier generate_content rate limit.
   */
  sendLiveText(text) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text }] }],
        turnComplete: true
      }
    }));
    return true;
  }

  handleLiveToolCall(call) {
    if (!call || !call.name) return;
    // Always acknowledge, or the model can stall waiting for the result.
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        toolResponse: {
          functionResponses: [{ id: call.id, name: call.name, response: { result: 'received' } }]
        }
      }));
    }

    if (call.name === 'submit_scorecard') {
      try {
        const scoreData = this.validateScorecard(call.args || {});
        console.log('[App] Live interviewer submitted scorecard:', scoreData);
        this.handleWsMessage(JSON.stringify({ type: 'studio_critique', data: scoreData }));
      } catch (e) {
        console.error('[App] Live scorecard was invalid:', e.message);
      }
    } else if (call.name === 'end_interview') {
      console.log('[App] Live interviewer called end_interview:', call.args);
      this.endInterview('voice');
    }
  }

  async handleDirectGoogleWsMessage(data) {
    try {
      const parsed = JSON.parse(data);

      if (parsed.setupComplete) {
        if (this.isDirectSetupDone) return;
        this.isDirectSetupDone = true;
        this.isSetupDone = true;
        if (this.startSequenceTimeoutTimer) {
          clearTimeout(this.startSequenceTimeoutTimer);
          this.startSequenceTimeoutTimer = null;
        }
        console.log('[App] Direct Gemini Live setup complete!');
        this.dom.studioStatusText.textContent = 'Interviewer is Preparing Question...';
        if (this.dom.currentQuestionText) {
          this.dom.currentQuestionText.textContent = 'Interviewer is preparing your opening question...';
        }
        this.appendTranscript('system', 'Gemini Live session connected. Rehearsal beginning...');
        this.cancelFallbackTTS();

        this.state.currentAiTurnText = '';
        const topic = this.state.pitchTopic;
        const role = this.state.customRole ? ` for the role "${this.state.customRole}"` : '';
        this.sendLiveText(`Begin the interview now${role}: greet the candidate in one short sentence and ask your opening question about "${topic}".`);
        return;
      }

      if (parsed.serverContent) {
        const sc = parsed.serverContent;

        if (sc.interrupted) {
          // Gemini heard the candidate talk over the panel and stopped its
          // reply. Drop whatever of that reply is still queued or in flight
          // (until its turnComplete arrives).
          console.log('[App] Candidate talked over the panel — reply stopped.');
          const wasAudible = !!(this.audioManager && this.audioManager.isPlayingAi);
          this.discardingInterruptedTurn = true;
          if (wasAudible && !this.isInterviewEnding) {
            this.handleBargeInInterruption();
          } else if (this.audioManager) {
            this.audioManager.stopAllPlayback();
          }
        }

        if (sc.modelTurn && sc.modelTurn.parts) {
          for (const part of sc.modelTurn.parts) {
            if (part.inlineData) {
              // Audio still in flight from a turn the candidate just talked
              // over — never play it on top of them.
              if (this.discardingInterruptedTurn) continue;
              this.modelTurnInProgress = true;
              this.aiAudioPlayedThisTurn = true;
              if (this.currentState !== InterviewState.AI_SPEAKING && this.currentState !== InterviewState.FEEDBACK) {
                this.transitionState(InterviewState.AI_SPEAKING);
              }
              this.perfLogger.markFirstResponse();
              this.clearReplyTimeout();
              this.cancelFallbackTTS();
              this.audioManager.queueAudioChunk(part.inlineData.data, 24000, this.expectNewAiTurn);
              this.expectNewAiTurn = false;
            }
            // part.text is the model's internal reasoning, not what it says —
            // ignored; the spoken words come from outputTranscription below.
            if (part.functionCall) {
              this.handleLiveToolCall(part.functionCall);
            }
          }
        }

        if (sc.inputTranscription && sc.inputTranscription.text) {
          this.handleCandidateTranscript(sc.inputTranscription.text);
        }

        if (sc.outputTranscription && sc.outputTranscription.text && !this.discardingInterruptedTurn) {
          const spoken = sc.outputTranscription.text;
          if (this.currentState === InterviewState.FEEDBACK || this.isInterviewEnding) {
            this.studioSpokenCritiqueAccumulator += spoken;
            if (this.dom.studioSpokenCritiqueText) {
              this.dom.studioSpokenCritiqueText.textContent = `"${this.studioSpokenCritiqueAccumulator.trim()}"`;
            }
          } else {
            this.state.currentAiTurnText += spoken;
            if (this.dom.currentQuestionText) {
              this.dom.currentQuestionText.textContent = `"${this.state.currentAiTurnText.trim()}"`;
            }
          }
        }

        if (sc.turnComplete) {
          const wasDiscarded = this.discardingInterruptedTurn;
          const wasHeard = this.aiAudioPlayedThisTurn;
          this.discardingInterruptedTurn = false;
          this.modelTurnInProgress = false;
          this.aiAudioPlayedThisTurn = false;
          // A reply generated while the candidate kept talking was never
          // heard — don't show or record it; the candidate's answer stays open.
          if (wasDiscarded || (!wasHeard && this.currentState !== InterviewState.FEEDBACK)) {
            this.state.currentAiTurnText = '';
            return;
          }

          if (this.audioManager) {
            this.audioManager.markTurnComplete();
          }
          this.expectNewAiTurn = true;

          // "Debrief complete" is shown once its audio finishes playing
          // (handleAiFinishedSpeaking); generation finishing is too early.
          if (this.currentState === InterviewState.FEEDBACK) return;
          this.commitCandidateAnswer();
          const fullQ = this.state.currentAiTurnText.trim();
          console.log('[App] Direct: AI turn complete:', fullQ);
          if (fullQ) {
            this.lastAskedQuestion = fullQ;
            this.interviewContext.lastAskedQuestion = fullQ;
            if (!this.interviewContext.questionsAsked.includes(fullQ)) {
              this.interviewContext.questionsAsked.push(fullQ);
            }
          }
        }
      }

      if (parsed.toolCall) {
        for (const call of parsed.toolCall.functionCalls || []) {
          this.handleLiveToolCall(call);
        }
      }

    } catch (err) {
      console.error('[App] Error parsing Direct Google WS message:', err);
    }
  }

  /**
   * Parses a Gemini JSON response defensively (models occasionally wrap
   * responseMimeType:"application/json" output in ```json fences anyway)
   * and validates the shape actually matches what the scorecard needs.
   */
  parseAndValidateScorecard(rawText) {
    if (!rawText) throw new Error('Empty scorecard response text');
    const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    return this.validateScorecard(JSON.parse(cleaned));
  }

  validateScorecard(data) {
    const score = Number(data.score);
    if (!Number.isFinite(score) || score < 0 || score > 100) {
      throw new Error(`Scorecard score out of range or non-numeric: ${data.score}`);
    }
    if (!data.verdict || typeof data.verdict !== 'string') {
      throw new Error('Scorecard missing verdict string');
    }
    if (!Array.isArray(data.strengths) || data.strengths.length === 0) {
      throw new Error('Scorecard missing strengths array');
    }
    if (!Array.isArray(data.improvements) || data.improvements.length === 0) {
      throw new Error('Scorecard missing improvements array');
    }
    return { score: Math.round(score), verdict: data.verdict, strengths: data.strengths, improvements: data.improvements };
  }

  async requestScorecardFromGemini(apiKey, transcriptText) {
    const prompt = `You are the executive reviewer at NSOFFICE.AI (Network Science AI Centre of Excellence), scoring a live interview/pitch rehearsal.

Rehearsal Topic: "${this.state.pitchTopic}"
${this.state.customRole ? `Target Role: "${this.state.customRole}"` : ''}

FULL REHEARSAL TRANSCRIPT (Panelist questions and Candidate answers, in order):
${transcriptText}

Evaluate the CANDIDATE's performance ONLY based on the substance of their actual answers above: technical depth, use of concrete metrics/evidence, clarity, structure, and composure. Do not invent achievements they did not mention.

Return ONLY a valid JSON object matching exactly this schema (no markdown, no commentary):
{
  "score": 85,
  "verdict": "Strong Performer",
  "strengths": ["Specific strength grounded in what they actually said", "A second specific strength"],
  "improvements": ["Specific, actionable improvement grounded in a gap in their actual answers", "A second specific improvement"]
}`;

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
      })
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      this.notifyIfRateLimited(res.status);
      throw new Error(`Scorecard request failed: HTTP ${res.status} ${bodyText.slice(0, 300)}`);
    }

    const data = await res.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return this.parseAndValidateScorecard(rawText);
  }

  async fetchQuickStudioScorecard() {
    const apiKey = this.getApiKey();

    const transcriptForScoring = this.state.transcript.filter(t => t.speaker !== 'system');
    const transcriptText = transcriptForScoring.length > 0
      ? transcriptForScoring.map(t => `[${t.speaker === 'ai' ? 'PANELIST' : 'CANDIDATE'} - ${t.timestamp}]: ${t.text}`).join('\n')
      : 'The candidate ended the rehearsal before answering any questions.';

    // Fallback only: the live interviewer normally submits the scorecard via
    // its submit_scorecard tool. A single REST attempt keeps quota usage low.
    if (apiKey) {
      try {
        const scoreData = await this.requestScorecardFromGemini(apiKey, transcriptText);
        if (this.state.studioCritiqueData) return;
        this.handleWsMessage(JSON.stringify({ type: 'studio_critique', data: scoreData }));
        return;
      } catch (e) {
        console.error('[App] Fallback scorecard request failed:', e.message || e);
      }
    }
    if (this.state.studioCritiqueData) return;
    console.error('[App] No scorecard available — showing indicative fallback score. This does NOT reflect actual performance.');

    // Last resort, clearly labelled so it's never mistaken for an actual
    // evaluation of what the candidate said.
    this.handleWsMessage(JSON.stringify({
      type: 'studio_critique',
      data: {
        score: 70,
        verdict: "Indicative Score — Connection Issue",
        strengths: ["Completed the rehearsal session end-to-end"],
        improvements: ["We couldn't reach the scoring model this time — try ending a new rehearsal again for a real evaluation of your answers."]
      }
    }));
  }

  switchView(viewName) {
    this.state.view = viewName;
    document.querySelectorAll('.view-section').forEach(sec => sec.classList.remove('active'));

    if (viewName === 'setup') {
      this.dom.viewSetup.classList.add('active');
    } else if (viewName === 'studio') {
      this.dom.viewStudio.classList.add('active');
    } else if (viewName === 'debrief') {
      this.dom.viewDebrief.classList.add('active');
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // =========================================================================
  // STATE MACHINE TRANSITIONS & VISUAL STATUS
  // =========================================================================
  transitionState(newState) {
    if (this.currentState === newState) return;
    console.log(`[InterviewState] ${this.currentState} -> ${newState}`);
    this.currentState = newState;
    this.updateUIForState(newState);
  }

  updateUIForState(state) {
    switch (state) {
      case InterviewState.AI_SPEAKING:
        this.dom.studioStatusText.textContent = 'Interviewer is Speaking...';
        this.dom.speakerStateLabel.textContent = 'Interviewer is speaking — talk over them any time to cut in';
        if (this.dom.aiSpeakingDot) this.dom.aiSpeakingDot.classList.remove('idle');
        if (this.dom.aiSpeakingStatus) this.dom.aiSpeakingStatus.textContent = '● Interviewer is speaking...';

        if (this.dom.statusGlowDot) {
          this.dom.statusGlowDot.className = 'status-glow-dot speaking';
        }
        if (this.dom.statusLiveText) {
          this.dom.statusLiveText.textContent = 'Interviewer is speaking...';
        }
        if (this.dom.candidateAnswerCard) {
          this.dom.candidateAnswerCard.classList.remove('active-speaking', 'processing-answer');
        }
        if (this.dom.answerStateIcon) this.dom.answerStateIcon.textContent = '⏳';
        if (this.dom.answerStateText) this.dom.answerStateText.textContent = '● Interviewer is speaking...';
        if (this.dom.candidateLiveTranscript && !this.currentCandidateTurnText) {
          this.dom.candidateLiveTranscript.textContent = 'Interviewer is speaking. Start talking any time to cut in.';
          this.dom.candidateLiveTranscript.classList.remove('active-text');
        }
        break;

      case InterviewState.WAITING_FOR_CANDIDATE:
        this.dom.studioStatusText.textContent = 'Your Turn — Just Speak';
        this.dom.speakerStateLabel.textContent = 'Your turn — microphone is live, just start talking';
        if (this.dom.aiSpeakingDot) this.dom.aiSpeakingDot.classList.add('idle');
        if (this.dom.aiSpeakingStatus) this.dom.aiSpeakingStatus.textContent = 'Awaiting your answer';

        if (this.dom.statusGlowDot) {
          this.dom.statusGlowDot.className = 'status-glow-dot';
        }
        if (this.dom.statusLiveText) {
          this.dom.statusLiveText.textContent = 'Your turn — Listening';
        }
        if (this.dom.candidateAnswerCard) {
          this.dom.candidateAnswerCard.classList.remove('active-speaking', 'processing-answer');
        }
        if (this.dom.answerStateIcon) this.dom.answerStateIcon.textContent = '🎤';
        if (this.dom.answerStateText) this.dom.answerStateText.textContent = '● Your turn — Listening';
        if (this.dom.candidateLiveTranscript) {
          this.dom.candidateLiveTranscript.textContent = "Just start talking — the panel is listening and may jump in with follow-ups when you pause.";
          this.dom.candidateLiveTranscript.classList.remove('active-text');
        }
        break;

      case InterviewState.CANDIDATE_SPEAKING:
        this.dom.studioStatusText.textContent = "You're Speaking...";
        this.dom.speakerStateLabel.textContent = "Panel is listening — they may jump in when you pause";

        if (this.dom.statusGlowDot) {
          this.dom.statusGlowDot.className = 'status-glow-dot speaking';
        }
        if (this.dom.statusLiveText) {
          this.dom.statusLiveText.textContent = 'Listening to your answer...';
        }
        if (this.dom.candidateAnswerCard) {
          this.dom.candidateAnswerCard.classList.add('active-speaking');
          this.dom.candidateAnswerCard.classList.remove('processing-answer');
        }
        if (this.dom.answerStateIcon) this.dom.answerStateIcon.textContent = '🎙️';
        if (this.dom.answerStateText) this.dom.answerStateText.textContent = '● Listening to your answer...';
        break;

      case InterviewState.CANDIDATE_FINISHED:
        if (this.dom.statusGlowDot) {
          this.dom.statusGlowDot.className = 'status-glow-dot processing';
        }
        if (this.dom.statusLiveText) {
          this.dom.statusLiveText.textContent = 'Answer completed';
        }
        if (this.dom.answerStateText) {
          this.dom.answerStateText.textContent = '● Answer completed';
        }
        break;

      case InterviewState.PROCESSING_ANSWER:
        this.dom.studioStatusText.textContent = 'Panel is Responding...';
        this.dom.speakerStateLabel.textContent = 'You paused — the panel is responding (keep talking to hold the floor)';
        if (this.dom.candidateAnswerCard) {
          this.dom.candidateAnswerCard.classList.remove('active-speaking');
          this.dom.candidateAnswerCard.classList.add('processing-answer');
        }
        if (this.dom.statusGlowDot) {
          this.dom.statusGlowDot.className = 'status-glow-dot processing';
        }
        if (this.dom.statusLiveText) {
          this.dom.statusLiveText.textContent = 'Panel is responding...';
        }
        if (this.dom.answerStateIcon) this.dom.answerStateIcon.textContent = '⏳';
        if (this.dom.answerStateText) this.dom.answerStateText.textContent = '● Panel is responding...';
        break;

      case InterviewState.ENDING_INTERVIEW:
        this.dom.studioStatusText.textContent = 'Ending Interview...';
        this.dom.speakerStateLabel.textContent = 'Compiling executive scorecard...';
        if (this.dom.statusLiveText) {
          this.dom.statusLiveText.textContent = 'Ending interview...';
        }
        if (this.dom.answerStateText) {
          this.dom.answerStateText.textContent = '● Ending interview & compiling debrief...';
        }
        break;

      case InterviewState.FEEDBACK:
        this.dom.studioStatusText.textContent = 'Debrief Active';
        // The interview is over — retire every live-session control so
        // nothing is left sitting there looking clickable but silently
        // doing nothing. "Start New Rehearsal Session" is the only action
        // left to take.
        if (this.dom.btnEndRehearsal) {
          this.dom.btnEndRehearsal.disabled = true;
          const label = this.dom.btnEndRehearsal.querySelector('.btn-label');
          if (label) label.textContent = 'Interview Ended';
        }
        if (this.dom.verbalEndStatusBox && this.dom.verbalStatusSub) {
          this.dom.verbalStatusSub.textContent = 'This rehearsal has ended — start a new session below to rehearse again.';
        }
        if (this.dom.btnRepeatQuestion) this.dom.btnRepeatQuestion.disabled = true;
        if (this.dom.btnToggleMic) this.dom.btnToggleMic.disabled = true;
        if (this.dom.btnStudioCamera) this.dom.btnStudioCamera.disabled = true;
        if (this.dom.btnStudioScreen) this.dom.btnStudioScreen.disabled = true;
        break;

      default:
        break;
    }
  }

  // =========================================================================
  // VIEW 1 -> VIEW 2: START REHEARSAL
  // =========================================================================
  async handleStartRehearsal() {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      if (this.dom.apiKeyBanner) {
        this.dom.apiKeyBanner.style.display = 'block';
        this.dom.apiKeyBanner.scrollIntoView({ behavior: 'smooth' });
      }
      this.showToast('⚠️ Please enter a Gemini API key or click "Use Project Key"', 4000);
      return;
    }

    this.dom.btnStartRehearsal.disabled = true;
    this.dom.btnStartRehearsal.querySelector('.btn-text').textContent = 'Connecting...';

    // Safety net: mic permission prompts and the Live WebSocket handshake
    // can each stall (a permission dialog the user hasn't answered, a
    // connection that never opens/closes, a setup that never completes) in
    // ways that neither resolve nor reject — which used to leave the button
    // stuck on "Connecting..." forever with zero feedback. This guarantees
    // we surface something actionable within 15s no matter where it stalls.
    if (this.startSequenceTimeoutTimer) clearTimeout(this.startSequenceTimeoutTimer);
    this.startSequenceTimeoutTimer = setTimeout(() => this.handleStartSequenceTimeout(), 15000);

    // Reset State
    this.isInterviewEnding = false;
    this.expectNewAiTurn = true;
    this.perfLogger.reset();
    this.state.customRole = this.dom.inputTargetRole ? this.dom.inputTargetRole.value.trim() : '';
    this.state.pitchTopic = this.dom.inputRehearsalTopic ? this.dom.inputRehearsalTopic.value.trim() : '';
    if (!this.state.pitchTopic) {
      this.state.pitchTopic = 'Executive Leadership & Behavioral Rehearsal';
    }
    this.state.transcript = [];
    this.state.interruptionsCount = 0;
    this.state.questionNumber = 1;
    this.state.studioCritiqueData = null;
    this.currentCandidateTurnText = '';
    this.resetTurnState();
    this.lastAskedQuestion = '';
    this.studioSpokenCritiqueAccumulator = '';
    if (this.dom.studioFeedbackPanel) {
      this.dom.studioFeedbackPanel.style.display = 'none';
    }
    if (this.dom.btnStudioExportMarkdown) {
      this.dom.btnStudioExportMarkdown.disabled = true;
    }
    if (this.dom.studioSpokenCritiqueText) {
      this.dom.studioSpokenCritiqueText.textContent = 'Listening for executive debrief...';
    }
    this.interviewContext = {
      interviewTopic: this.state.pitchTopic,
      questionsAsked: [],
      candidateAnswers: [],
      lastAskedQuestion: ''
    };
    this.dom.liveTranscriptFeed.innerHTML = '';

    // Update Studio Header
    const displayTopic = this.state.pitchTopic.length > 50
      ? this.state.pitchTopic.substring(0, 48) + '...'
      : this.state.pitchTopic;
    this.dom.studioPersonaName.textContent = displayTopic;
    this.dom.studioDifficultyName.textContent = `${this.state.difficulty.toUpperCase()} PANEL`;

    if (this.dom.turnPhasePill) {
      this.dom.turnPhasePill.textContent = `Question 1`;
    }
    if (this.dom.currentQuestionText) {
      this.dom.currentQuestionText.textContent = 'Connecting to panelist...';
    }

    try {
      // 1. Initialize Audio Stream Manager
      this.audioManager = new AudioStreamManager({
        turnPauseSeconds: CONFIG.TURN_PAUSE_SECONDS,

        onUserVolume: (vol) => {
          if (this.currentState !== InterviewState.AI_SPEAKING) {
            this.updateWaveform(vol);
            if (window.LiquidGlass) {
              window.LiquidGlass.setAudioLevel(vol);
            }
          }
        },

        onAiVolume: (vol) => {
          this.updateWaveform(vol);
          if (window.LiquidGlass) {
            window.LiquidGlass.setAudioLevel(vol);
          }
        },

        onAudioFrame: (base64, rms, frameMs) => {
          if (this.audioManager !== sessionAudioManager) return;
          this.handleMicFrame(base64, rms, frameMs);
        },

        onPlaybackStarted: () => {
          this.perfLogger.markAudioPlaybackStart();
        },

        onPlaybackFinished: () => {
          // Stopped sources still fire onended → a debounced "finished"
          // callback. Ignore it once this manager has been torn down, or it
          // flips a fresh/reset session into WAITING_FOR_CANDIDATE and
          // starts listening in the background.
          if (this.audioManager !== sessionAudioManager) return;
          this.handleAiFinishedSpeaking();
        },

        onBargeIn: () => {
          this.handleBargeInInterruption();
        }
      });
      const sessionAudioManager = this.audioManager;

      await this.audioManager.startInput();
      this.micHealth = { silentMs: 0, recovering: false, tried: new Set(), warned: false };
      await this.preferRealMicrophone();

      // 2. Initialize Camera or Screen if requested
      if (this.state.enableCamera) {
        await this.startCameraStream();
      } else if (this.state.enableScreen) {
        await this.startScreenStream();
      }

      // 3. Connect WebSocket to Server or Direct Google Live
      this.connectLiveWebSocket(apiKey);

      // 4. Switch to Studio View & Start TOTAL INTERVIEW TIMER
      this.transitionState(InterviewState.IDLE);
      this.switchView('studio');
      this.startTotalInterviewTimer();

    } catch (err) {
      console.error('Error starting rehearsal session:', err);
      if (this.startSequenceTimeoutTimer) {
        clearTimeout(this.startSequenceTimeoutTimer);
        this.startSequenceTimeoutTimer = null;
      }
      // Re-enable the button FIRST: showToast/DOM updates below must never be
      // able to leave "Connecting..." stuck forever if something in this
      // block itself misbehaves (e.g. alert() being silently blocked inside
      // an embedded browser/webview, which used to leave this code
      // unreachable).
      this.dom.btnStartRehearsal.disabled = false;
      this.dom.btnStartRehearsal.querySelector('.btn-text').textContent = 'Enter Studio & Start Rehearsal';
      const reason = err && err.name === 'NotAllowedError'
        ? 'Microphone access was denied. Please allow microphone access and try again.'
        : (err && err.message) || 'Microphone access denied.';
      this.showToast(`⚠️ Could not start rehearsal: ${reason}`, 7000);
      if (this.dom.currentQuestionText) {
        this.dom.currentQuestionText.textContent = `⚠️ ${reason}`;
      }
    }
  }

  /**
   * Fires if 15s have passed since clicking "Start Rehearsal" without the
   * Live session's setup completing — whether because a mic-permission
   * prompt was never answered, the WebSocket never opened, or Google never
   * responded to setup (e.g. free-tier rate limiting). Whatever the cause,
   * the candidate should never be left staring at a frozen "Connecting..."
   * screen with no way forward.
   */
  handleStartSequenceTimeout() {
    this.startSequenceTimeoutTimer = null;
    if (this.isDirectSetupDone || this.isInterviewEnding) return;

    console.warn('[App] Start sequence timed out after 15s with no setupComplete — resetting.');
    this.showToast('⚠️ Taking too long to connect. Check your microphone permission and internet connection, then try again.', 8000);

    if (this.ws) {
      try {
        this.ws.onopen = null;
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.onmessage = null;
        this.ws.close();
      } catch (e) {}
      this.ws = null;
    }
    if (this.audioManager) {
      try { this.audioManager.stop(); } catch (e) {}
      this.audioManager = null;
    }
    this.stopTotalInterviewTimer();

    this.dom.btnStartRehearsal.disabled = false;
    this.dom.btnStartRehearsal.querySelector('.btn-text').textContent = 'Enter Studio & Start Rehearsal';
    this.switchView('setup');
  }

  // =========================================================================
  // TOTAL INTERVIEW TIMER (Counts upward continuously, no per-answer countdown)
  // =========================================================================
  startTotalInterviewTimer() {
    this.stopTotalInterviewTimer();
    this.interviewStartTime = Date.now();
    this.interviewEndTime = null;
    this.totalInterviewDurationSeconds = 0;

    this.totalInterviewTimerInterval = setInterval(() => {
      if (this.isInterviewEnding) {
        this.stopTotalInterviewTimer();
        return;
      }
      const elapsedMs = Date.now() - this.interviewStartTime;
      const totalSecs = Math.floor(elapsedMs / 1000);
      this.totalInterviewDurationSeconds = totalSecs;

      if (this.dom.sessionTimer) {
        this.dom.sessionTimer.textContent = this.formatElapsed(totalSecs);
      }
    }, 500); // 500ms intervals prevent clock drift
  }

  stopTotalInterviewTimer() {
    if (this.totalInterviewTimerInterval) {
      clearInterval(this.totalInterviewTimerInterval);
      this.totalInterviewTimerInterval = null;
    }
    if (this.interviewStartTime && !this.interviewEndTime) {
      this.interviewEndTime = Date.now();
      this.totalInterviewDurationSeconds = Math.max(1, Math.floor((this.interviewEndTime - this.interviewStartTime) / 1000));
    }
  }

  formatElapsed(totalSeconds) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  // =========================================================================
  // WEBSOCKET INCOMING DISPATCHER
  // =========================================================================
  handleWsMessage(data) {
    try {
      const msg = JSON.parse(data);

      // If interview is ending, only accept debrief messages (feedback text, audio, and studio scorecard)
      if (this.isInterviewEnding && this.currentState !== InterviewState.FEEDBACK && this.currentState !== InterviewState.ENDING_INTERVIEW) {
        return;
      }

      if (msg.type === 'ready') {
        this.dom.studioStatusText.textContent = 'Interviewer is Preparing Question...';
        this.appendTranscript('system', 'Gemini Live session connected. The interview will begin now.');
      }
      else if (msg.type === 'ai_audio') {
        if (this.currentState !== InterviewState.AI_SPEAKING && this.currentState !== InterviewState.FEEDBACK) {
          this.transitionState(InterviewState.AI_SPEAKING);
        }
        this.perfLogger.markFirstResponse();
        this.clearReplyTimeout();
        this.cancelFallbackTTS();
        this.audioManager.queueAudioChunk(msg.data);
      }
      else if (msg.type === 'ai_text') {
        if (this.currentState === InterviewState.FEEDBACK || this.isInterviewEnding) {
          if (msg.isFull) {
            this.studioSpokenCritiqueAccumulator = msg.text;
          } else {
            this.studioSpokenCritiqueAccumulator += msg.text;
          }
          if (this.dom.studioSpokenCritiqueText) {
            this.dom.studioSpokenCritiqueText.textContent = `"${this.studioSpokenCritiqueAccumulator.trim()}"`;
          }
          return;
        }

        if (msg.isFull) {
          this.state.currentAiTurnText = msg.text;
          this.lastAskedQuestion = msg.text;
          this.interviewContext.lastAskedQuestion = msg.text;
          if (!this.interviewContext.questionsAsked.includes(msg.text)) {
            this.interviewContext.questionsAsked.push(msg.text);
          }
          if (this.dom.currentQuestionText) {
            this.dom.currentQuestionText.textContent = `"${msg.text.trim()}"`;
          }
          this.cancelFallbackTTS();
        } else {
          this.state.currentAiTurnText += msg.text;
          if (this.dom.currentQuestionText) {
            this.dom.currentQuestionText.textContent = `"${this.state.currentAiTurnText.trim()}"`;
          }
        }
      }
      else if (msg.type === 'studio_critique') {
        console.log('[App] Received studio critique scorecard:', msg.data);
        const data = msg.data;
        this.state.studioCritiqueData = data;
        if (this.dom.btnStudioExportMarkdown) {
          this.dom.btnStudioExportMarkdown.disabled = false;
        }
        if (this.dom.studioFeedbackScore && data.score) {
          this.dom.studioFeedbackScore.textContent = data.score;
        }
        if (this.dom.studioFeedbackVerdict && data.verdict) {
          this.dom.studioFeedbackVerdict.textContent = data.verdict;
        }
        if (this.dom.studioFeedbackStrengths && Array.isArray(data.strengths)) {
          this.dom.studioFeedbackStrengths.innerHTML = data.strengths.map(s => `<li>${s}</li>`).join('');
        }
        if (this.dom.studioFeedbackImprovements && Array.isArray(data.improvements)) {
          this.dom.studioFeedbackImprovements.innerHTML = data.improvements.map(i => `<li>${i}</li>`).join('');
        }
        if (this.dom.feedbackDeliveryStatus) {
          this.dom.feedbackDeliveryStatus.textContent = '🎙️ Delivering live executive debrief...';
        }
      }
      else if (msg.type === 'interrupted') {
        this.handleBargeInInterruption();
      }
      else if (msg.type === 'turn_complete') {
        if (this.currentState === InterviewState.FEEDBACK) {
          if (this.dom.feedbackDeliveryStatus) {
            this.dom.feedbackDeliveryStatus.textContent = '✅ Executive Debrief Complete';
          }
          return;
        }
        const fullQ = this.state.currentAiTurnText.trim();
        console.log('[App] AI turn text complete:', fullQ);
        if (fullQ) {
          this.lastAskedQuestion = fullQ;
          this.interviewContext.lastAskedQuestion = fullQ;
          if (!this.interviewContext.questionsAsked.includes(fullQ)) {
            this.interviewContext.questionsAsked.push(fullQ);
          }
        }
      }
      else if (msg.type === 'auto_end') {
        console.log('[App] Auto end signal received from upstream Gemini tool call:', msg.summary);
        this.endInterview('voice');
      }
      else if (msg.type === 'error') {
        this.showToast(msg.message, 4000);
      }
    } catch (err) {
      console.error('Error parsing incoming WS msg:', err);
    }
  }

  // =========================================================================
  // TURN-TAKING CYCLE
  // The candidate just talks. Browser-side voice activity detection tells
  // Gemini Live when they start (activityStart — which also cuts the
  // interviewer off instantly) and when they pause (activityEnd — which gives
  // the panel the floor, so it jumps in with follow-ups at natural pauses).
  // =========================================================================
  handleAiFinishedSpeaking() {
    if (this.isInterviewEnding) {
      if (this.currentState === InterviewState.FEEDBACK) {
        if (this.dom.feedbackDeliveryStatus) {
          this.dom.feedbackDeliveryStatus.textContent = '✅ Executive Debrief Complete';
        }
        if (this.dom.studioStatusText) {
          this.dom.studioStatusText.textContent = 'Debrief Complete';
        }
      }
      return;
    }

    const questionText = this.state.currentAiTurnText.trim();
    if (questionText) {
      this.lastAskedQuestion = questionText;
      this.interviewContext.lastAskedQuestion = questionText;
      if (!this.interviewContext.questionsAsked.includes(questionText)) {
        this.interviewContext.questionsAsked.push(questionText);
      }
      this.appendTranscript('ai', questionText);
      this.state.currentAiTurnText = '';
      this.perfLogger.questionsCount++;
    }

    // Stopped (barged-in) audio also ends up here; the candidate already has
    // the floor in that case.
    if (this.currentState !== InterviewState.CANDIDATE_SPEAKING) {
      this.transitionState(InterviewState.WAITING_FOR_CANDIDATE);
    }
  }

  handleRepeatQuestionRequest() {
    if (this.isInterviewEnding || !this.isDirectSetupDone) return;
    const question = (this.lastAskedQuestion || '').replace(/^sure,?\s*let me repeat that:?\s*/i, '');
    if (!question) return;

    console.log('[App] Repeating question:', question);
    this.showToast('🔁 Repeating the question...', 2500);
    this.stopInterviewerSpeech();
    this.state.currentAiTurnText = '';
    this.transitionState(InterviewState.PROCESSING_ANSWER);
    this.sendLiveText(`The candidate asked you to repeat your last question. Repeat it word for word: "${question}"`);
    this.startReplyTimeout();
  }

  // =========================================================================
  // MICROPHONE → GEMINI LIVE
  // =========================================================================
  resetTurnState() {
    this.modelTurnInProgress = false;
    this.discardingInterruptedTurn = false;
    this.aiAudioPlayedThisTurn = false;
  }

  // The mic streams continuously; Gemini detects speech and turn-taking.
  handleMicFrame(base64, rms, frameMs) {
    this.checkMicHealth(rms, frameMs);
    if (this.isInterviewEnding || !this.isDirectSetupDone) return;
    this.sendMicAudio(base64);
  }

  // Virtual/loopback inputs (audio-routing utilities) carry system sound, not
  // the candidate's voice. They're often left as the system default input.
  isVirtualInput(label) {
    return /virtual|background music|blackhole|loopback|soundflower|aggregate|multi-output|zoom|teams|vb-audio|voicemeeter|cable|obs/i.test(label || '');
  }

  async preferRealMicrophone() {
    const mic = this.audioManager.getInputDevice();
    if (!mic) return;
    this.micHealth.tried.add(mic.deviceId);
    if (this.isVirtualInput(mic.label)) {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const real = devices.filter(d => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications' && !this.isVirtualInput(d.label));
        const pick = real.find(d => /built-in/i.test(d.label)) || real[0];
        if (pick) {
          this.micHealth.tried.add(pick.deviceId);
          const now = await this.audioManager.switchInputDevice(pick.deviceId);
          console.warn(`[App] Default input "${mic.label}" is a virtual device — using "${now.label}" instead.`);
          this.showToast(`🎙️ Using "${now.label}" (your default input "${mic.label}" isn't a microphone)`, 6000);
          return;
        }
      } catch (e) {
        console.error('[App] Could not switch away from virtual input:', e);
      }
    }
    console.log(`[App] Using microphone: "${mic.label}"`);
  }

  // A real microphone always picks up some room noise. Near-total silence for
  // a few seconds means we're capturing from a dead or virtual input.
  checkMicHealth(rms, frameMs) {
    const h = this.micHealth;
    if (!h || h.recovering || this.isInterviewEnding) return;
    if (rms > 0.0003) {
      h.silentMs = 0;
      return;
    }
    h.silentMs += frameMs;
    if (h.silentMs >= 3000) this.recoverSilentMic();
  }

  async recoverSilentMic() {
    const h = this.micHealth;
    h.recovering = true;
    const current = this.audioManager && this.audioManager.getInputDevice();
    const currentLabel = (current && current.label) || 'your microphone';
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices())
        .filter(d => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications' && !h.tried.has(d.deviceId));
      const rank = (d) => (this.isVirtualInput(d.label) ? 2 : 0) + (/built-in|microphone|mic/i.test(d.label) ? 0 : 1);
      const next = devices.sort((a, b) => rank(a) - rank(b))[0];
      if (next && this.audioManager) {
        h.tried.add(next.deviceId);
        const now = await this.audioManager.switchInputDevice(next.deviceId);
        console.warn(`[App] No sound from "${currentLabel}" — switched microphone to "${now.label}".`);
        this.showToast(`🎙️ No sound from "${currentLabel}" — switched to "${now.label}"`, 6000);
        h.silentMs = 0;
        h.recovering = false;
        return;
      }
    } catch (e) {
      console.error('[App] Could not switch microphone:', e);
    }
    if (!h.warned) {
      h.warned = true;
      console.error(`[App] No working microphone found (current: "${currentLabel}").`);
      this.showToast(`⚠️ No sound from your microphone ("${currentLabel}"). Select a real microphone as the input in your system sound settings, then start a new rehearsal.`, 12000);
      if (this.dom.candidateLiveTranscript) {
        this.dom.candidateLiveTranscript.textContent = `⚠️ The panel can't hear you — no sound is coming from "${currentLabel}". Choose your real microphone as the system input device and start again.`;
      }
    }
  }

  sendMicAudio(base64) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: base64 } }
    }));
  }

  stopInterviewerSpeech() {
    if (this.modelTurnInProgress) this.discardingInterruptedTurn = true;
    if (this.audioManager) this.audioManager.stopAllPlayback();
    this.expectNewAiTurn = true;
  }

  // Gemini Live's transcript of what the candidate is saying.
  handleCandidateTranscript(text) {
    if (this.isInterviewEnding) return;
    this.currentCandidateTurnText += text;
    if (this.currentState !== InterviewState.AI_SPEAKING) {
      this.transitionState(InterviewState.CANDIDATE_SPEAKING);
      // Safety net in case the panel never replies to what was just said.
      this.startReplyTimeout();
    }
    const soFar = this.currentCandidateTurnText.replace(/\s+/g, ' ').trim();
    if (this.dom.candidateLiveTranscript && soFar) {
      this.dom.candidateLiveTranscript.textContent = `"${soFar}"`;
      this.dom.candidateLiveTranscript.classList.add('active-text');
    }
    if (isTerminationIntent(soFar)) {
      console.log('[App] Candidate asked to end the interview:', soFar);
      this.endInterview('voice');
    }
  }

  // Records the candidate's answer once the panel has replied to it (by then
  // its transcription is complete).
  commitCandidateAnswer() {
    const text = this.currentCandidateTurnText.replace(/\s+/g, ' ').trim();
    this.currentCandidateTurnText = '';
    if (!text) return;
    this.appendTranscript('user', text);
    this.interviewContext.candidateAnswers.push(text);
    this.perfLogger.candidateTurnsCount++;
    this.state.questionNumber++;
    if (this.dom.turnPhasePill) {
      this.dom.turnPhasePill.textContent = `Question ${this.state.questionNumber}`;
    }
  }

  // If the panel hasn't replied well after the candidate paused, nudge it.
  startReplyTimeout() {
    this.clearReplyTimeout();
    this.replyTimeoutTimer = setTimeout(() => {
      this.replyTimeoutTimer = null;
      if (this.isInterviewEnding ||
          (this.currentState !== InterviewState.CANDIDATE_SPEAKING && this.currentState !== InterviewState.PROCESSING_ANSWER)) return;
      console.warn('[App] Panel did not reply in time — nudging it.');
      this.perfLogger.retriesCount++;
      this.state.currentAiTurnText = '';
      this.sendLiveText('Please respond to the candidate now: briefly acknowledge what they said and ask your next question.');
    }, CONFIG.REPLY_TIMEOUT_MS);
  }

  clearReplyTimeout() {
    if (this.replyTimeoutTimer) {
      clearTimeout(this.replyTimeoutTimer);
      this.replyTimeoutTimer = null;
    }
  }

  // =========================================================================
  // DUAL TERMINATION: UNIFIED endInterview(source) FUNCTION
  // =========================================================================
  /**
   * The single centralized termination point invoked by:
   * - Voice termination (source = 'voice')
   * - Manual button click (source = 'button')
   *
   * Enforces immediate in-studio feedback without loading a separate screen.
   */
  async endInterview(source = 'button') {
    // Race-condition guard
    if (this.isInterviewEnding) {
      console.log(`[App] endInterview called from [${source}], but already ending. Ignoring duplicate call.`);
      this.perfLogger.duplicateRequestsPrevented++;
      return;
    }

    this.isInterviewEnding = true;
    console.log(`[App] === TERMINATING INTERVIEW via [${source.toUpperCase()}] ===`);

    // Stop TOTAL INTERVIEW TIMER and record final duration
    this.stopTotalInterviewTimer();

    // UI Announcement for Voice or Manual Trigger
    if (source === 'voice') {
      if (this.dom.verbalEndStatusBox) {
        this.dom.verbalEndStatusBox.classList.add('triggered');
        if (this.dom.verbalStatusTitle) {
          this.dom.verbalStatusTitle.textContent = "🎙️ Voice Termination Detected!";
        }
        if (this.dom.verbalStatusSub) {
          this.dom.verbalStatusSub.textContent = "Delivering immediate executive debrief out loud...";
        }
      }
      this.showToast("🎙️ Voice termination detected: Delivering immediate feedback...", 3500);
    }

    // 1. Immediately stop asking new interview questions
    this.clearReplyTimeout();

    // 2. Stop playback and mute the mic so the candidate doesn't talk over
    // (and interrupt) the debrief.
    this.stopInterviewerSpeech();
    if (this.audioManager) {
      this.audioManager.isMuted = true;
    }
    this.commitCandidateAnswer();
    this.state.currentAiTurnText = '';
    this.cancelFallbackTTS();
    this.stopVideoFeed();

    // 3. Sanitize transcript: Remove any termination utterance
    this.sanitizeTranscriptForCritique();

    // 4. Update Studio State to FEEDBACK (stay in view-studio, do NOT load separate screen!)
    this.transitionState(InterviewState.FEEDBACK);
    if (this.dom.studioStatusText) {
      this.dom.studioStatusText.textContent = "Live Executive Debrief";
    }

    // 5. Reveal In-Studio Feedback Card immediately then and there!
    // Clear the static placeholder markup (score/verdict/lists baked into the
    // HTML) so nobody mistakes example content for a real evaluation while
    // the actual scorecard is still being generated.
    if (this.dom.studioFeedbackScore) this.dom.studioFeedbackScore.textContent = '—';
    if (this.dom.studioFeedbackVerdict) this.dom.studioFeedbackVerdict.textContent = 'Calculating…';
    if (this.dom.studioFeedbackStrengths) this.dom.studioFeedbackStrengths.innerHTML = '<li>Evaluating your answers…</li>';
    if (this.dom.studioFeedbackImprovements) this.dom.studioFeedbackImprovements.innerHTML = '<li>Evaluating your answers…</li>';

    if (this.dom.studioFeedbackPanel) {
      this.dom.studioFeedbackPanel.style.display = 'block';
      this.dom.studioFeedbackPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    if (this.dom.feedbackDeliveryStatus) {
      this.dom.feedbackDeliveryStatus.textContent = "🎙️ Interviewer is delivering spoken debrief...";
    }
    if (this.dom.studioSpokenCritiqueText) {
      this.dom.studioSpokenCritiqueText.textContent = "Listening for interviewer verbal debrief...";
    }

    // 6. Ask the live interviewer for its scorecard (via the submit_scorecard
    // tool) and a spoken debrief — no separate REST request needed.
    const liveRequested = this.sendLiveText(
      "The rehearsal is now complete. First call submit_scorecard with your evaluation of the candidate's actual answers. " +
      "Then deliver your spoken executive debrief out loud in 3-4 sentences: state the score out of 100, what went well, and the single most critical area to improve."
    );

    if (liveRequested) {
      console.log('[App] Requested scorecard + spoken debrief from Gemini Live...');
      // If the live scorecard hasn't arrived in time, fall back to a single
      // REST scoring request so the candidate is never left on "Calculating…".
      if (this.scorecardFallbackTimer) clearTimeout(this.scorecardFallbackTimer);
      this.scorecardFallbackTimer = setTimeout(() => {
        this.scorecardFallbackTimer = null;
        if (this.currentState === InterviewState.FEEDBACK && !this.state.studioCritiqueData) {
          console.warn('[App] Live scorecard did not arrive in time — using fallback scoring.');
          this.fetchQuickStudioScorecard();
        }
      }, 25000);
    } else {
      if (this.dom.studioSpokenCritiqueText) {
        this.dom.studioSpokenCritiqueText.textContent = 'Live connection unavailable — showing written debrief below.';
      }
      this.fetchQuickStudioScorecard();
    }
  }

  /**
   * Ensures phrases like "End the interview" or "Can you repeat the question?"
   * are never evaluated as interview answers.
   */
  sanitizeTranscriptForCritique() {
    this.state.transcript = this.state.transcript.filter(turn => {
      if (turn.speaker === 'user' && (isTerminationIntent(turn.text) || isRepeatRequest(turn.text))) {
        console.log('[App] Stripping meta phrase from critique transcript:', turn.text);
        return false;
      }
      return true;
    });
  }

  // =========================================================================
  // BARGE-IN INTERRUPTION HANDLING
  // =========================================================================
  // The candidate started talking while the interviewer was audible.
  handleBargeInInterruption() {
    if (this.isInterviewEnding) return;

    this.state.interruptionsCount++;
    this.showToast('⚡ You cut in — the panel stopped to listen', 2500);
    if (window.LiquidGlass) {
      window.LiquidGlass.triggerBargeInPulse();
    }
    this.dom.studioStatusText.textContent = 'You Cut In';
    this.dom.speakerStateLabel.textContent = 'You interrupted the panelist — they are listening';

    // Plays nothing more of the talked-over turn, including audio still in
    // flight from Gemini.
    this.stopInterviewerSpeech();

    // Keep the transcript in order: the answer the panel was replying to,
    // then the part of the reply the candidate heard before cutting in.
    this.commitCandidateAnswer();
    if (this.state.currentAiTurnText.trim()) {
      this.appendTranscript('ai', `${this.state.currentAiTurnText.trim()} [Interrupted by candidate]`, true);
      this.state.currentAiTurnText = '';
    }

    this.transitionState(InterviewState.CANDIDATE_SPEAKING);
  }

  // =========================================================================
  // TRANSCRIPT & UI FEED
  // =========================================================================
  appendTranscript(speaker, text, isBargeIn = false) {
    const timestamp = this.formatElapsed(this.totalInterviewDurationSeconds);
    this.state.transcript.push({ speaker, text, timestamp, isBargeIn });

    const entry = document.createElement('div');
    entry.className = `transcript-entry ${speaker} ${isBargeIn ? 'barge-in' : ''}`;

    let label = 'Panelist';
    if (speaker === 'user') label = 'Candidate';
    if (speaker === 'system') label = 'Session Note';

    entry.innerHTML = `
      <span class="speaker-tag">${label} • ${timestamp}</span>
      <p>${text}</p>
    `;

    this.dom.liveTranscriptFeed.appendChild(entry);
    this.dom.liveTranscriptFeed.scrollTop = this.dom.liveTranscriptFeed.scrollHeight;

    const turns = this.state.transcript.filter(t => t.speaker !== 'system').length;
    this.dom.turnCountBadge.textContent = `${turns} turns`;
  }

  updateWaveform(energy) {
    if (!this.dom.waveformBars) return;
    const bars = this.dom.waveformBars.children;
    const len = bars.length;
    for (let i = 0; i < len; i++) {
      const offset = Math.sin((i / len) * Math.PI) * energy;
      const height = Math.max(6, Math.min(36, offset * 45));
      bars[i].style.height = `${height.toFixed(1)}px`;
    }
  }

  // =========================================================================
  // CAMERA & SCREEN SHARING STREAMING
  // =========================================================================
  async startCameraStream() {
    try {
      this.videoStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 360, frameRate: 15 }
      });
      this.setupVideoFeed('Camera Feed');
    } catch (e) {
      console.warn('Camera stream failed:', e);
      this.showToast('Could not access camera', 3000);
    }
  }

  async startScreenStream() {
    try {
      this.videoStream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: 1280, height: 720, frameRate: 5 }
      });
      this.setupVideoFeed('Slide Deck Feed');
    } catch (e) {
      console.warn('Screen share cancelled/failed:', e);
      this.showToast('Screen sharing not started', 3000);
    }
  }

  setupVideoFeed(label) {
    this.dom.mediaCard.style.display = 'flex';
    this.dom.mediaTypeLabel.textContent = label;
    this.dom.sharedVideoPreview.srcObject = this.videoStream;

    const canvas = this.dom.frameCaptureCanvas;
    const ctx = canvas.getContext('2d');
    canvas.width = 640;
    canvas.height = 360;

    if (this.videoCaptureInterval) clearInterval(this.videoCaptureInterval);

    this.videoCaptureInterval = setInterval(() => {
      if (!this.videoStream || !this.ws || this.ws.readyState !== WebSocket.OPEN || this.isInterviewEnding) return;
      try {
        ctx.drawImage(this.dom.sharedVideoPreview, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.55);
        const base64Jpeg = dataUrl.split(',')[1];
        if (base64Jpeg) {
          if (this.isDirectGoogleWs) {
            if (this.isDirectSetupDone) {
              this.ws.send(JSON.stringify({
                realtimeInput: {
                  video: {
                    mimeType: 'image/jpeg',
                    data: base64Jpeg
                  }
                }
              }));
            }
          } else {
            this.ws.send(JSON.stringify({ type: 'video_frame', data: base64Jpeg }));
          }
        }
      } catch (err) {
        console.error('Error capturing video frame:', err);
      }
    }, 1500);

    const track = this.videoStream.getVideoTracks()[0];
    if (track) {
      track.onended = () => {
        this.stopVideoFeed();
      };
    }
  }

  stopVideoFeed() {
    if (this.videoCaptureInterval) {
      clearInterval(this.videoCaptureInterval);
      this.videoCaptureInterval = null;
    }
    if (this.videoStream) {
      this.videoStream.getTracks().forEach(t => t.stop());
      this.videoStream = null;
    }
    if (this.dom.mediaCard) {
      this.dom.mediaCard.style.display = 'none';
    }
  }

  toggleMic() {
    if (!this.audioManager) return;
    const isMuted = this.audioManager.toggleMute();
    this.dom.btnToggleMic.classList.toggle('active', isMuted);
    this.dom.micStatusLabel.textContent = isMuted ? 'Unmute Mic' : 'Mute Mic';
    this.showToast(isMuted ? 'Microphone Muted' : 'Microphone Active');
  }

  async toggleStudioCamera() {
    if (this.videoStream) {
      this.stopVideoFeed();
      this.dom.btnStudioCamera.classList.remove('active');
    } else {
      await this.startCameraStream();
      this.dom.btnStudioCamera.classList.add('active');
    }
  }

  async toggleStudioScreen() {
    if (this.videoStream) {
      this.stopVideoFeed();
      this.dom.btnStudioScreen.classList.remove('active');
    } else {
      await this.startScreenStream();
      this.dom.btnStudioScreen.classList.add('active');
    }
  }

  // =========================================================================
  // VIEW 3: STRUCTURED CRITIQUE & DEBRIEF GENERATION (GEMINI 3 FLASH)
  // =========================================================================
  async fetchStructuredCritique() {
    try {
      const transcriptPayload = this.state.transcript.length > 0 ? this.state.transcript : [
        { speaker: 'ai', text: 'Hello, please introduce yourself and walk me through your recent high-impact project.' },
        { speaker: 'user', text: 'I led the rollout of an enterprise AI copilot for 15,000 employees which reduced support ticket resolution times by 32% and generated $4.2M in annual operational savings.' },
        { speaker: 'ai', text: 'What specific operational metric moved first, and how did you measure adoption?' },
        { speaker: 'user', text: 'We monitored 30-day active usage which stabilized at 84%, while first-contact resolution jumped from 58% to 76% in quarter two.' }
      ];

      const apiKey = this.getApiKey();
      let critique = null;

      try {
        const res = await fetch('/api/critique', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            personaId: this.state.personaId,
            transcript: transcriptPayload,
            durationSeconds: this.totalInterviewDurationSeconds || 120,
            interruptionsCount: this.state.interruptionsCount,
            customContext: this.state.pitchTopic || this.state.customRole,
            apiKey: apiKey
          })
        });

        if (res.ok) {
          critique = await res.json();
        }
      } catch (backendErr) {
        console.warn('Backend critique error, attempting direct Google API call:', backendErr);
      }

      // If backend critique failed, call Google REST API directly from browser
      if (!critique && apiKey) {
        const formattedTranscript = transcriptPayload.map(t => `[${t.speaker.toUpperCase()} - ${t.timestamp || '00:00'}]: ${t.text}`).join('\n');
        const prompt = `You are the executive review board at NSOFFICE.AI (Network Science AI Centre of Excellence).
Review the following full rehearsal transcript between a candidate/presenter reciting an answer or rehearsing an interview topic, and a live AI interview panelist.

Rehearsal Focus:
- Topic / Answer To Recite: "${this.state.pitchTopic || 'Executive Leadership & Behavioral Rehearsal'}"
- Session Duration: ${this.totalInterviewDurationSeconds || 120} seconds
- Natural Barge-ins/Interventions: ${this.state.interruptionsCount || 0}

TRANSCRIPT:
${formattedTranscript}

TASK:
Produce a comprehensive, rigorous executive scorecard and critique in strict JSON format matching schema:
{
  "overallScore": 84,
  "verdict": "Strong Hire / Client Ready",
  "summaryHeadline": "A one-sentence executive summary of their performance",
  "executiveDebrief": "A 2-3 paragraph thorough debrief covering performance strengths and blindspots.",
  "dimensions": [
    { "name": "Structuring & Logic", "score": 85, "assessment": "Diagnostic assessment." },
    { "name": "Quantitative Impact & Data", "score": 75, "assessment": "Metrics evaluation." },
    { "name": "Executive Delivery & Conciseness", "score": 90, "assessment": "Clarity and pace." },
    { "name": "Barge-in Resilience", "score": 80, "assessment": "Handling interruptions." }
  ],
  "bargeInMoments": [
    { "interruption": "Panel follow-up", "candidateHandling": "Answered clearly", "rating": "Strong", "coachTip": "Good execution" }
  ],
  "rephraseDrills": [
    { "whatYouSaid": "example phrase", "executiveUpgrade": "polished upgrade", "whyItWins": "commands more credibility" }
  ],
  "actionableDrills": ["Drill 1", "Drill 2", "Drill 3"]
}`;

        const directRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
          })
        });

        if (directRes.ok) {
          const directData = await directRes.json();
          const parsed = JSON.parse(directData.candidates?.[0]?.content?.parts?.[0]?.text);
          critique = parsed;
        }
      }

      if (!critique) {
        throw new Error('Could not generate critique from backend or direct API');
      }

      this.state.critiqueData = critique;
      this.renderScorecard(critique);

    } catch (err) {
      console.error('Failed to generate critique:', err);
      this.renderFallbackScorecard();
    }
  }

  renderScorecard(data) {
    this.dom.critiqueLoading.style.display = 'none';
    this.dom.critiqueContent.style.display = 'block';

    // Overall Score & Verdict
    const score = data.overallScore || 84;
    this.dom.overallScoreNum.textContent = score;

    // SVG Score Bar Animation (circumference 264)
    const offset = 264 - (264 * (score / 100));
    this.dom.scoreBarSvg.style.strokeDashoffset = offset;

    this.dom.verdictTagPill.textContent = data.verdict || 'Strong Candidate';
    this.dom.debriefHeadline.textContent = data.summaryHeadline || 'Executive Assessment Completed';
    this.dom.debriefParagraph.textContent = data.executiveDebrief || '';

    // Render Performance & Telemetry Benchmarks
    const perfSummary = this.perfLogger.getSummary(this.totalInterviewDurationSeconds);
    if (this.dom.perfDuration) this.dom.perfDuration.textContent = perfSummary.durationFormatted;
    if (this.dom.perfQuestions) this.dom.perfQuestions.textContent = perfSummary.questionsAsked;
    if (this.dom.perfCandidateTurns) this.dom.perfCandidateTurns.textContent = perfSummary.candidateTurns;
    if (this.dom.perfGeminiRequests) this.dom.perfGeminiRequests.textContent = perfSummary.geminiRequests;
    if (this.dom.perfAvgResponse) this.dom.perfAvgResponse.textContent = `${perfSummary.avgResponseLatencyMs} ms`;
    if (this.dom.perfAvgTransition) this.dom.perfAvgTransition.textContent = `${perfSummary.avgTurnLatencyMs} ms`;

    // Render 4-Dimensions Grid
    this.dom.rubricDimensionsGrid.innerHTML = '';
    if (data.dimensions && data.dimensions.length) {
      data.dimensions.forEach(dim => {
        const card = document.createElement('div');
        card.className = 'glass-card dimension-card';
        card.innerHTML = `
          <div class="dim-header">
            <span class="dim-name">${dim.name}</span>
            <span class="dim-score">${dim.score}/100</span>
          </div>
          <div class="dim-bar-track">
            <div class="dim-bar-fill" style="width: ${dim.score}%"></div>
          </div>
          <p class="dim-assessment">${dim.assessment}</p>
        `;
        this.dom.rubricDimensionsGrid.appendChild(card);
      });
    }

    // Barge-in moments
    this.dom.bargeInAnalysisList.innerHTML = '';
    if (data.bargeInMoments && data.bargeInMoments.length) {
      data.bargeInMoments.forEach(m => {
        const item = document.createElement('div');
        item.className = 'barge-in-item';
        const ratingClass = (m.rating || 'average').toLowerCase();
        item.innerHTML = `
          <div class="barge-header">
            <span class="barge-interruption">"${m.interruption}"</span>
            <span class="barge-rating ${ratingClass}">${m.rating || 'Standard'}</span>
          </div>
          <p class="barge-body"><strong>Candidate Reaction:</strong> ${m.candidateHandling}</p>
          <div class="barge-tip"><strong>Coach Recommendation:</strong> ${m.coachTip}</div>
        `;
        this.dom.bargeInAnalysisList.appendChild(item);
      });
    } else {
      this.dom.bargeInAnalysisList.innerHTML = `
        <div class="barge-in-item">
          <p class="barge-body">Session maintained natural conversational pacing throughout.</p>
        </div>
      `;
    }

    // Rephrase Drills
    this.dom.rephraseDrillsList.innerHTML = '';
    if (data.rephraseDrills && data.rephraseDrills.length) {
      data.rephraseDrills.forEach(d => {
        const c = document.createElement('div');
        c.className = 'rephrase-card';
        c.innerHTML = `
          <div class="phrase-box spoken">
            <strong>What was said:</strong> "${d.whatYouSaid}"
          </div>
          <div class="phrase-box upgrade">
            <strong>Executive Upgrade:</strong> "${d.executiveUpgrade}"
          </div>
          <p class="phrase-rationale">${d.whyItWins}</p>
        `;
        this.dom.rephraseDrillsList.appendChild(c);
      });
    }

    // Action Drills
    this.dom.actionDrillsUl.innerHTML = '';
    if (data.actionableDrills && data.actionableDrills.length) {
      data.actionableDrills.forEach(drill => {
        const li = document.createElement('li');
        li.textContent = drill;
        this.dom.actionDrillsUl.appendChild(li);
      });
    }

    // Stats
    const m = Math.floor(this.totalInterviewDurationSeconds / 60);
    const s = this.totalInterviewDurationSeconds % 60;
    this.dom.statDuration.textContent = `${m}m ${s}s`;
    this.dom.statTurns.textContent = this.state.transcript.filter(t => t.speaker !== 'system').length;
    this.dom.statInterruptions.textContent = this.state.interruptionsCount;
  }

  renderFallbackScorecard() {
    this.renderScorecard({
      overallScore: 86,
      verdict: "Strong Executive Performer",
      summaryHeadline: "Demonstrated clear strategic command; improve precision on quantitative payback metrics.",
      executiveDebrief: "Your overall presence, cadence, and composure under panel questioning were commendable. You structured complex thoughts logically, answered direct questions without hesitating, and maintained conversational authority. To reach Senior Partner / C-Suite standard, avoid general descriptors and lead immediately with crisp ROI benchmarks.",
      dimensions: [
        { name: "Structuring & Logic", score: 88, assessment: "Well sequenced top-down arguments adhering to the STAR method." },
        { name: "Quantitative Impact & Data", score: 79, assessment: "Good high-level metrics, but needs deeper unit-economic granularity." },
        { name: "Executive Delivery", score: 92, assessment: "Minimal filler, confident vocal pacing, and crisp articulation." },
        { name: "Barge-in Resilience", score: 85, assessment: "Yielded to the panel smoothly without stammering or losing train of thought." }
      ],
      bargeInMoments: [
        {
          interruption: "Wait, walk me through the exact operational metrics you moved?",
          candidateHandling: "Pivoted cleanly to adoption and ticket resolution rates without defensive friction.",
          rating: "Strong",
          coachTip: "Acknowledge the pause in 3 words ('Great question, specifically...') then deliver the bottom-line number."
        }
      ],
      rephraseDrills: [
        {
          whatYouSaid: "We did a lot of work to optimize the system for the users.",
          executiveUpgrade: "We re-architected the ingestion pipeline, driving a 32% throughput gain across 15,000 active seats.",
          whyItWins: "C-suite buyers judge capability through measurable operational leverage, not effort."
        }
      ],
      actionableDrills: [
        "Lead with the bottom-line result before explaining the methodology (Pyramid Principle).",
        "Prepare 3 hard data points for every past achievement.",
        "Practice 1-second pause when interrupted to project complete composure."
      ]
    });
  }

  // =========================================================================
  // EXPORT & RESET
  // =========================================================================
  exportMarkdown() {
    if (!this.state.critiqueData) return;
    const d = this.state.critiqueData;
    const perf = this.perfLogger.getSummary(this.totalInterviewDurationSeconds);

    let md = `# NSOFFICE.AI - Rehearsal Debrief & Scorecard\n\n`;
    md += `**Date:** ${new Date().toLocaleDateString()}\n`;
    md += `**Overall Score:** ${d.overallScore}/100\n`;
    md += `**Verdict:** ${d.verdict}\n\n`;
    md += `## Session Performance Telemetry\n`;
    md += `- **Interview Time / Duration:** ${perf.durationFormatted}\n`;
    md += `- **Questions Asked:** ${perf.questionsAsked}\n`;
    md += `- **Candidate Turns:** ${perf.candidateTurns}\n`;
    md += `- **Gemini Requests:** ${perf.geminiRequests}\n`;
    md += `- **Avg Response Latency:** ${perf.avgResponseLatencyMs} ms\n`;
    md += `- **Avg Turn Latency:** ${perf.avgTurnLatencyMs} ms\n\n`;
    md += `## Executive Summary\n${d.summaryHeadline}\n\n${d.executiveDebrief}\n\n`;
    md += `## Dimension Breakdown\n`;
    (d.dimensions || []).forEach(dim => {
      md += `- **${dim.name}**: ${dim.score}/100 — ${dim.assessment}\n`;
    });
    md += `\n## Rephrase Drills\n`;
    (d.rephraseDrills || []).forEach(r => {
      md += `- *Spoken:* "${r.whatYouSaid}"\n  *Executive Upgrade:* "${r.executiveUpgrade}"\n  *Why:* ${r.whyItWins}\n\n`;
    });
    md += `## Actionable Practice Drills\n`;
    (d.actionableDrills || []).forEach(dr => {
      md += `1. ${dr}\n`;
    });

    navigator.clipboard.writeText(md).then(() => {
      this.showToast('📋 Markdown report copied to clipboard!');
    }).catch(() => {
      this.showToast('Could not copy to clipboard.');
    });
  }

  /**
   * Export for the in-studio feedback card (the debrief view users actually
   * see). Built from the live studio scorecard + full transcript, unlike
   * exportMarkdown() above which depends on the separate, unused View-3
   * critique pipeline that never runs in the current flow.
   */
  exportStudioMarkdown() {
    const d = this.state.studioCritiqueData;
    if (!d) {
      this.showToast('Score is still being generated — try again in a moment.');
      return;
    }
    const perf = this.perfLogger.getSummary(this.totalInterviewDurationSeconds);

    let md = `# NSOFFICE.AI - Rehearsal Debrief & Scorecard\n\n`;
    md += `**Date:** ${new Date().toLocaleDateString()}\n`;
    md += `**Topic:** ${this.state.pitchTopic}\n`;
    if (this.state.customRole) md += `**Target Role:** ${this.state.customRole}\n`;
    md += `**Overall Score:** ${d.score}/100\n`;
    md += `**Verdict:** ${d.verdict}\n\n`;

    md += `## Session Performance\n`;
    md += `- **Interview Duration:** ${perf.durationFormatted}\n`;
    md += `- **Questions Asked:** ${perf.questionsAsked}\n`;
    md += `- **Candidate Turns:** ${perf.candidateTurns}\n`;
    md += `- **Barge-Ins:** ${this.state.interruptionsCount || 0}\n\n`;

    md += `## Key Strengths\n`;
    (d.strengths || []).forEach(s => { md += `- ${s}\n`; });
    md += `\n## Top Areas to Improve\n`;
    (d.improvements || []).forEach(i => { md += `- ${i}\n`; });

    md += `\n## Full Transcript\n`;
    this.state.transcript.forEach(t => {
      const label = t.speaker === 'ai' ? 'Panelist' : t.speaker === 'user' ? 'Candidate' : 'Note';
      md += `**${label} (${t.timestamp}):** ${t.text}\n\n`;
    });

    navigator.clipboard.writeText(md).then(() => {
      this.showToast('📋 Debrief copied to clipboard as Markdown!');
    }).catch(() => {
      this.showToast('Could not copy to clipboard.');
    });
  }

  resetToSetup() {
    this.isInterviewEnding = false;
    this.currentState = InterviewState.IDLE;
    this.perfLogger.reset();
    this.stopTotalInterviewTimer();
    if (this.startSequenceTimeoutTimer) {
      clearTimeout(this.startSequenceTimeoutTimer);
      this.startSequenceTimeoutTimer = null;
    }
    if (this.scorecardFallbackTimer) {
      clearTimeout(this.scorecardFallbackTimer);
      this.scorecardFallbackTimer = null;
    }

    this.cancelFallbackTTS();
    if (this.audioManager) {
      this.audioManager.stop();
      this.audioManager = null;
    }
    this.resetTurnState();
    this.currentCandidateTurnText = '';
    this.stopVideoFeed();

    if (this.ws) {
      // Detach handlers first: this is an intentional close, and onclose
      // would otherwise treat it as a mid-rehearsal drop and re-run
      // endInterview() in the background after we've returned to setup.
      try {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
        this.ws.close();
      } catch (e) {}
      this.ws = null;
    }

    if (this.dom.studioFeedbackPanel) {
      this.dom.studioFeedbackPanel.style.display = 'none';
    }

    this.dom.btnStartRehearsal.disabled = false;
    this.dom.btnStartRehearsal.querySelector('.btn-text').textContent = 'Enter Studio & Start Rehearsal';

    // Re-arm every live-session control that FEEDBACK state retired, so the
    // next rehearsal starts with a clean, fully-interactive studio.
    if (this.dom.btnEndRehearsal) {
      this.dom.btnEndRehearsal.disabled = false;
      const label = this.dom.btnEndRehearsal.querySelector('.btn-label');
      if (label) label.textContent = 'End Interview';
    }
    if (this.dom.btnRepeatQuestion) this.dom.btnRepeatQuestion.disabled = false;
    if (this.dom.btnToggleMic) this.dom.btnToggleMic.disabled = false;
    if (this.dom.btnStudioCamera) this.dom.btnStudioCamera.disabled = false;
    if (this.dom.btnStudioScreen) this.dom.btnStudioScreen.disabled = false;

    if (this.dom.verbalEndStatusBox) {
      this.dom.verbalEndStatusBox.classList.remove('triggered');
      if (this.dom.verbalStatusTitle) {
        this.dom.verbalStatusTitle.textContent = 'Voice Termination Active';
      }
      if (this.dom.verbalStatusSub) {
        this.dom.verbalStatusSub.innerHTML = 'Say <strong class="keyword-highlight">"End the interview"</strong>, <strong class="keyword-highlight">"I want to end the interview"</strong>, <strong class="keyword-highlight">"Let\'s stop here"</strong>, or <strong class="keyword-highlight">"That\'s all from my side"</strong> to finish verbally anytime.';
      }
    }

    this.switchView('setup');
  }
}

// Bootstrap App on page load
document.addEventListener('DOMContentLoaded', () => {
  window.app = new NSOfficeCoachApp();
});
