# NSOffice Live Interview & Pitch Rehearsal Coach
### Real-Time Multimodal AI Experience with the Google Gemini Live API
**Built for Network Science AI Centre of Excellence (`NSOFFICE.AI`)**  
*Problem Statement 3: Live Interview and Pitch Rehearsal Coach (Professional Services)*

---

## 🎯 Executive Overview

The **NSOffice Live Interview & Pitch Rehearsal Coach** is an executive-grade, real-time voice and vision rehearsal platform. Designed for candidates preparing for tier-1 case interviews (McKinsey / BCG / Bain) and consultants rehearsing high-stakes C-suite client pitches, the system places users in front of realistic, uncompromising AI panelists.

Unlike standard text chatbots, this application leverages **Google's Gemini 3.1 Flash Live API** over low-latency WebSockets for true audio-to-audio dialogue. The panel actively listens, challenges unsubstantiated claims, and **naturally interrupts using proactive barge-in**. When the rehearsal concludes, **Gemini 3.8 Flash** evaluates the full transcript, delivering an instant spoken debrief and an immediate in-studio executive scorecard.

---

## ✨ Key Features & Capabilities

1. **Low-Latency Bidirectional Audio Dialogue**:
   - Audio-to-audio conversational flow using `gemini-2.5-flash-native-audio-preview-12-2025`.
   - Real-time 16kHz Linear PCM microphone capture with client-side Web Audio downsampling.
   - 24kHz PCM streaming playback with jitter-free scheduled audio buffers.
   - **Sub-Second Turn Latency (~300–500ms)**: Direct WebSocket turn management eliminates lag.

2. **Proactive & Natural Mid-Response Barge-In**:
   - If the candidate speaks vaguely, rambles, or avoids citing metrics for 2–3 sentences, the AI panelist naturally interrupts (*"Excuse me, let me pause you there—what was the specific quantitative metric you moved?"*).
   - Instant barge-in cutoff: When the candidate starts speaking while the AI is talking, playback stops instantaneously and the audio buffer is flushed.

3. **Strict Topical Grounding & Active Listening**:
   - The panelist remains strictly anchored to the candidate's chosen topic or recited answer.
   - Probes specific technical architectures, metrics, and trade-offs mentioned by the candidate.
   - Handles verbal repetition requests seamlessly (*"Can you repeat the question?"* / *"Sorry, what did you ask?"*).

4. **Dual Interview Termination (Voice + Button)**:
   - **Voice Termination**: The candidate can end the interview naturally by speaking (*"End the interview"*, *"I want to end the interview"*, *"That's all from my side"*, *"We can stop here"*).
   - **Button Termination**: A visible, accessible **"End Interview & Compile Critique"** button.

5. **Immediate In-Studio Executive Feedback (No Separate Screen)**:
   - Does NOT navigate to a separate view or display a blocking loading screen.
   - Reveals an in-studio feedback card directly on the studio stage with:
     - Numerical score out of 100 and verdict pill (*e.g., "Strong Performer"*).
     - Live verbal critique box displaying the interviewer's words as they speak.
     - Key strengths and top areas for improvement.
     - One-click **"Start New Rehearsal Session"** button.
   - Gemini Live delivers an immediate 45-second executive spoken critique out loud.

6. **Continuous Total Interview Timer**:
   - Single upward-counting timer (`Interview Time 00:03:42`) at the top of the studio.
   - Replaces stressful countdown timers with natural interview pacing.

7. **Live Screen & Pitch Deck Awareness**:
   - The candidate can share presentation slides, financial models, or documents in real time.
   - Screen frames are sampled and streamed directly into Gemini Live.

8. **NSOffice Glass UI System**:
   - Curated **Electric Blue (`#0066FF`)** accent and sleek dark glassmorphism.
   - **Outfit** & **DM Sans** modern typography.
   - Specular highlights and audio-reactive glass refraction rings.

---

## 🏛️ System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT BROWSER                                 │
│  ┌───────────────────────┐  ┌────────────────────────────────────────────┐  │
│  │ View 1: Setup Lobby   │  │ View 2: Studio Stage + In-Studio Feedback  │  │
│  └───────────────────────┘  └────────────────────────────────────────────┘  │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ Web Audio Manager (16kHz PCM downsampler & 24kHz buffer queue player) │  │
│  │ Video Capture (Canvas-based JPEG frame streamer for Deck & Camera)    │  │
│  │ Liquid Glass Engine (Specular lighting & audio-reactive orb rings)    │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ WebSocket (Audio/Video/Events)
                                       │ HTTP POST (/api/critique)
┌──────────────────────────────────────▼──────────────────────────────────────┐
│                           NODE.JS / EXPRESS SERVER                          │
│                                                                             │
│  • Holds GEMINI_API_KEY securely in server-side environment (.env)          │
│  • Serves NSOffice Glass UI static assets (tokens.css, liquid-glass.js)     │
│  • /ws/live: Bidirectional WebSocket relay to Google Multimodal Live API    │
│  • /api/critique: REST endpoint invoking Gemini 3.8 Flash structured rubric │
└───────────────────┬─────────────────────────────────────┬───────────────────┘
                    │                                     │
                    │ WebSocket                           │ HTTPS REST
                    ▼                                     ▼
┌────────────────────────────────────────┐ ┌──────────────────────────────────┐
│        Google Gemini Live API          │ │     Google Gemini 3.8 Flash      │
│ (models/gemini-2.5-flash-native-audio-preview-12-2025) │ │       (gemini-2.5-flash)         │
│  • Real-time speech-to-speech dialogue │ │  • Multi-dimensional scorecard   │
│  • Visual slide & camera understanding │ │  • Rephrase drills & debrief     │
│  • Automatic barge-in detection        │ │                                  │
└────────────────────────────────────────┘ └──────────────────────────────────┘
```

---

## 📦 Project Structure

```
├── .env                     # Private environment variables (in .gitignore)
├── .env.example             # Template for required environment variables
├── .gitignore               # Ignores .env, *.pdf, node_modules, build artifacts
├── package.json             # Dependencies and npm scripts
├── server.js                # Express server, WebSocket relay & critique API
├── vercel.json              # Vercel deployment configuration
├── public/
│   ├── index.html           # SPA layout adhering to NSOffice Glass UI
│   ├── tokens.css           # Design tokens (Electric Blue, DM Sans, Apple spacing)
│   ├── style.css            # Glassmorphism, animations, audio orb, studio layout
│   ├── liquid-glass.js      # Dynamic liquid glass specular & audio wave engine
│   ├── audio-processor.js   # 16kHz PCM downsampler, 24kHz player & barge-in handler
│   └── app.js               # Application state machine, WebSocket & view controller
└── README.md                # Comprehensive documentation
```

---

## 🚀 Quickstart & Local Setup

### Prerequisites
- **Node.js**: v18.0.0 or later (Tested on Node v22.14)
- **NPM**: v9.0.0 or later
- A modern web browser (Chrome, Edge, Brave, or Safari) with microphone permissions enabled.

### 1. Clone & Enter Directory
```bash
git clone <your-repo-url>
cd "Network Science Project"
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Configure Environment Variables
Create a `.env` file in the root directory (or copy from `.env.example`):
```bash
cp .env.example .env
```

Ensure your `.env` contains:
```env
# Gemini API Key (keep this private, never commit to git)
GEMINI_API_KEY=your_gemini_api_key_here

# Live API Model (WebSocket real-time audio/speech/vision)
GEMINI_LIVE_MODEL=models/gemini-2.5-flash-native-audio-preview-12-2025

# Turn-based Text/Critique Model
GEMINI_TEXT_MODEL=gemini-2.5-flash

# Server Port
PORT=3000
```

### 4. Run Locally
```bash
npm start
```

Open your browser and navigate to:
```
http://localhost:3000
```

---

## ☁️ Deployment Instructions

### A. Pushing to GitHub

1. Verify that your `.gitignore` is in place (ensuring `.env` and assignment PDFs are never tracked):
   ```bash
   git status
   ```
2. Add all tracked changes and commit:
   ```bash
   git add .
   git commit -m "feat: complete NSOffice Live Interview Coach"
   ```
3. Set your GitHub remote repository and push:
   ```bash
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo-name>.git
   git push -u origin main
   ```

### B. Deploying to Vercel

The repository includes a ready-to-deploy `vercel.json` configuration:

1. Log into your [Vercel Dashboard](https://vercel.com).
2. Click **Add New Project** and import your GitHub repository.
3. Under **Environment Variables**, add:
   - `GEMINI_API_KEY`: Your Gemini API Key from Google AI Studio
   - `GEMINI_LIVE_MODEL`: `models/gemini-2.5-flash-native-audio-preview-12-2025`
   - `GEMINI_TEXT_MODEL`: `gemini-2.5-flash`
4. Click **Deploy**. Vercel will build and assign a production URL.

> **Note on WebSockets**: Vercel Serverless Functions serve all static assets, UI, and REST API endpoints (`/api/config`, `/api/critique`). For persistent bidirectional WebSockets in production, you can deploy the `server.js` Node backend to **Render**, **Railway**, or **Fly.io** with 1 click, or run it locally.

---

## 🔒 Security & Privacy

- The Google Gemini API key is strictly maintained server-side through `process.env.GEMINI_API_KEY`.
- The `.gitignore` strictly ignores `.env`, all `*.pdf` files, logs, and sensitive artifacts.
- Audio and video streams are processed in memory and never persisted to disk.

---

## 📄 Submission Information

- **Organization**: Network Science Technologies Private Limited (`NSOFFICE.AI`)
- **Center**: AI Centre of Excellence
- **Assignment**: Build a real-time AI experience with the Gemini API (Problem Statement 3)
- **Primary Contact**: bhargav@networkscience.ai
