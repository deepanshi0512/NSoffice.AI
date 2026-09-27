const assert = require('assert');

// Test isEchoOfQuestion logic
function isEchoOfQuestion(spokenText, questionText) {
  if (!spokenText || !questionText) return false;
  const cleanSpoken = spokenText.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const cleanQ = questionText.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleanSpoken.length === 0 || cleanQ.length === 0) return false;

  // Substring containment
  if (cleanQ.includes(cleanSpoken) && cleanSpoken.length >= 6) {
    return true;
  }
  if (cleanSpoken.includes(cleanQ) && cleanQ.length >= 6) {
    return true;
  }

  // Word overlap comparison
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

function runEchoTests() {
  console.log('=== TEST SUITE: ACOUSTIC ECHO LOOP REJECTION ===');

  const question = "Welcome to your rehearsal. Let's begin with your EUDR project—could you introduce your project and highlight your primary architectural decisions?";

  const echoScenarios = [
    "Welcome to your rehearsal",
    "let's begin with your EUDR project",
    "could you introduce your project and highlight your primary architectural decisions",
    "Welcome to your rehearsal let's begin with your EUDR project could you introduce your project",
    "primary architectural decisions",
    "introduce your project and highlight",
    "Welcome to your rehearsal let's begin"
  ];

  let echoPassed = 0;
  for (const echo of echoScenarios) {
    const isEcho = isEchoOfQuestion(echo, question);
    if (isEcho) {
      echoPassed++;
      console.log(`  🛡️ Echo Blocked Successfully: "${echo}"`);
    } else {
      console.error(`  ❌ Failed to block echo: "${echo}"`);
    }
  }

  const validAnswers = [
    "I built an end-to-end data pipeline to track EUDR compliance across 500 suppliers with automated polygon geolocation validation.",
    "Our architecture uses Python and FastAPI with PostgreSQL for spatial indexing.",
    "We chose Random Forest over Logistic Regression because of non-linear feature interactions.",
    "Yes, I started by ingesting satellite imagery and calculating NDVI indices."
  ];

  let validPassed = 0;
  for (const ans of validAnswers) {
    const isEcho = isEchoOfQuestion(ans, question);
    if (!isEcho) {
      validPassed++;
      console.log(`  ✅ Real Answer Accepted: "${ans.slice(0, 65)}..."`);
    } else {
      console.error(`  ❌ False positive (blocked valid answer): "${ans}"`);
    }
  }

  console.log(`\nResults: ${echoPassed}/${echoScenarios.length} echoes blocked, ${validPassed}/${validAnswers.length} valid answers accepted.`);
  assert.strictEqual(echoPassed, echoScenarios.length);
  assert.strictEqual(validPassed, validAnswers.length);
  console.log('🎉 ALL ECHO REJECTION TESTS PASSED 100%!\n');
}

runEchoTests();
