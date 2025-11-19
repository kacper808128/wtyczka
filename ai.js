// Available Gemini models for rotation on rate limiting
// Lite models first for faster responses
const GEMINI_MODELS = [
  'gemini-2.0-flash-lite',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.5-flash'
];

// Current model index - rotates through models on 429 errors
let currentModelIndex = 0;

async function getApiKey() {
  // First, try to get API key from chrome.storage (user settings)
  try {
    const result = await new Promise((resolve) => {
      chrome.storage.sync.get('geminiApiKey', (result) => {
        if (chrome.runtime.lastError) {
          console.warn('Error reading API key from storage:', chrome.runtime.lastError);
          resolve(null);
        } else {
          resolve(result.geminiApiKey);
        }
      });
    });

    // If we found a valid API key in storage, use it
    if (result && result !== 'YOUR_API_KEY_HERE' && result.trim().length > 0) {
      return result;
    }
  } catch (error) {
    console.warn('Error accessing storage for API key:', error);
  }

  // Fallback: try to get API key from config.js (for backward compatibility)
  try {
    const response = await fetch(chrome.runtime.getURL('config.js'));
    if (!response.ok) {
      return null;
    }
    const text = await response.text();
    const match = text.match(/const\s+GEMINI_API_KEY\s*=\s*["'](.*)["']/);
    if (match && match[1] && match[1] !== 'YOUR_API_KEY_HERE') {
      return match[1];
    }
    return null;
  } catch (error) {
    console.warn('Error reading config.js:', error);
    return null;
  }
}

async function getAIResponse(question, userData, options) {
  // CHANGED: Try mock data first (from "Twoje dane"), then AI
  // This is faster and cheaper than calling AI first
  // Returns: { answer: string, source: 'mock' | 'ai' | 'empty' }
  const mockAnswer = getMockAIResponse(question, userData, options);
  if (mockAnswer) {
    console.log('[Gemini Filler] Using mock response from user data');
    return { answer: mockAnswer, source: 'mock' };
  }

  // If no mock answer, try AI
  const apiKey = await getApiKey();

  if (apiKey && apiKey !== 'TWOJ_KLUCZ_API' && apiKey !== 'YOUR_API_KEY_HERE') {
    try {
      console.log('[Gemini Filler] No mock answer, trying AI...');
      const aiAnswer = await getRealAIResponse(question, userData, apiKey, options);
      return { answer: aiAnswer, source: 'ai' };
    } catch (error) {
      // If AI fails (timeout, error, etc.), return empty (skip field)
      console.warn('[Gemini Filler] AI failed:', error.message);
      console.log('[Gemini Filler] Skipping field (no mock or AI answer available)');
      return { answer: '', source: 'empty' };
    }
  } else {
    console.log('[Gemini Filler] No API key configured and no mock response available. Set your API key in extension settings.');
    return { answer: '', source: 'empty' };
  }
}

/**
 * Batch process multiple questions at once for efficiency
 * @param {Array} questions - Array of {question: string, options: array|null}
 * @param {Object} userData - User's data
 * @returns {Object} - Mapping of question to answer
 */
async function getBatchAIResponse(questions, userData) {
  const apiKey = await getApiKey();

  if (!apiKey || apiKey === 'TWOJ_KLUCZ_API' || apiKey === 'YOUR_API_KEY_HERE') {
    console.log('[Gemini Filler] No API key for batch processing, using mock responses');
    // Fallback to individual mock responses
    const result = {};
    questions.forEach((q, idx) => {
      const mockAnswer = getMockAIResponse(q.question, userData, q.options);
      if (mockAnswer) {
        result[idx] = mockAnswer;
      }
    });
    return result;
  }

  // Build batch prompt
  let prompt = `You are an expert recruitment form filler. Your task is to match each question to the best answer from user data, or select the best option from provided choices.

User data:
${JSON.stringify(userData, null, 2)}

Questions:
`;

  questions.forEach((q, idx) => {
    prompt += `${idx}. ${q.question}`;
    if (q.options && q.options.length > 0) {
      prompt += ` [Options: ${q.options.join(', ')}]`;
    }
    prompt += '\n';
  });

  prompt += `
IMPORTANT INSTRUCTIONS:
1. Return ONLY a valid JSON object, no other text
2. Format: {"0": "answer0", "1": "answer1", "2": "answer2", ...}
3. Use the question index (0, 1, 2...) as keys
4. When options are provided, MUST use exact option text
5. If you cannot determine answer from user data, use empty string ""
6. Do NOT add explanations, comments, or any text outside the JSON

Example response:
{"0": "John", "1": "john@example.com", "2": "3-5 years", "3": ""}`;

  try {
    console.log(`[Gemini Filler] Batch processing ${questions.length} questions...`);
    const response = await getRealAIResponse(prompt, {}, apiKey, null, 30000); // 30s timeout for batch

    // Parse JSON response
    try {
      // Remove markdown code blocks if present
      let cleanResponse = response.trim();
      if (cleanResponse.startsWith('```json')) {
        cleanResponse = cleanResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '');
      } else if (cleanResponse.startsWith('```')) {
        cleanResponse = cleanResponse.replace(/```\n?/g, '');
      }

      const parsed = JSON.parse(cleanResponse);
      console.log(`[Gemini Filler] Batch AI returned ${Object.keys(parsed).length} answers`);
      return parsed;
    } catch (parseError) {
      console.error('[Gemini Filler] Failed to parse batch AI response:', parseError);
      console.error('[Gemini Filler] Response was:', response);
      // Fallback to individual mock responses
      const result = {};
      questions.forEach((q, idx) => {
        const mockAnswer = getMockAIResponse(q.question, userData, q.options);
        if (mockAnswer) {
          result[idx] = mockAnswer;
        }
      });
      return result;
    }
  } catch (error) {
    console.error('[Gemini Filler] Batch AI failed:', error);
    // Fallback to individual mock responses
    const result = {};
    questions.forEach((q, idx) => {
      const mockAnswer = getMockAIResponse(q.question, userData, q.options);
      if (mockAnswer) {
        result[idx] = mockAnswer;
      }
    });
    return result;
  }
}

async function getRealAIResponse(question, userData, apiKey, options, timeoutMs = 15000) {
  let prompt = `You are an expert recruitment form filler. Your task is to select the best option from a list for a given question, based on the user's data.

User data: ${JSON.stringify(userData, null, 2)}
Question: "${question}"`;

  if (options) {
    prompt += `\nAvailable options: [${options.join(', ')}]`;
    prompt += `\n\nYour response MUST be one of the "Available options". Do not add any extra text, explanation, or punctuation. Just return the chosen option text exactly as it appears in the list.`;
  } else {
    prompt += `\n\nPlease provide only the answer to the question, without any extra text or explanation.`;
  }

  const maxRetries = 3;
  let lastError = null;
  let modelsAttempted = new Set(); // Track which models we've tried

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Get current model
      const currentModel = GEMINI_MODELS[currentModelIndex];
      modelsAttempted.add(currentModel);

      const API_URL = `https://generativelanguage.googleapis.com/v1/models/${currentModel}:generateContent?key=${apiKey}`;

      console.log(`[Gemini Filler] Using model: ${currentModel} (attempt ${attempt + 1}/${maxRetries})`);

      // Create abort controller for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: prompt
            }]
          }]
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      // Handle specific HTTP error codes
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));

        if (response.status === 429) {
          // Rate limiting - rotate to next model
          console.warn(`[Gemini Filler] Rate limited on ${currentModel}. Rotating to next model...`);

          // Rotate to next model
          currentModelIndex = (currentModelIndex + 1) % GEMINI_MODELS.length;
          const nextModel = GEMINI_MODELS[currentModelIndex];

          // If we've tried all models, wait before continuing
          if (modelsAttempted.has(nextModel)) {
            const waitTime = Math.pow(2, attempt) * 1000; // Exponential backoff
            console.warn(`[Gemini Filler] All models attempted. Waiting ${waitTime}ms before retry...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
          } else {
            // Just a short delay before trying the next model
            await new Promise(resolve => setTimeout(resolve, 500));
          }

          continue;
        }

        if (response.status === 400) {
          throw new Error(`Invalid API request: ${errorData.error?.message || 'Bad request'}`);
        }

        if (response.status === 403) {
          throw new Error('API key is invalid or has insufficient permissions');
        }

        if (response.status === 404) {
          throw new Error('API endpoint not found. The model may have been updated.');
        }

        throw new Error(`HTTP error! status: ${response.status}, message: ${errorData.error?.message || 'Unknown error'}`);
      }

      const data = await response.json();

      // Validate response structure
      if (!data || !data.candidates || !Array.isArray(data.candidates) || data.candidates.length === 0) {
        throw new Error('Invalid API response: no candidates returned');
      }

      const candidate = data.candidates[0];

      if (!candidate.content || !candidate.content.parts || !Array.isArray(candidate.content.parts) || candidate.content.parts.length === 0) {
        throw new Error('Invalid API response: no content parts found');
      }

      const text = candidate.content.parts[0].text;

      if (typeof text !== 'string') {
        throw new Error('Invalid API response: text is not a string');
      }

      return text.trim();

    } catch (error) {
      lastError = error;

      // Don't retry on these errors
      if (error.name === 'AbortError') {
        console.error(`API request timed out after ${timeoutMs/1000} seconds`);
        throw new Error(`Request timed out after ${timeoutMs/1000} seconds`);
      }

      if (error.message.includes('invalid') || error.message.includes('permissions')) {
        console.error('API error:', error.message);
        throw error; // Don't retry on auth/config errors
      }

      // For network errors, retry with exponential backoff
      if (attempt < maxRetries - 1) {
        const waitTime = Math.pow(2, attempt) * 1000;
        console.warn(`Attempt ${attempt + 1} failed. Retrying in ${waitTime}ms...`, error.message);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }

  // All retries failed
  console.error('Error calling Gemini API after', maxRetries, 'attempts:', lastError);
  throw lastError || new Error('Failed to get AI response after multiple attempts');
}

function getMockAIResponse(question, userData, options) {
  if (!userData || Object.keys(userData).length === 0) {
    return '';
  }

  const lowerQuestion = question.toLowerCase();

  // Helper function to find best match in options
  function findInOptions(value, options) {
    if (!options || !value) return value;

    const lowerValue = value.toString().toLowerCase();

    // Try exact match first
    for (const option of options) {
      if (option.toLowerCase() === lowerValue) {
        return option;
      }
    }

    // Try partial match
    for (const option of options) {
      if (option.toLowerCase().includes(lowerValue) || lowerValue.includes(option.toLowerCase())) {
        return option;
      }
    }

    return value; // Return original if no match
  }

  // NEW: Intelligent fuzzy matching in userData keys
  // Instead of hardcoded fields, search for matching keys
  function findUserDataValue(keywords) {
    if (!Array.isArray(keywords)) keywords = [keywords];

    for (const keyword of keywords) {
      const lowerKeyword = keyword.toLowerCase();

      // Try exact match first
      for (const [key, value] of Object.entries(userData)) {
        if (key.toLowerCase() === lowerKeyword && value) {
          return value;
        }
      }

      // Try partial match
      for (const [key, value] of Object.entries(userData)) {
        const lowerKey = key.toLowerCase();
        if ((lowerKey.includes(lowerKeyword) || lowerKeyword.includes(lowerKey)) && value) {
          return value;
        }
      }
    }

    return null;
  }

  let answer = '';

  // Try to match question to userData using intelligent keyword matching
  if (lowerQuestion.includes('first name') || lowerQuestion.includes('imię') || lowerQuestion.includes('imie')) {
    answer = findUserDataValue(['imię', 'imie', 'firstName', 'first name', 'name', 'first']) || '';
  } else if (lowerQuestion.includes('last name') || lowerQuestion.includes('nazwisko')) {
    answer = findUserDataValue(['nazwisko', 'lastName', 'last name', 'surname', 'last']) || '';
  } else if (lowerQuestion.includes('full name') || lowerQuestion.includes('pełne imię')) {
    const firstName = findUserDataValue(['imię', 'firstName', 'first name']);
    const lastName = findUserDataValue(['nazwisko', 'lastName', 'last name']);
    answer = [firstName, lastName].filter(Boolean).join(' ');
  } else if (lowerQuestion.includes('email') || lowerQuestion.includes('e-mail') || lowerQuestion.includes('mail')) {
    answer = findUserDataValue(['email', 'e-mail', 'mail', 'e mail']) || '';
  } else if (lowerQuestion.includes('phone') || lowerQuestion.includes('telefon') || lowerQuestion.includes('tel.') || lowerQuestion.includes('numer')) {
    answer = findUserDataValue(['telefon', 'phone', 'tel', 'numer telefonu', 'phone number', 'mobile', 'tel.']) || '';
  } else if (lowerQuestion.includes('linkedin')) {
    answer = findUserDataValue(['linkedin', 'linked in']) || '';
  } else if (lowerQuestion.includes('github')) {
    answer = findUserDataValue(['github', 'git hub']) || '';
  } else if (lowerQuestion.includes('portfolio') || lowerQuestion.includes('website') || lowerQuestion.includes('strona')) {
    answer = findUserDataValue(['website', 'portfolio', 'strona', 'www', 'web']) || '';
  } else if (lowerQuestion.includes('experience') || lowerQuestion.includes('doświadczenie') || lowerQuestion.includes('lata')) {
    answer = findUserDataValue(['experience', 'doświadczenie', 'yearsOfExperience', 'years', 'lata', 'lata doświadczenia']) || '';
  } else if (lowerQuestion.includes('education') || lowerQuestion.includes('wykształcenie')) {
    answer = findUserDataValue(['education', 'wykształcenie', 'edukacja', 'szkoła']) || '';
  } else if (lowerQuestion.includes('start') || lowerQuestion.includes('rozpocząć') || lowerQuestion.includes('availability') || lowerQuestion.includes('kiedy')) {
    answer = findUserDataValue(['startDate', 'availability', 'start', 'kiedy', 'od kiedy', 'rozpoczęcie']) || 'Immediately';
  } else if (lowerQuestion.includes('salary') || lowerQuestion.includes('wynagrodzenie') || lowerQuestion.includes('pensja')) {
    answer = findUserDataValue(['salary', 'wynagrodzenie', 'expectedSalary', 'pensja', 'oczekiwane wynagrodzenie']) || '';
  } else if (lowerQuestion.includes('location') || lowerQuestion.includes('miasto') || lowerQuestion.includes('lokalizacja') || lowerQuestion.includes('city')) {
    answer = findUserDataValue(['location', 'city', 'miasto', 'lokalizacja']) || '';
  } else if (lowerQuestion.includes('address') || lowerQuestion.includes('adres')) {
    answer = findUserDataValue(['address', 'adres']) || '';
  } else if (lowerQuestion.includes('country') || lowerQuestion.includes('kraj')) {
    answer = findUserDataValue(['country', 'kraj', 'państwo']) || '';
  } else if (lowerQuestion.includes('language') || lowerQuestion.includes('język')) {
    answer = findUserDataValue(['languages', 'language', 'języki', 'język', 'języki obce']) || '';
  } else if (lowerQuestion.includes('skill') || lowerQuestion.includes('umiejętnoś')) {
    answer = findUserDataValue(['skills', 'skill', 'umiejętności', 'technologie']) || '';
  } else if (lowerQuestion.includes('contract') || lowerQuestion.includes('umowa')) {
    answer = findUserDataValue(['contract', 'umowa', 'typ umowy']) || '';
  } else if (lowerQuestion.includes('work mode') || lowerQuestion.includes('tryb pracy') || lowerQuestion.includes('remote')) {
    answer = findUserDataValue(['workMode', 'tryb pracy', 'work mode', 'remote', 'hybrid']) || '';
  } else if (lowerQuestion.includes('notification') || lowerQuestion.includes('powiadomienia')) {
    // For notifications - default to Yes
    return findInOptions('Yes', options) || 'Yes';
  } else if (lowerQuestion.includes('consent') || lowerQuestion.includes('zgoda') || lowerQuestion.includes('cookies')) {
    // For consent - default to Yes
    return findInOptions('Yes', options) || 'Yes';
  }

  // If we have an answer and options, try to match it to available options
  if (answer && options && options.length > 0) {
    return findInOptions(answer, options);
  }

  return answer;
}
