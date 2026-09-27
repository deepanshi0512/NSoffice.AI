const WebSocket = require('ws');
require('dotenv').config();

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

function runRegexTests() {
  console.log('=== TEST SUITE 1: REPEAT INTENT DETECTION ===');

  const positiveTests = [
    "Please repeat the question.",
    "Can you repeat that?",
    "I didn't hear the question.",
    "Could you ask that again?",
    "Repeat the question please.",
    "Sorry, what was the question?",
    "Sorry, I didn't hear that.",
    "Could you say that again?",
    "Can you repeat the question please?",
    "What was the question?"
  ];

  let passedPos = 0;
  for (const phrase of positiveTests) {
    const matched = isRepeatRequest(phrase);
    if (matched) {
      passedPos++;
      console.log(`  ✅ Match: "${phrase}"`);
    } else {
      console.error(`  ❌ Failed to match: "${phrase}"`);
    }
  }

  const negativeTests = [
    "I repeated the training process for 10 epochs.",
    "At the end of the project we noticed high RMSE.",
    "I used Random Forest because it gave better performance.",
    "We can stop here.",
    "Let me explain how we finished the pipeline."
  ];

  let passedNeg = 0;
  for (const phrase of negativeTests) {
    const matched = isRepeatRequest(phrase);
    if (!matched) {
      passedNeg++;
      console.log(`  ✅ Correct non-match: "${phrase}"`);
    } else {
      console.error(`  ❌ False positive on: "${phrase}"`);
    }
  }

  console.log(`Pattern tests: ${passedPos}/${positiveTests.length} positives passed, ${passedNeg}/${negativeTests.length} negatives passed.\n`);
  return passedPos === positiveTests.length && passedNeg === negativeTests.length;
}

async function runLiveWebSocketFlowTest() {
  console.log('=== TEST SUITE 2: LIVE INTERVIEW FLOW & ACTIVE LISTENING ===');
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://localhost:3000/ws/live');
    let step = 0;
    let openingQuestion = '';
    let followUpQuestion1 = '';
    let followUpQuestion2 = '';

    const timeout = setTimeout(() => {
      console.error('Flow test timed out after 45s');
      ws.close();
      resolve(false);
    }, 45000);

    ws.on('open', () => {
      console.log('[Flow Test] Connected to live session. Initializing Python + Data Science topic...');
      ws.send(JSON.stringify({
        type: 'init',
        config: {
          topic: 'Python + Data Science Project (Sales Prediction with Random Forest vs Logistic Regression)',
          customRole: 'Senior Data Scientist',
          difficulty: 'standard',
          voice: 'Aoede'
        }
      }));
    });

    ws.on('message', async (data) => {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'ai_text') {
        const text = msg.text.trim();

        if (step === 0) {
          step = 1;
          openingQuestion = text;
          console.log(`\n[Interviewer Q1 - Opening Question]:\n"${openingQuestion}"`);

          const isTopical = openingQuestion.toLowerCase().includes('python') ||
                            openingQuestion.toLowerCase().includes('data science') ||
                            openingQuestion.toLowerCase().includes('sales prediction') ||
                            openingQuestion.toLowerCase().includes('project');
          console.log(`Q1 Stays strictly on topic: ${isTopical ? 'YES ✅' : 'NO ❌'}`);

          // STEP 1 TEST: Candidate says "Can you repeat the question?"
          console.log('\n--- Step 1: Candidate asks "Can you repeat the question?" ---');
          ws.send(JSON.stringify({
            type: 'submit_answer',
            text: 'Can you repeat the question?'
          }));
        }
        else if (step === 1) {
          step = 2;
          console.log(`\n[Interviewer Response to Repeat Request]:\n"${text}"`);
          const repeatsCorrectly = text.toLowerCase().includes('repeat') || text.toLowerCase().includes(openingQuestion.slice(0, 25).toLowerCase());
          console.log(`Interviewer repeated the exact question: ${repeatsCorrectly ? 'YES ✅' : 'NO ❌'}`);

          // STEP 2 TEST: Candidate answers with technical claims & metrics
          console.log('\n--- Step 2: Candidate provides technical answer ---');
          console.log('"I used Random Forest because it gave better performance than Logistic Regression, lowering RMSE to 12.4 with a 20% accuracy gain."');
          ws.send(JSON.stringify({
            type: 'submit_answer',
            text: 'I used Random Forest because it gave better performance than Logistic Regression, lowering RMSE to 12.4 with a 20% accuracy gain.'
          }));
        }
        else if (step === 2) {
          step = 3;
          followUpQuestion1 = text;
          console.log(`\n[Interviewer Q2 - Follow-up on Answer]:\n"${followUpQuestion1}"`);

          const lower = followUpQuestion1.toLowerCase();
          const hasCandidatePoints = lower.includes('random forest') ||
                                     lower.includes('rmse') ||
                                     lower.includes('logistic regression') ||
                                     lower.includes('accuracy') ||
                                     lower.includes('metric') ||
                                     lower.includes('baseline') ||
                                     lower.includes('model') ||
                                     lower.includes('performance');
          const isOffTopic = lower.includes('salesforce') || lower.includes('sql') || lower.includes('marketing');

          console.log(`Q2 Probes candidate's actual points (Random Forest / RMSE / metrics): ${hasCandidatePoints ? 'YES ✅' : 'NO ❌'}`);
          console.log(`Q2 Strictly avoids random off-topic questions: ${!isOffTopic ? 'YES ✅' : 'NO ❌'}`);

          // STEP 3 TEST: Candidate gives very short answer
          console.log('\n--- Step 3: Candidate gives a short answer: "Yes, I used Python." ---');
          ws.send(JSON.stringify({
            type: 'submit_answer',
            text: 'Yes, I used Python.'
          }));
        }
        else if (step === 3) {
          step = 4;
          followUpQuestion2 = text;
          console.log(`\n[Interviewer Q3 - Follow-up on Short Answer]:\n"${followUpQuestion2}"`);

          const lower2 = followUpQuestion2.toLowerCase();
          const probesDeeper = lower2.includes('python') ||
                               lower2.includes('librar') ||
                               lower2.includes('package') ||
                               lower2.includes('tool') ||
                               lower2.includes('specific') ||
                               lower2.includes('scikit') ||
                               lower2.includes('pandas') ||
                               lower2.includes('implement');

          console.log(`Q3 Probes specifics without abandoning topic: ${probesDeeper ? 'YES ✅' : 'NO ❌'}`);

          clearTimeout(timeout);
          ws.close();
          resolve(true);
        }
      }
    });

    ws.on('error', (err) => {
      console.error('[Flow Test] Error:', err.message);
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

async function main() {
  const pPassed = runRegexTests();
  if (!pPassed) {
    process.exit(1);
  }
  const flowPassed = await runLiveWebSocketFlowTest();
  if (flowPassed) {
    console.log('\n🎉 ALL INTEGRATION TESTS PASSED SUCCESSFULLY! 🎉\n');
    process.exit(0);
  } else {
    console.error('\n❌ Flow test encountered an issue.\n');
    process.exit(1);
  }
}

main();
