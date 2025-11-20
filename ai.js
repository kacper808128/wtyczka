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
      console.log(`[Gemini Filler] AI response for "${question}": "${aiAnswer}"`);
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

  // Check if CV data and custom prompt should be used
  const settings = await new Promise(resolve => {
    chrome.storage.local.get(['useCvData', 'cvAnalyzedData', 'useCustomPrompt', 'customPrompt'], resolve);
  });

  const useCvData = settings.useCvData || false;
  const cvData = settings.cvAnalyzedData;
  const useCustomPrompt = settings.useCustomPrompt || false;
  const customPrompt = settings.customPrompt || '';

  // Build context data string
  let contextData = `User data (contains information in both Polish and English):
${JSON.stringify(userData, null, 2)}`;

  // Add CV data if enabled and available
  if (useCvData && cvData) {
    console.log('[Gemini Filler] Using CV data for form filling');

    const yearsOfExperience = calculateYearsOfExperience(cvData.experience);

    contextData += `

CV Data (additional information extracted from user's resume):
- Years of experience: ${yearsOfExperience} years
- Latest position: ${cvData.experience?.[0]?.role || 'N/A'} at ${cvData.experience?.[0]?.company || 'N/A'}
- Education: ${cvData.education?.map(e => `${e.degree} in ${e.field} from ${e.institution}`).join(', ') || 'N/A'}
- Skills: ${cvData.skills?.join(', ') || 'N/A'}
- Languages: ${cvData.languages?.map(l => `${l.language} (${l.level})`).join(', ') || 'N/A'}
- Full experience history: ${JSON.stringify(cvData.experience || [])}
- Projects: ${JSON.stringify(cvData.projects || [])}
- Certifications: ${cvData.certifications?.join(', ') || 'N/A'}`;
  }

  // Build batch prompt - use custom or default
  let prompt;

  if (useCustomPrompt && customPrompt) {
    // Use custom prompt with variable substitution
    prompt = customPrompt;

    // Build questions list for substitution
    let questionsList = 'Questions to answer:\n';
    questions.forEach((q, idx) => {
      questionsList += `${idx}. ${q.question}`;

      // Add type information
      if (q.type === 'select' || q.type === 'radio') {
        if (q.options && q.options.length > 0) {
          questionsList += ` [Type: ${q.type.toUpperCase()}, Options: ${q.options.join(', ')}]`;
        }
      } else if (q.type === 'selectize') {
        if (q.options && q.options.length > 0) {
          questionsList += ` [Type: SELECTIZE, Options: ${q.options.join(', ')}]`;
        } else {
          // Selectize with no options - dropdown not opened yet, skip for now
          questionsList += ` [Type: SELECTIZE - OPTIONS NOT LOADED YET, return empty string ""]`;
        }
      } else if (q.type === 'datepicker') {
        questionsList += ` [Type: DATEPICKER, Format: YYYY-MM-DD]`;
      } else if (q.type) {
        questionsList += ` [Type: ${q.type.toUpperCase()}]`;
      } else if (q.options && q.options.length > 0) {
        // Fallback for questions with options but no type
        questionsList += ` [Options: ${q.options.join(', ')}]`;
      }

      questionsList += '\n';
    });

    // Substitute variables
    prompt = prompt.replace(/\{contextData\}/g, contextData);
    prompt = prompt.replace(/\{questions\}/g, questionsList);

    console.log('[Gemini Filler] Using custom prompt');
  } else {
    // Default prompt
    prompt = `You are an expert recruitment form filler. Your task is to match each question to the best answer from user data, or select the best option from provided choices.

${contextData}

MATCHING GUIDELINES:
- Questions may be in Polish or English
- userData fields may have Polish keys (e.g., "Imię i nazwisko", "Wykształcenie", "Doświadczenie")
- Match concepts, not exact words (e.g., "Education level" = "Wykształcenie", "Years of experience" = "Lata doświadczenia")
- For SELECT and RADIO questions with [Options], you MUST return one of the exact option texts
- For DATEPICKER questions, return date in YYYY-MM-DD format (e.g., "2025-03-15")
- If user data has a related value but it's not in the options list, find the closest matching option
- Use your judgment to match semantic meaning across languages

Questions to answer:
`;

    questions.forEach((q, idx) => {
      prompt += `${idx}. ${q.question}`;

      // Add type information
      if (q.type === 'select' || q.type === 'radio') {
        if (q.options && q.options.length > 0) {
          prompt += ` [Type: ${q.type.toUpperCase()}, Options: ${q.options.join(', ')}]`;
        }
      } else if (q.type === 'selectize') {
        if (q.options && q.options.length > 0) {
          prompt += ` [Type: SELECTIZE, Options: ${q.options.join(', ')}]`;
        } else {
          // Selectize with no options - dropdown not opened yet, return empty string
          prompt += ` [Type: SELECTIZE - OPTIONS NOT LOADED, return ""]`;
        }
      } else if (q.type === 'datepicker') {
        prompt += ` [Type: DATEPICKER, Format: YYYY-MM-DD]`;
      } else if (q.type) {
        prompt += ` [Type: ${q.type.toUpperCase()}]`;
      } else if (q.options && q.options.length > 0) {
        // Fallback for questions with options but no type
        prompt += ` [Options: ${q.options.join(', ')}]`;
      }

      prompt += '\n';
    });

    prompt += `
CRITICAL INSTRUCTIONS:
1. Return ONLY a valid JSON object, no other text before or after
2. Format: {"0": "answer0", "1": "answer1", "2": "answer2", ...}
3. Use the question index (0, 1, 2...) as string keys
4. When [Options] are provided, you MUST return exact option text (including any special characters)
5. Match user data values to options intelligently (e.g., if user has "Poland" and options include "Poland (+48)", return "Poland (+48)")
6. If you cannot determine answer from user data, use empty string ""
7. Do NOT add explanations, comments, or any text outside the JSON
8. Do NOT wrap response in markdown code blocks

Example response:
{"0": "John Smith", "1": "john@example.com", "2": "3-5 years", "3": "Poland (+48)"}`;
  }

  try {
    console.log(`[Gemini Filler] Batch processing ${questions.length} questions...`);
    console.log('[Gemini Filler] Batch questions:', questions.map((q, i) => `${i}. ${q.question}`).join('\n'));
    console.log('[Gemini Filler] User data keys:', Object.keys(userData).join(', '));

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
      console.log(`[Gemini Filler] Batch AI returned ${Object.keys(parsed).length} answers:`, parsed);

      // Log which questions got empty answers
      Object.keys(parsed).forEach(key => {
        if (!parsed[key] || parsed[key] === '') {
          console.warn(`[Gemini Filler] Batch AI returned empty for question ${key}: "${questions[key]?.question}"`);
        }
      });

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
  // Uses same logic as findBestMatch in content.js
  function findInOptions(value, options) {
    if (!options || !value) return value;

    // Polish to English country name mapping
    const countryTranslations = {
      'polska': 'poland',
      'niemcy': 'germany',
      'francja': 'france',
      'wielka brytania': 'united kingdom',
      'uk': 'united kingdom',
      'usa': 'united states',
      'stany zjednoczone': 'united states',
      'hiszpania': 'spain',
      'włochy': 'italy',
      'holandia': 'netherlands',
      'belgia': 'belgium',
      'szwecja': 'sweden',
      'norwegia': 'norway',
      'dania': 'denmark',
      'czechy': 'czech republic',
      'słowacja': 'slovakia',
      'austria': 'austria',
      'szwajcaria': 'switzerland'
    };

    const answer = value.toString();
    const lowerAnswer = answer.toLowerCase().trim();
    const translatedAnswer = countryTranslations[lowerAnswer] || answer;

    const normalizedAnswer = translatedAnswer.toLowerCase().replace(/[^\w\s]/g, ' ').trim();
    const answerWords = normalizedAnswer.split(/\s+/).filter(w => w.length > 0);

    // PASS 1: Try exact match first
    for (const option of options) {
      if (option.toLowerCase() === translatedAnswer.toLowerCase()) {
        return option;
      }
    }

    // PASS 2: Try substring match (prefer shorter/more specific)
    let substringMatch = null;
    for (const option of options) {
      const lowerOption = option.toLowerCase();
      const lowerTranslatedAnswer = translatedAnswer.toLowerCase();

      if (lowerOption.includes(lowerTranslatedAnswer) || lowerTranslatedAnswer.includes(lowerOption)) {
        if (!substringMatch || option.length < substringMatch.length) {
          substringMatch = option;
        }
      }
    }

    if (substringMatch) {
      return substringMatch;
    }

    // PASS 3: Word-based scoring
    let bestMatch = null;
    let maxScore = 0;

    for (const option of options) {
      const normalizedOption = option.toLowerCase().replace(/[^\w\s]/g, ' ').trim();
      const optionWords = normalizedOption.split(/\s+/).filter(w => w.length > 0);

      const score = answerWords.filter(word => optionWords.includes(word)).length;

      if (score > maxScore) {
        maxScore = score;
        bestMatch = option;
      }
    }

    return bestMatch || value; // Return best match or original if no match
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
  } else if (lowerQuestion.includes('start') || lowerQuestion.includes('rozpocząć') || lowerQuestion.includes('availability') || lowerQuestion.includes('dostępność') || lowerQuestion.includes('kiedy')) {
    answer = findUserDataValue(['startDate', 'availability', 'start', 'kiedy', 'od kiedy', 'rozpoczęcie', 'dostępność']) || '';
  } else if (lowerQuestion.includes('salary') || lowerQuestion.includes('wynagrodzenie') || lowerQuestion.includes('pensja')) {
    answer = findUserDataValue(['salary', 'wynagrodzenie', 'expectedSalary', 'pensja', 'oczekiwane wynagrodzenie']) || '';
  } else if (lowerQuestion.includes('location') || lowerQuestion.includes('miasto') || lowerQuestion.includes('lokalizacja') || lowerQuestion.includes('city')) {
    answer = findUserDataValue(['location', 'city', 'miasto', 'lokalizacja']) || '';
  } else if (lowerQuestion.includes('address') || lowerQuestion.includes('adres')) {
    answer = findUserDataValue(['address', 'adres']) || '';
  } else if (lowerQuestion.includes('country') || lowerQuestion.includes('kraj')) {
    answer = findUserDataValue(['country', 'kraj', 'państwo']) || '';
  } else if ((lowerQuestion.includes('język') || lowerQuestion.includes('language')) &&
             (lowerQuestion.includes('polski') || lowerQuestion.includes('polskiego') || lowerQuestion.includes('polish'))) {
    // Specific: Polish language proficiency
    answer = findUserDataValue(['język polski', 'polish', 'polski']) || 'C2'; // Default to native/C2
  } else if ((lowerQuestion.includes('język') || lowerQuestion.includes('language')) &&
             (lowerQuestion.includes('angielski') || lowerQuestion.includes('angielskiego') || lowerQuestion.includes('english'))) {
    // Specific: English language proficiency
    // Try to extract just English level from languages list
    const allLanguages = findUserDataValue(['languages', 'language', 'języki', 'język', 'języki obce']) || '';
    const englishMatch = allLanguages.match(/angielski\s*\(([^)]+)\)/i) || allLanguages.match(/english\s*\(([^)]+)\)/i);
    answer = englishMatch ? englishMatch[1] : findUserDataValue(['angielski', 'english']) || '';
  } else if (lowerQuestion.includes('language') || lowerQuestion.includes('język')) {
    // General: all languages
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

  // SPECIAL CASE: If answer looks like a relative date (e.g., "trzy miesiące od teraz")
  // and the question is about dates/availability, parse it to YYYY-MM-DD format
  if (answer && typeof answer === 'string') {
    const relativeDatePattern = /(od\s+)?teraz|natychmiast|immediately|miesiąc|miesięcy|miesiące|tydzień|tygodni|tygodnie|dzień|dni|rok|lata|lat|week|month|day|year/i;
    const isDateQuestion = lowerQuestion.includes('dostępność') || lowerQuestion.includes('availability') ||
                          lowerQuestion.includes('kiedy') || lowerQuestion.includes('start') ||
                          lowerQuestion.includes('rozpocz') || lowerQuestion.includes('data');

    if (isDateQuestion && relativeDatePattern.test(answer)) {
      // Try to parse relative date (e.g., "trzy miesiące od teraz" → "2025-02-20")
      const parsedDate = parseDateFromText(answer);
      if (parsedDate) {
        const year = parsedDate.getFullYear();
        const month = String(parsedDate.getMonth() + 1).padStart(2, '0');
        const day = String(parsedDate.getDate()).padStart(2, '0');
        const formattedDate = `${year}-${month}-${day}`;
        console.log(`[Mock AI] Converted relative date "${answer}" → "${formattedDate}"`);
        return formattedDate;
      }
    }
  }

  return answer;
}

// Date parsing helper (imported from content.js logic)
function parseDateFromText(text) {
  if (!text) return null;
  const textLower = text.toLowerCase().trim();

  // Word to number mapping (Polish and English)
  const wordToNumber = {
    'jeden': 1, 'jedna': 1, 'jedno': 1, 'one': 1,
    'dwa': 2, 'dwie': 2, 'two': 2,
    'trzy': 3, 'three': 3,
    'cztery': 4, 'four': 4,
    'pięć': 5, 'five': 5,
    'sześć': 6, 'six': 6,
    'siedem': 7, 'seven': 7,
    'osiem': 8, 'eight': 8,
    'dziewięć': 9, 'nine': 9,
    'dziesięć': 10, 'ten': 10,
    'jedenaście': 11, 'eleven': 11,
    'dwanaście': 12, 'twelve': 12
  };

  const now = new Date();

  // Parse word-based numbers (e.g., "trzy miesiące od teraz")
  const wordPattern = /(jeden|jedna|jedno|dwa|dwie|trzy|cztery|pięć|sześć|siedem|osiem|dziewięć|dziesięć|jedenaście|dwanaście|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(dni|dzień|day|days|tydzień|tygodni|tygodnie|week|weeks|miesiąc|miesiące|miesięcy|month|months|rok|lata|lat|year|years)/i;
  const wordMatch = textLower.match(wordPattern);

  if (wordMatch) {
    const word = wordMatch[1].toLowerCase();
    const amount = wordToNumber[word] || 1;
    const unitText = wordMatch[2].toLowerCase();

    let unit;
    if (/dni|dzień|day|days/i.test(unitText)) unit = 'days';
    else if (/tydzień|tygodni|tygodnie|week|weeks/i.test(unitText)) unit = 'weeks';
    else if (/miesiąc|miesiące|miesięcy|month|months/i.test(unitText)) unit = 'months';
    else if (/rok|lata|lat|year|years/i.test(unitText)) unit = 'years';

    if (unit) {
      const result = new Date(now);
      if (unit === 'days') result.setDate(result.getDate() + amount);
      else if (unit === 'weeks') result.setDate(result.getDate() + (amount * 7));
      else if (unit === 'months') result.setMonth(result.getMonth() + amount);
      else if (unit === 'years') result.setFullYear(result.getFullYear() + amount);
      return result;
    }
  }

  // Parse numeric patterns (e.g., "3 months from now")
  const numericPattern = /(\d+)\s*(dni|dzień|day|days|tydzień|tygodni|tygodnie|week|weeks|miesiąc|miesiące|miesięcy|month|months|rok|lata|lat|year|years)/i;
  const numericMatch = textLower.match(numericPattern);

  if (numericMatch) {
    const amount = parseInt(numericMatch[1]);
    const unitText = numericMatch[2].toLowerCase();

    let unit;
    if (/dni|dzień|day|days/i.test(unitText)) unit = 'days';
    else if (/tydzień|tygodni|tygodnie|week|weeks/i.test(unitText)) unit = 'weeks';
    else if (/miesiąc|miesiące|miesięcy|month|months/i.test(unitText)) unit = 'months';
    else if (/rok|lata|lat|year|years/i.test(unitText)) unit = 'years';

    if (unit) {
      const result = new Date(now);
      if (unit === 'days') result.setDate(result.getDate() + amount);
      else if (unit === 'weeks') result.setDate(result.getDate() + (amount * 7));
      else if (unit === 'months') result.setMonth(result.getMonth() + amount);
      else if (unit === 'years') result.setFullYear(result.getFullYear() + amount);
      return result;
    }
  }

  // "natychmiast" / "immediately" → today
  if (/natychmiast|immediately|teraz|now|dziś|today/i.test(textLower)) {
    return now;
  }

  return null;
}

// ==================== CV Analysis Functions ====================

/**
 * Analyze CV file and extract structured data using AI
 * @param {Object} cvFile - CV file object with dataUrl and type
 * @returns {Promise<Object>} Structured CV data
 */
async function analyzeCVWithAI(cvFile) {
  try {
    console.log('[CV Analyzer] Starting CV analysis...');

    const apiKey = await getApiKey();
    if (!apiKey) {
      throw new Error('Brak klucza API. Skonfiguruj klucz w ustawieniach.');
    }

    // Extract text from CV
    let cvText = '';

    if (cvFile.type === 'application/pdf') {
      // For PDF, we'll send the data URL directly to Gemini Vision API
      // Gemini can process PDF directly
      cvText = await extractTextFromPDF(cvFile.dataUrl, apiKey);
    } else {
      // For other formats, try to extract text (simplified)
      throw new Error('Obecnie obsługiwane są tylko pliki PDF. Wkrótce dodamy wsparcie dla innych formatów.');
    }

    console.log('[CV Analyzer] Extracted text length:', cvText.length);

    // Structure data using AI
    const structuredData = await structureCVDataWithAI(cvText, apiKey);

    // Add metadata
    structuredData.analyzedAt = Date.now();
    structuredData.sourceFile = cvFile.name;

    // Save to storage
    await new Promise((resolve, reject) => {
      chrome.storage.local.set({ cvAnalyzedData: structuredData }, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });

    console.log('[CV Analyzer] Analysis complete, data saved');
    return structuredData;

  } catch (error) {
    console.error('[CV Analyzer] Error:', error);
    throw error;
  }
}

/**
 * Extract text from PDF using Gemini Vision API
 * @param {string} pdfDataUrl - PDF file as data URL
 * @param {string} apiKey - Gemini API key
 * @returns {Promise<string>} Extracted text
 */
async function extractTextFromPDF(pdfDataUrl, apiKey) {
  try {
    const base64Data = pdfDataUrl.split(',')[1];

    const API_URL = `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [
            {
              inline_data: {
                mime_type: 'application/pdf',
                data: base64Data
              }
            },
            {
              text: 'Extract all text content from this CV/resume document. Return only the raw text without any formatting or additional commentary.'
            }
          ]
        }]
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Gemini API error: ${errorData.error?.message || response.statusText}`);
    }

    const data = await response.json();
    const extractedText = data.candidates[0]?.content?.parts[0]?.text || '';

    if (!extractedText) {
      throw new Error('Nie udało się wyciągnąć tekstu z PDF');
    }

    return extractedText;

  } catch (error) {
    console.error('[CV Analyzer] PDF extraction error:', error);
    throw error;
  }
}

/**
 * Structure CV data using AI
 * @param {string} cvText - Raw CV text
 * @param {string} apiKey - Gemini API key
 * @returns {Promise<Object>} Structured CV data
 */
async function structureCVDataWithAI(cvText, apiKey) {
  const prompt = `Przeanalizuj poniższe CV i wyciągnij WSZYSTKIE dane w formacie JSON. Zwróć TYLKO JSON bez żadnego dodatkowego tekstu.

Struktura JSON powinna zawierać:
{
  "personal": {
    "firstName": "",
    "lastName": "",
    "email": "",
    "phone": "",
    "city": "",
    "country": "",
    "linkedin": "",
    "github": "",
    "website": ""
  },
  "experience": [
    {
      "company": "",
      "role": "",
      "startDate": "YYYY-MM",
      "endDate": "YYYY-MM lub 'present'",
      "description": "",
      "achievements": []
    }
  ],
  "education": [
    {
      "degree": "Licencjat/Magister/Inżynier/etc",
      "institution": "",
      "field": "",
      "startDate": "YYYY-MM",
      "endDate": "YYYY-MM"
    }
  ],
  "skills": [],
  "languages": [
    {
      "language": "Angielski",
      "level": "C1/B2/etc"
    }
  ],
  "projects": [
    {
      "name": "",
      "description": "",
      "technologies": []
    }
  ],
  "certifications": []
}

CV:
${cvText}

WAŻNE: Zwróć TYLKO JSON, bez żadnego dodatkowego tekstu, komentarzy ani formatowania markdown.`;

  const API_URL = `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  try {
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
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Gemini API error: ${errorData.error?.message || response.statusText}`);
    }

    const data = await response.json();
    let jsonText = data.candidates[0]?.content?.parts[0]?.text || '';

    if (!jsonText) {
      throw new Error('Brak odpowiedzi od AI');
    }

    // Clean up the response - remove markdown code blocks if present
    jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    // Parse JSON
    const structuredData = JSON.parse(jsonText);

    console.log('[CV Analyzer] Structured data:', structuredData);
    return structuredData;

  } catch (error) {
    console.error('[CV Analyzer] Structuring error:', error);
    throw error;
  }
}

/**
 * Calculate years of experience from experience array
 * @param {Array} experiences - Array of experience objects
 * @returns {number} Total years of experience
 */
function calculateYearsOfExperience(experiences) {
  if (!experiences || !Array.isArray(experiences) || experiences.length === 0) {
    return 0;
  }

  let totalMonths = 0;

  experiences.forEach(exp => {
    try {
      const start = new Date(exp.startDate);
      const end = exp.endDate === 'present' || exp.endDate === 'obecnie' ?
        new Date() :
        new Date(exp.endDate);

      if (!isNaN(start) && !isNaN(end)) {
        const months = (end - start) / (1000 * 60 * 60 * 24 * 30.44); // Average days per month
        totalMonths += Math.max(0, months);
      }
    } catch (error) {
      console.warn('[CV Analyzer] Error calculating experience duration:', error);
    }
  });

  return Math.floor(totalMonths / 12);
}
