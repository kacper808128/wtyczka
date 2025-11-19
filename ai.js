async function getApiKey() {
  try {
    const response = await fetch(chrome.runtime.getURL('config.js'));
    if (!response.ok) {
      return null;
    }
    const text = await response.text();
    const match = text.match(/const\s+GEMINI_API_KEY\s*=\s*["'](.*)["']/);
    if (match && match[1]) {
      return match[1];
    }
    return null;
  } catch (error) {
    return null;
  }
}

async function getAIResponse(question, userData, options) {
  const apiKey = await getApiKey();

  if (apiKey && apiKey !== 'TWOJ_KLUCZ_API') {
    return getRealAIResponse(question, userData, apiKey, options);
  } else {
    return getMockAIResponse(question, userData);
  }
}

async function getRealAIResponse(question, userData, apiKey, options) {
  const API_URL = `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  let prompt = `You are an expert recruitment form filler. Your task is to select the best option from a list for a given question, based on the user's data.

User data: ${JSON.stringify(userData, null, 2)}
Question: "${question}"`;

  if (options) {
    prompt += `\nAvailable options: [${options.join(', ')}]`;
    prompt += `\n\nYour response MUST be one of the "Available options". Do not add any extra text, explanation, or punctuation. Just return the chosen option text exactly as it appears in the list.`;
  } else {
    prompt += `\n\nPlease provide only the answer to the question, without any extra text or explanation.`;
  }

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
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    const text = data.candidates[0].content.parts[0].text;
    return text.trim();

  } catch (error) {
    console.error('Error calling Gemini API:', error);
    return ''; // Return empty string on error
  }
}

function getMockAIResponse(question, userData) {
  const lowerQuestion = question.toLowerCase();

  // Simple keyword matching. This is a placeholder for real AI.
  if (lowerQuestion.includes('first name') || lowerQuestion.includes('imię')) {
    return userData.firstName;
  }
  if (lowerQuestion.includes('last name') || lowerQuestion.includes('nazwisko')) {
    return userData.lastName;
  }
  if (lowerQuestion.includes('email')) {
    return userData.email;
  }
  if (lowerQuestion.includes('phone') || lowerQuestion.includes('telefon')) {
    return userData.phone;
  }
  if (lowerQuestion.includes('linkedin')) {
    return userData.linkedin;
  }
  if (lowerQuestion.includes('github')) {
    return userData.github;
  }
  if (lowerQuestion.includes('website') || lowerQuestion.includes('strona')) {
    return userData.website;
  }
  if (lowerQuestion.includes('experience') || lowerQuestion.includes('doświadczenie')) {
    return userData.experience;
  }
  if (lowerQuestion.includes('education') || lowerQuestion.includes('wykształcenie')) {
    return userData.education;
  }

  return '';
}
