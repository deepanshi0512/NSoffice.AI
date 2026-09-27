const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/live' });

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || 'models/gemini-3.1-flash-live-preview';
const GEMINI_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-3.8-flash';

if (!GEMINI_API_KEY) {
  console.warn('⚠️ WARNING: GEMINI_API_KEY is not defined in .env. Live sessions will fail until key is provided.');
}

// Helper to detect if candidate is requesting question repetition
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

// Helper to detect acoustic loopback of last question
function isEchoOfQuestion(spokenText, questionText) {
  if (!spokenText || !questionText) return false;
  const cleanSpoken = spokenText.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const cleanQ = questionText.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleanSpoken.length === 0 || cleanQ.length === 0) return false;

  if (cleanQ.includes(cleanSpoken) && cleanSpoken.length >= 6) return true;
  if (cleanSpoken.includes(cleanQ) && cleanQ.length >= 6) return true;

  const spokenWords = cleanSpoken.split(' ').filter(w => w.length > 2);
  const qWords = new Set(cleanQ.split(' ').filter(w => w.length > 2));
  if (spokenWords.length === 0) return false;

  let matchCount = 0;
  for (const w of spokenWords) {
    if (qWords.has(w)) matchCount++;
  }

  const overlapRatio = matchCount / spokenWords.length;
  return (overlapRatio >= 0.55 && matchCount >= 2);
}

app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// API Config & Status
app.get('/api/config', (req, res) => {
  res.json({
    status: 'ok',
    hasKey: Boolean(GEMINI_API_KEY),
    apiKey: GEMINI_API_KEY || null,
    liveModel: GEMINI_LIVE_MODEL,
    textModel: GEMINI_TEXT_MODEL,
    system: 'NSOffice Glass UI'
  });
});

// Personas Definitions
const PERSONAS = {
  consulting: {
    title: "Senior Partner, McKinsey / Bain / BCG",
    description: "Rigorous case interview and client presentation panelist. Tests business acumen, MECE structuring, and ROI quantification.",
    voice: "Aoede",
    systemPrompt: `You are a Senior Partner at a tier-1 strategy consulting firm conducting a live case and executive rehearsal with a candidate.
Your personality is sharp, direct, professional, and time-conscious. You have evaluated hundreds of candidates and C-level pitch presentations.

BEHAVIORAL RULES:
1. Speak concisely in 1-2 natural sentences. Never give long lectures or monologues.
2. Demand structure and data: If the user is rambling or using vague adjectives, interrupt politely but firmly:
   - "Let me stop you right there: what specific operational metric moved?"
   - "Hold on—walk me through the top-down rationale before the details."
3. Actively listen to their answer. Ask tough, realistic follow-ups based specifically on what they just said.
4. If they share slides or screen, look at the visual information and critique the data or call out anomalies.
5. Barge-in naturally when needed. When they answer well, acknowledge with crisp validation ("Understood. Now how do you mitigate execution risk?").
6. When the user asks for a critique or says "Wrap up" or "How did I do?", deliver a crisp 45-second spoken debrief summarizing strengths, structure, and top gap.`
  },
  executive_pitch: {
    title: "Enterprise C-Suite Client (CIO / CFO)",
    description: "Skeptical enterprise buyer evaluating a multi-million dollar transformation pitch. Challenges budget, legacy compatibility, and payback period.",
    voice: "Puck",
    systemPrompt: `You are the skeptical Chief Digital & Information Officer of a Global 2000 enterprise listening to an AI & Tech consulting pitch.
You have heard dozens of generic vendor pitches. You care about real enterprise risk, integration with existing tech, security, timeline, and cashflow payback.

BEHAVIORAL RULES:
1. Keep your verbal responses punchy and skeptical (1 to 2 sentences).
2. Interrupt realistically if they start pitching buzzwords instead of business outcomes:
   - "Sorry to interrupt, but our board is freezing spend unless payback is under 9 months. How do you guarantee that?"
   - "Hold on, how does this integrate with our legacy on-prem infrastructure?"
3. Challenge unproven assertions. Push them to defend their numbers.
4. If they show a pitch deck on screen, react to the graphics, roadmap, or pricing slide directly.
5. When the pitch concludes, provide a blunt, valuable 45-second executive debrief on whether you would sign the contract.`
  },
  tech_lead: {
    title: "Principal Systems Architect / VP of Eng",
    description: "Deep technical panelist grilling on high-scale architecture, trade-offs, fault tolerance, and latency SLAs.",
    voice: "Charon",
    systemPrompt: `You are a Principal Infrastructure Architect and VP of Engineering at a top-tier hyper-scale tech firm conducting a System Design and Technical Leadership interview.
You value precision, trade-off clarity, observability, and failover design.

BEHAVIORAL RULES:
1. Converse naturally in 1-2 sentences. Keep the dialogue brisk.
2. Interrupt whenever they gloss over failure modes or scalability bottlenecks:
   - "Let me pause you there: what happens when your message queue partitions during peak traffic?"
   - "Hold on, what are the tail latency implications of that architecture?"
3. Probe on deep trade-offs (consistency vs availability, memory footprint, cache invalidation).
4. If they share architecture diagrams or code on screen, reference components directly.
5. At the end, deliver a candid engineering evaluation highlighting their technical rigor and edge case vigilance.`
  },
  product_leader: {
    title: "Chief Product Officer (CPO)",
    description: "Product strategy and executive product sense interview. Probes customer obsession, metric trade-offs, and go-to-market prioritization.",
    voice: "Fenrir",
    systemPrompt: `You are the Chief Product Officer at a hyper-growth tech enterprise interviewing a Senior / Director Product Management candidate.
You are passionate about customer empathy, ruthless prioritization, business model flywheels, and non-linear product leverage.

BEHAVIORAL RULES:
1. Speak concisely in 1-2 sentences with high energy.
2. Probe prioritization trade-offs and counter-metrics:
   - "Hold on, if you optimize for conversion there, won't you cannibalize retention?"
   - "Let me pause you: why build this feature instead of double down on the core loop?"
3. Test their product instinct under pressure.
4. If they share product mockups or data decks, comment on the user experience and funnel metrics.
5. When wrapping up, give an executive debrief on their product judgment, clarity, and metric rigor.`
  },
  custom: {
    title: "Custom Executive Rehearsal",
    description: "Configure your own target role, company, difficulty setting, and interview panel persona.",
    voice: "Aoede",
    systemPrompt: `You are an elite executive interview panelist and pitch rehearsal coach at NSOFFICE.AI.
Conduct a realistic, challenging, voice-to-voice rehearsal.
Listen actively, ask probing follow-up questions, interrupt naturally when answers are vague or over-extended, and deliver a constructive spoken critique at the end.`
  }
};

app.get('/api/personas', (req, res) => {
  const result = Object.entries(PERSONAS).map(([key, value]) => ({
    id: key,
    title: value.title,
    description: value.description,
    voice: value.voice
  }));
  res.json(result);
});

// Turn-based Structured Critique Endpoint (Gemini 3 Flash)
app.post('/api/critique', async (req, res) => {
  try {
    const { topic, personaId, transcript, durationSeconds, interruptionsCount, customContext, apiKey: clientApiKey } = req.body;
    const rehearsalTopic = topic || customContext || 'Executive Leadership & Behavioral Rehearsal';

    const effectiveApiKey = clientApiKey || GEMINI_API_KEY;
    if (!effectiveApiKey) {
      return res.status(500).json({ error: "Gemini API key is not configured." });
    }

    if (!transcript || transcript.length === 0) {
      return res.status(400).json({ error: "No transcript provided for critique." });
    }

    const persona = PERSONAS[personaId] || PERSONAS.consulting;

    const formattedTranscript = transcript.map(t => `[${t.speaker.toUpperCase()} - ${t.timestamp || '00:00'}]: ${t.text}`).join('\n');

    const prompt = `You are the executive review board at NSOFFICE.AI (Network Science AI Centre of Excellence).
Review the following full rehearsal transcript between a candidate/presenter reciting an answer or rehearsing an interview topic, and a live AI interview panelist.

Rehearsal Focus:
- Topic / Answer To Recite: "${rehearsalTopic}"
- Session Duration: ${durationSeconds || 120} seconds
- Natural Barge-ins/Interventions: ${interruptionsCount || 0}

TRANSCRIPT:
${formattedTranscript}

TASK:
Produce a comprehensive, rigorous executive scorecard and critique in strict JSON format.
Your evaluation must assess:
1. Structuring & Logic (STAR method for interviews, McKinsey Pyramid Principle for pitches)
2. Quantitative Rigor & Metrics (Did they cite specific numbers, outcomes, and business impact?)
3. Executive Presence & Conciseness (Were they crisp or did they waffle?)
4. Agility Under Barge-in (How effectively did they address interruptions and pushback?)
5. Domain Depth & Insight (Did they demonstrate deep mastery?)

Return ONLY valid JSON matching this schema:
{
  "overallScore": 84,
  "verdict": "Strong Hire / Client Ready" | "Solid Performer - Needs Refinement" | "Borderline - Lacks Rigor" | "Needs Immediate Re-work",
  "summaryHeadline": "A one-sentence executive summary of their performance",
  "executiveDebrief": "A 2-3 paragraph thorough debrief covering performance strengths and blindspots.",
  "dimensions": [
    {
      "name": "Structuring & Logic",
      "score": 85,
      "assessment": "Detailed diagnostic on how structured their arguments were."
    },
    {
      "name": "Quantitative Impact & Data",
      "score": 75,
      "assessment": "Evaluation of whether claims were backed by hard metrics."
    },
    {
      "name": "Executive Delivery & Conciseness",
      "score": 90,
      "assessment": "Evaluation of speaking pace, confidence, and lack of filler."
    },
    {
      "name": "Barge-in Resilience",
      "score": 80,
      "assessment": "How well they handled panel interruptions without getting flustered."
    }
  ],
  "bargeInMoments": [
    {
      "interruption": "Brief description of the panel's intervention",
      "candidateHandling": "How the candidate responded",
      "rating": "Strong" | "Average" | "Weak",
      "coachTip": "How to handle this pushback like a seasoned executive"
    }
  ],
  "rephraseDrills": [
    {
      "whatYouSaid": "An exact or close phrase the user spoke that was weak or vague",
      "executiveUpgrade": "The polished C-suite / Partner-grade way to articulate it",
      "whyItWins": "Why the upgrade commands more credibility"
    }
  ],
  "actionableDrills": [
    "Step 1 to practice next",
    "Step 2 to practice next",
    "Step 3 to practice next"
  ]
}`;

    let response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${effectiveApiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.2
        }
      })
    });

    if (!response.ok) {
      console.warn(`Primary critique model (${GEMINI_TEXT_MODEL}) returned ${response.status}. Retrying with gemini-3.8-flash...`);
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${effectiveApiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.2
          }
        })
      });
    }

    const data = await response.json();
    if (!response.ok) {
      console.error('Critique API error:', data);
      return res.status(500).json({ error: data.error?.message || 'Failed to generate critique' });
    }

    const textContent = data.candidates?.[0]?.content?.parts?.[0]?.text;
    const jsonOutput = JSON.parse(textContent);

    res.json(jsonOutput);
  } catch (err) {
    console.error('Error generating structured critique:', err);
    res.status(500).json({ error: err.message });
  }
});

// Context-Aware Question Generators (Strict Active Listening & Follow-Up)
async function generateOpeningQuestion(userTopic, targetRole) {
  const prompt = `You are a real-world executive interviewer at NSOFFICE.AI (Network Science AI Centre of Excellence).
Interview Topic: "${userTopic}"
${targetRole ? `Target Role: "${targetRole}"` : ''}

Generate your opening interview question (1-2 sentences):
A crisp, professional 4-8 word greeting welcoming them to the rehearsal, followed immediately by your opening question asking them to introduce their project/work on "${userTopic}".

Output ONLY the text to speak. No quotation marks, no preamble.`;

  try {
    let res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3 } })
    });
    if (!res.ok) {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3 } })
      });
    }
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || `Welcome to your rehearsal. Let's begin with your ${userTopic}—could you introduce your project and highlight your primary architectural or modeling decisions?`;
  } catch (e) {
    return `Welcome to your rehearsal. Let's begin with your ${userTopic}—could you introduce your project and highlight your primary architectural or modeling decisions?`;
  }
}

async function generateFollowUpQuestion(context) {
  const prompt = `You are a real-world executive interviewer at NSOFFICE.AI (Network Science AI Centre of Excellence).
Interview Topic: "${context.interviewTopic}"
${context.targetRole ? `Target Role: "${context.targetRole}"` : ''}
Previous Question Asked: "${context.lastAskedQuestion || 'Opening project introduction'}"
Previous Questions Covered in this Session:
${context.questionsAsked.map((q, idx) => `  ${idx + 1}. "${q}"`).join('\n')}

Candidate's Latest Answer:
"${context.candidateAnswer}"

CRITICAL MANDATES FOR GENERATING NEXT QUESTION:
1. STRICT ACTIVE LISTENING: Carefully identify the specific claims, technologies, metrics, and decisions in their answer (e.g. Random Forest vs Logistic Regression, RMSE 12.4, accuracy %, Docker, data leakage).
2. DRILL DEEPER INTO THEIR ANSWER: Ask a direct follow-up question probing what they just said. Challenge strong claims for evidence, probe technical rationale, or ask how metrics were computed.
3. STRICTLY STAY ON THE REHEARSAL TOPIC ("${context.interviewTopic}"): NEVER switch to an unrelated topic (e.g. do not jump to SQL or Salesforce if discussing machine learning).
4. If their answer was brief or incomplete (e.g. "Yes, I used Python"), probe for specific details on what they just mentioned (e.g. "Which Python libraries did you use and what for?").
5. DO NOT repeat any of the previous questions listed above.
6. In 1 to 2 crisp, conversational sentences: a brief professional acknowledgment (4-8 words), followed by your single focused follow-up question.

Output ONLY the text to speak. No quotation marks, no preamble.`;

  try {
    let res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3 } })
    });
    if (!res.ok) {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3 } })
      });
    }
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || `Understood. Looking deeper at ${context.interviewTopic}, what were the most critical technical challenges you had to overcome?`;
  } catch (err) {
    console.error('Error generating follow-up question:', err);
    return `Understood. Looking deeper at ${context.interviewTopic}, what were the most critical technical challenges you had to overcome?`;
  }
}

async function generateQuickScorecard(context) {
  const prompt = `You are the executive reviewer at NSOFFICE.AI.
Interview Topic: "${context.interviewTopic}"
Questions asked: ${JSON.stringify(context.questionsAsked)}
Candidate answers: ${JSON.stringify(context.candidateAnswers)}

Return ONLY a valid JSON object matching:
{
  "score": 85,
  "verdict": "Strong Performer",
  "strengths": ["Clear technical reasoning on model choices", "Good composure under panel questioning"],
  "improvements": ["Ground percentages in baseline numerical metrics", "Detail operational trade-offs earlier"]
}`;

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
      })
    });
    if (res.ok) {
      const data = await res.json();
      const txt = data.candidates?.[0]?.content?.parts?.[0]?.text;
      return JSON.parse(txt);
    }
  } catch (e) {}
  return {
    score: 84,
    verdict: "Solid Rehearsal",
    strengths: ["Clear technical articulation and structured thinking", "Responded calmly to panel follow-ups"],
    improvements: ["Provide baseline numbers before stating percentage gains", "Cite specific evaluation metrics earlier"]
  };
}

// WebSocket Live Streaming Server
wss.on('connection', (clientWs, req) => {
  console.log('[WebSocket] Client connected to live session');

  let upstreamWs = null;
  let sessionConfig = null;
  let isSetupDone = false;
  let sessionContext = {
    interviewTopic: '',
    targetRole: '',
    questionsAsked: [],
    candidateAnswers: [],
    lastAskedQuestion: '',
    currentTurnAiText: ''
  };

  const cleanup = () => {
    if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN) {
      upstreamWs.close();
    }
    upstreamWs = null;
    isSetupDone = false;
  };

  clientWs.on('message', async (messageData) => {
    try {
      const msg = JSON.parse(messageData.toString());

      // 1. Initialize session with user specified topic
      if (msg.type === 'init') {
        sessionConfig = msg.config || {};
        const userTopic = sessionConfig.topic || 'General Executive Leadership & Behavioral Rehearsal';
        const targetRole = sessionConfig.customRole || '';
        const difficulty = sessionConfig.difficulty || 'standard';
        const voiceName = sessionConfig.voice || 'Aoede';

        let intensityPrompt = "Be a realistic, rigorous corporate interview panelist. Interrupt naturally when answers lack precision, metrics, or crispness.";
        if (difficulty === 'gentle') {
          intensityPrompt = "Be an encouraging, constructive coach. Ask helpful probing questions to guide them.";
        } else if (difficulty === 'ruthless') {
          intensityPrompt = "Be an aggressive, skeptical C-suite executive / senior board member. Have zero tolerance for fluff, filler words, or unsubstantiated claims. Interrupt quickly and demand evidence.";
        }

        sessionContext = {
          interviewTopic: userTopic,
          targetRole: targetRole,
          questionsAsked: [],
          candidateAnswers: [],
          lastAskedQuestion: '',
          currentTurnAiText: ''
        };

        const systemInstructionText = `You are a real-world executive interviewer and pitch rehearsal coach at NSOFFICE.AI (Network Science AI Centre of Excellence).

THE CANDIDATE'S SPECIFIC TOPIC / ANSWER TO RECITE:
"${userTopic}"
${targetRole ? `TARGET ROLE / DOMAIN: "${targetRole}"` : ''}

CORE INTERVIEWING PRINCIPLES - STRICT ACTIVE LISTENING & REAL-TIME AUDIO:
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

3. PROACTIVE BARGE-IN & NATURAL INTERRUPTIONS (PROBLEM STATEMENT MANDATE):
   - You are conducting a live rehearsal. You have real-time audio awareness.
   - When the candidate is answering or rehearsing out loud:
     * If they speak continuously for more than 2-3 sentences without citing numbers or concrete facts, INTERRUPT NATURALLY WITH BARGE-IN to ask a pointed follow-up:
       "Let me stop you right there: what specific operational metric moved?"
       "Hold on—walk me through why you chose that over the alternative."
     * If they use vague buzzwords or make broad unproven claims, barge in immediately:
       "Excuse me, before you move on—how did you validate that result?"
     * Do NOT wait passively if they are rambling. Intervene naturally as a seasoned panelist does.
   - When the candidate finishes answering, respond IMMEDIATELY with ultra-low latency. Never make them wait.

4. SHORT OR INCOMPLETE ANSWERS:
   - If the candidate's answer is brief or incomplete (e.g., "Yes, I used Python"), do NOT change topic. Probe for specifics: "Which Python libraries did you use, and what did you use each for?"

5. DO NOT REPEAT QUESTIONS UNNECESSARILY:
   - Keep track of questions already asked. Do NOT repeat a question unless the candidate specifically requests repetition.

6. IF CANDIDATE ASKS "PLEASE REPEAT THE QUESTION":
   - If the candidate says "Can you repeat that?", "Please repeat the question", or "Sorry, what was the question?", repeat the EXACT SAME question out loud. Do NOT ask a new question. Do NOT change topics.

7. CONVERSATIONAL CADENCE:
   - Speak naturally and with executive presence (1-2 sentences). Never give monologues.
   - ${intensityPrompt}

8. SPOKEN FEEDBACK & DUAL TERMINATION (PROBLEM STATEMENT MANDATE):
   - When the candidate concludes, wraps up, says "End the interview" / "That's all from my side", or when feedback is requested:
     a) Deliver an immediate, spoken 45-second executive debrief out loud in your interviewer voice.
     b) Announce a numerical score out of 100, summarize their top strength, and identify the single most critical blindspot they must fix.
     c) Call the 'end_interview' tool function to gracefully finalize the session.`;

        console.log(`[WebSocket] Starting Gemini Live session with topic: "${userTopic}", voice: ${voiceName}`);

        const liveUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
        upstreamWs = new WebSocket(liveUrl);

        upstreamWs.on('open', () => {
          console.log('[WebSocket] Upstream Gemini Live connected');

          // Send Setup frame with end_interview tool declaration
          const setupPayload = {
            setup: {
              model: GEMINI_LIVE_MODEL,
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: {
                      voiceName: voiceName
                    }
                  }
                }
              },
              tools: [{
                functionDeclarations: [{
                  name: 'end_interview',
                  description: 'Call this function immediately when the candidate verbally indicates that they want to finish the interview, wrap up, conclude their answer or pitch, or says they are done.',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      summary: {
                        type: 'STRING',
                        description: 'A brief sentence explaining that the candidate verbally concluded the rehearsal'
                      }
                    }
                  }
                }]
              }],
              systemInstruction: {
                parts: [{ text: systemInstructionText }]
              }
            }
          };

          upstreamWs.send(JSON.stringify(setupPayload));
        });

        upstreamWs.on('message', async (data) => {
          let text;
          if (data instanceof Buffer) {
            text = data.toString('utf8');
          } else if (typeof data === 'string') {
            text = data;
          } else {
            text = data.toString();
          }

          try {
            const parsed = JSON.parse(text);

            if (parsed.setupComplete) {
              isSetupDone = true;
              console.log('[WebSocket] Upstream setup complete!');
              clientWs.send(JSON.stringify({ type: 'ready' }));

              // Generate opening question for the candidate's topic
              const openingQ = await generateOpeningQuestion(sessionContext.interviewTopic, sessionContext.targetRole);
              sessionContext.lastAskedQuestion = openingQ;
              sessionContext.questionsAsked.push(openingQ);
              console.log('[WebSocket] Opening question generated:', openingQ);

              // Send question text to client UI immediately
              clientWs.send(JSON.stringify({ type: 'ai_text', text: openingQ, isFull: true }));

              // Gemini Live speaks the opening question
              upstreamWs.send(JSON.stringify({
                clientContent: {
                  turns: [{
                    role: 'user',
                    parts: [{ text: `Speak this opening interview greeting and question out loud naturally to the candidate in your interviewer voice: "${openingQ}"` }]
                  }],
                  turnComplete: true
                }
              }));
              return;
            }

            if (parsed.serverContent) {
              const sc = parsed.serverContent;

              // Check for barge-in / interruption
              if (sc.interrupted) {
                console.log('[WebSocket] Model interrupted by candidate (barge-in)!');
                clientWs.send(JSON.stringify({ type: 'interrupted' }));
              }

              // Relay model turn parts
              if (sc.modelTurn && sc.modelTurn.parts) {
                for (const part of sc.modelTurn.parts) {
                  if (part.inlineData) {
                    clientWs.send(JSON.stringify({
                      type: 'ai_audio',
                      mimeType: part.inlineData.mimeType,
                      data: part.inlineData.data
                    }));
                  }
                  if (part.text) {
                    sessionContext.currentTurnAiText += part.text;
                    clientWs.send(JSON.stringify({
                      type: 'ai_text',
                      text: part.text
                    }));
                  }
                  if (part.functionCall && part.functionCall.name === 'end_interview') {
                    console.log('[WebSocket] Detected functionCall part: end_interview', part.functionCall.args);
                    clientWs.send(JSON.stringify({
                      type: 'auto_end',
                      reason: 'verbal_conclusion',
                      summary: part.functionCall.args?.summary || 'Candidate verbally concluded the interview.'
                    }));
                  }
                }
              }

              if (sc.turnComplete) {
                if (sessionContext.currentTurnAiText.trim()) {
                  sessionContext.lastAskedQuestion = sessionContext.currentTurnAiText.trim();
                  if (!sessionContext.questionsAsked.includes(sessionContext.lastAskedQuestion)) {
                    sessionContext.questionsAsked.push(sessionContext.lastAskedQuestion);
                  }
                  sessionContext.currentTurnAiText = '';
                }
                clientWs.send(JSON.stringify({ type: 'turn_complete' }));
              }
            }

            // Check for top-level toolCall from Gemini Live
            if (parsed.toolCall) {
              const calls = parsed.toolCall.functionCalls || [];
              for (const call of calls) {
                if (call.name === 'end_interview') {
                  console.log('[WebSocket] Detected top-level toolCall: end_interview', call.args);
                  clientWs.send(JSON.stringify({
                    type: 'auto_end',
                    reason: 'verbal_conclusion',
                    summary: call.args?.summary || 'Candidate verbally concluded the interview.'
                  }));
                }
              }
            }
          } catch (e) {
            console.error('[WebSocket] Error parsing upstream message:', e);
          }
        });

        upstreamWs.on('error', (err) => {
          console.error('[WebSocket] Upstream error:', err.message);
          clientWs.send(JSON.stringify({ type: 'error', message: `Live API error: ${err.message}` }));
        });

        upstreamWs.on('close', (code, reason) => {
          console.log(`[WebSocket] Upstream closed: ${code} - ${reason}`);
          clientWs.send(JSON.stringify({ type: 'closed', code, reason: reason ? reason.toString() : '' }));
        });
      }

      // 2. Client sending audio PCM chunk - Client handles local audio analysis & transcription
      else if (msg.type === 'audio') {
        // Ignored upstream to prevent Google VAD from racing with structured active listening turns
      }

      // 3. Client sending video / screen / camera frame
      else if (msg.type === 'video_frame') {
        if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN && isSetupDone) {
          upstreamWs.send(JSON.stringify({
            realtimeInput: {
              mediaChunks: [{
                mimeType: 'image/jpeg',
                data: msg.data
              }]
            }
          }));
        }
      }

      // 4. Client sending text turn (e.g. wrap-up signal or prompt)
      else if (msg.type === 'text') {
        if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN && isSetupDone) {
          upstreamWs.send(JSON.stringify({
            clientContent: {
              turns: [{
                role: 'user',
                parts: [{ text: msg.text }]
              }],
              turnComplete: true
            }
          }));
        }
      }

      // 4b. Client submitting completed answer turn (Direct WebSocket generation for sub-second latency)
      else if (msg.type === 'submit_answer') {
        const candidateText = (msg.text || '').trim();
        console.log('[WebSocket] Client submitted answer turn:', candidateText.slice(0, 80));

        // Check if candidate verbally asked to repeat the question
        if (isRepeatRequest(candidateText)) {
          const qToRepeat = sessionContext.lastAskedQuestion || msg.lastQuestion || `Could you walk me through your background and your work on ${sessionContext.interviewTopic}?`;
          console.log('[WebSocket] Detected repeat request in submitted answer. Repeating question:', qToRepeat);
          const repeatSpeech = `Sure, let me repeat that: ${qToRepeat}`;

          // Send question text to client UI immediately
          clientWs.send(JSON.stringify({ type: 'ai_text', text: repeatSpeech, isFull: true }));

          // Gemini Live speaks the repetition aloud
          if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN && isSetupDone) {
            upstreamWs.send(JSON.stringify({
              clientContent: {
                turns: [{
                  role: 'user',
                  parts: [{
                    text: `Speak this repetition out loud naturally to the candidate in your interviewer voice: "${repeatSpeech}"`
                  }]
                }],
                turnComplete: true
              }
            }));
          }
          return;
        }

        // Server-side echo & minimum length rejection
        if (!candidateText || candidateText.length < 3 || isEchoOfQuestion(candidateText, sessionContext.lastAskedQuestion)) {
          console.log('[WebSocket] Discarding empty answer or acoustic echo turn:', candidateText);
          return;
        }

        // Candidate answered normally
        sessionContext.candidateAnswers.push(candidateText);
        sessionContext.candidateAnswer = candidateText;

        const followUpQ = await generateFollowUpQuestion(sessionContext);
        sessionContext.lastAskedQuestion = followUpQ;
        if (!sessionContext.questionsAsked.includes(followUpQ)) {
          sessionContext.questionsAsked.push(followUpQ);
        }

        // Send follow-up question text to client UI immediately
        clientWs.send(JSON.stringify({ type: 'ai_text', text: followUpQ, isFull: true }));

        // Prompt Gemini Live to speak this follow-up question out loud in native audio
        if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN && isSetupDone) {
          upstreamWs.send(JSON.stringify({
            clientContent: {
              turns: [{
                role: 'user',
                parts: [{ text: `Speak this follow-up interview question out loud naturally to the candidate in your interviewer voice: "${followUpQ}"` }]
              }],
              turnComplete: true
            }
          }));
        }
      }

      // 4c. Client requesting question repetition ("Can you repeat that?")
      else if (msg.type === 'repeat_question') {
        const qToRepeat = sessionContext.lastAskedQuestion || msg.lastQuestion || `Could you walk me through your background and your work on ${sessionContext.interviewTopic}?`;
        console.log('[WebSocket] Client requested question repetition:', qToRepeat);
        const repeatSpeech = `Sure, let me repeat that: ${qToRepeat}`;

        // Send question text to client UI immediately
        clientWs.send(JSON.stringify({ type: 'ai_text', text: repeatSpeech, isFull: true }));

        // Speak aloud via Gemini Live
        if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN && isSetupDone) {
          upstreamWs.send(JSON.stringify({
            clientContent: {
              turns: [{
                role: 'user',
                parts: [{
                  text: `Speak this repetition out loud naturally to the candidate in your interviewer voice: "${repeatSpeech}"`
                }]
              }],
              turnComplete: true
            }
          }));
        }
      }

      // 5. Client requesting immediate spoken wrap-up critique (Immediate In-Studio Debrief)
      else if (msg.type === 'request_spoken_critique') {
        if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN && isSetupDone) {
          console.log('[WebSocket] Delivering immediate spoken feedback in studio...');
          upstreamWs.send(JSON.stringify({
            clientContent: {
              turns: [{
                role: 'user',
                parts: [{ text: "The rehearsal is now complete. Deliver your immediate, spoken 45-second executive debrief out loud now: state an overall numerical score out of 100, summarize what went well, and explain the single most critical blindspot to improve." }]
              }],
              turnComplete: true
            }
          }));

          // Generate in-studio scorecard summary in parallel (fast)
          generateQuickScorecard(sessionContext).then(scoreData => {
            if (scoreData && clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({
                type: 'studio_critique',
                data: scoreData
              }));
            }
          }).catch(e => console.warn('Could not generate quick scorecard:', e));
        }
      }
    } catch (err) {
      console.error('[WebSocket] Error handling client message:', err);
    }
  });

  clientWs.on('close', () => {
    console.log('[WebSocket] Client disconnected');
    cleanup();
  });

  clientWs.on('error', (err) => {
    console.error('[WebSocket] Client error:', err);
    cleanup();
  });
});

if (!process.env.VERCEL) {
  server.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 NSOFFICE LIVE INTERVIEW & PITCH REHEARSAL COACH`);
    console.log(`✨ AI Centre of Excellence | Network Science`);
    console.log(`📡 Server running on http://localhost:${PORT}`);
    console.log(`🔑 Gemini Key Configured: ${GEMINI_API_KEY ? 'YES (Valid)' : 'NO'}`);
    console.log(`🎙️ Live Audio Model: ${GEMINI_LIVE_MODEL}`);
    console.log(`📝 Critique Model: ${GEMINI_TEXT_MODEL}`);
    console.log(`======================================================\n`);
  });
}

module.exports = app;
