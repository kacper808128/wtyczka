// Inject the stylesheet
const link = document.createElement('link');
link.rel = 'stylesheet';
link.type = 'text/css';
link.href = chrome.runtime.getURL('styles.css');
document.head.appendChild(link);

// Inject learning.js
const script = document.createElement('script');
script.src = chrome.runtime.getURL('learning.js');
document.head.appendChild(script);

// ==================== Learning System Bridge ====================
// Content scripts run in isolated world and can't access page's window directly
// These helpers use custom DOM events to communicate with learning.js (page context)

let requestIdCounter = 0;

async function captureQuestionBridge(element, answer) {
  return new Promise((resolve) => {
    const requestId = `req_${Date.now()}_${requestIdCounter++}`;

    // Extract question text and field info from element (can't pass DOM element through event)
    const questionText = getQuestionForInput(element);
    const fieldType = element.type || element.tagName.toLowerCase();
    const fieldName = element.name || '';
    const fieldId = element.id || '';

    const responseHandler = (event) => {
      if (event.detail.requestId === requestId) {
        clearTimeout(timeoutId);  // Clear timeout on success
        document.removeEventListener('learning:captureQuestionResponse', responseHandler);
        resolve(event.detail.hash);
      }
    };

    document.addEventListener('learning:captureQuestionResponse', responseHandler);

    // Timeout after 5 seconds
    const timeoutId = setTimeout(() => {
      document.removeEventListener('learning:captureQuestionResponse', responseHandler);
      console.warn('[Learning Bridge] captureQuestion timeout');
      resolve(null);
    }, 5000);

    // Pass data, not DOM element (can't cross isolated world boundary)
    document.dispatchEvent(new CustomEvent('learning:captureQuestion', {
      detail: { questionText, answer, fieldType, fieldName, fieldId, requestId }
    }));
  });
}

async function getSuggestionForFieldBridge(element) {
  return new Promise((resolve) => {
    const requestId = `req_${Date.now()}_${requestIdCounter++}`;

    // Extract question text from element (can't pass DOM element through event)
    const questionText = getQuestionForInput(element);

    const responseHandler = (event) => {
      if (event.detail.requestId === requestId) {
        clearTimeout(timeoutId);  // Clear timeout on success
        document.removeEventListener('learning:getSuggestionResponse', responseHandler);
        resolve(event.detail.suggestion);
      }
    };

    document.addEventListener('learning:getSuggestionResponse', responseHandler);

    // Timeout after 5 seconds
    const timeoutId = setTimeout(() => {
      document.removeEventListener('learning:getSuggestionResponse', responseHandler);
      console.warn('[Learning Bridge] getSuggestion timeout');
      resolve(null);
    }, 5000);

    // Pass data, not DOM element
    document.dispatchEvent(new CustomEvent('learning:getSuggestion', {
      detail: { questionText, requestId }
    }));
  });
}

function addFeedbackButtonBridge(element, questionHash) {
  // For feedback button, we need to store reference to element
  // Store it with a unique ID that can be used to find it later
  const elementId = `learning_feedback_${Date.now()}_${requestIdCounter++}`;
  element.setAttribute('data-learning-feedback-id', elementId);

  document.dispatchEvent(new CustomEvent('learning:addFeedbackButton', {
    detail: { elementId, questionHash }
  }));
}

// Storage bridge - page context can't access chrome.storage, so we handle it here
document.addEventListener('learning:storageGet', (event) => {
  console.log('[Storage Bridge] 📥 Received storageGet request:', event.detail);
  const { key, requestId } = event.detail;

  chrome.storage.local.get([key], (result) => {
    console.log('[Storage Bridge] 📤 Got data from storage, sending response for requestId:', requestId, 'data length:', result[key]?.length);

    document.dispatchEvent(new CustomEvent('learning:storageGetResponse', {
      detail: { data: result[key], requestId }
    }));

    console.log('[Storage Bridge] ✅ Response event dispatched for requestId:', requestId);
  });
});

document.addEventListener('learning:storageSet', (event) => {
  console.log('[Storage Bridge] 📥 Received storageSet request:', event.detail.requestId, 'key:', event.detail.key);
  const { key, value, requestId } = event.detail;

  chrome.storage.local.set({ [key]: value }, () => {
    console.log('[Storage Bridge] 📤 Data saved to storage, sending response for requestId:', requestId);

    document.dispatchEvent(new CustomEvent('learning:storageSetResponse', {
      detail: { success: true, requestId }
    }));

    console.log('[Storage Bridge] ✅ Response event dispatched for requestId:', requestId);
  });
});

console.log('[Learning Bridge] Event-based communication helpers initialized');

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "fill_form") {
    showOverlay("Wypełnianie w toku...");

    chrome.storage.sync.get('userData', (result) => {
      // Check for storage errors
      if (chrome.runtime.lastError) {
        console.error('[Gemini Filler] Storage error:', chrome.runtime.lastError);
        showErrorOverlay('Błąd odczytu danych: ' + chrome.runtime.lastError.message);
        setTimeout(hideOverlay, 3000);
        sendResponse({ status: "error", message: chrome.runtime.lastError.message });
        return;
      }

      const data = result.userData;
      if (!data || Object.keys(data).length === 0) {
        console.log('[Gemini Filler] No user data found. Please set your data in the extension options.');
        showErrorOverlay('Brak danych użytkownika. Ustaw swoje dane w opcjach rozszerzenia.');
        setTimeout(hideOverlay, 3000);
        sendResponse({ status: "error", message: "No user data" });
        return;
      }

      (async () => {
        try {
          await fillFormWithAI(data);
          showSuccessOverlay();
          setTimeout(hideOverlay, 2000);
          sendResponse({ status: "success" });
        } catch (error) {
          console.error('[Gemini Filler] Error filling form:', error);
          showErrorOverlay('Błąd wypełniania: ' + error.message);
          setTimeout(hideOverlay, 3000);
          sendResponse({ status: "error", message: error.message });
        }
      })();
    });

    return true; // Indicates that the response is sent asynchronously
  }
});

async function fillFormWithAI(userData, processedElements = new Set(), depth = 0, isRetry = false, missingFields = null) {
  console.log(`[Gemini Filler] fillFormWithAI called: depth=${depth}, isRetry=${isRetry}, missingFields=${missingFields ? `array[${missingFields.length}]` : 'null'}`);

  // Helper function to check if answer is a placeholder or invalid response (AI sometimes returns these)
  const isPlaceholder = (text) => {
    if (!text) return true;
    const trimmed = text.trim();
    // Check for placeholder patterns like "-- Wybierz --", "Select", etc.
    const placeholderPatterns = /^(--|select|choose|wybierz|seleccione|wählen)/i;
    if (placeholderPatterns.test(trimmed)) return true;
    // Check for AI's "I don't know" type responses in parentheses
    if (trimmed.startsWith('(') && trimmed.endsWith(')')) return true;
    // Check for AI's "I don't know" type responses
    const invalidResponsePatterns = /(not available|please provide|information is not|cannot be answered|cannot be determined|brak danych|nie ma informacji|requires.*free-text|provided data)/i;
    if (invalidResponsePatterns.test(trimmed)) return true;
    return false;
  };

  // Track missing fields only on first call (depth 0)
  if (depth === 0 && !missingFields) {
    missingFields = [];
    console.log('[Gemini Filler] Initialized missingFields array');
  }

  // Prevent infinite recursion
  const MAX_DEPTH = 10;
  if (depth >= MAX_DEPTH) {
    console.warn('[Gemini Filler] Maximum recursion depth reached. Stopping form filling.');
    return;
  }

  // First, handle custom upload buttons (div-based resume upload buttons)
  await handleCustomResumeButtons(processedElements);

  let formElements;
  try {
    formElements = document.querySelectorAll('input, textarea, select, button[aria-haspopup="dialog"], div[role="radiogroup"]');
  } catch (error) {
    console.error('[Gemini Filler] Error querying form elements:', error);
    throw new Error('Failed to find form elements');
  }

  let aChangeWasMade = false;

  // BATCH PROCESSING - only on first call (depth 0, !isRetry)
  // This processes all visible fields at once for efficiency
  if (depth === 0 && !isRetry) {
    console.log('[Gemini Filler] Starting batch processing mode...');

    const batchQuestions = [];
    const batchElements = [];
    const batchMetadata = []; // Store element metadata

    // Collect all questions
    for (const element of formElements) {
      if (processedElements.has(element)) continue;
      if (!document.contains(element)) continue;

      // Skip special types that need individual handling
      if (element.type === 'file' || element.type === 'radio' || element.type === 'checkbox') {
        continue;
      }

      const question = getQuestionForInput(element);
      if (!question) continue;

      let optionsText = null;
      try {
        if (element.tagName === 'SELECT') {
          // Filter out placeholder options (like "-- Wybierz --", "Select", etc.)
          const placeholderPatterns = /^(--|select|choose|wybierz|seleccione|wählen)/i;
          optionsText = Array.from(element.options)
            .map(o => o.text)
            .filter(t => t.trim() && !placeholderPatterns.test(t.trim()));
        } else if (element.getAttribute('role') === 'radiogroup') {
          const radioButtons = element.querySelectorAll('button[role="radio"]');
          optionsText = Array.from(radioButtons).map(rb => {
            const label = document.querySelector(`label[for="${rb.id}"]`) || rb.closest('div')?.querySelector('label');
            return label ? label.textContent.trim() : rb.getAttribute('aria-label') || '';
          }).filter(t => t);
        } else if (element.tagName === 'BUTTON' && element.getAttribute('aria-haspopup') === 'dialog') {
          // Custom dropdown - we'll handle these individually later
          continue;
        }
      } catch (error) {
        console.warn('[Gemini Filler] Error extracting options:', error);
        continue;
      }

      batchQuestions.push({
        question: question,
        options: optionsText
      });
      batchElements.push(element);
      batchMetadata.push({ optionsText });
    }

    if (batchQuestions.length > 0) {
      console.log(`[Gemini Filler] Collected ${batchQuestions.length} questions for batch processing`);

      // Get batch answers from AI
      const batchAnswers = await getBatchAIResponse(batchQuestions, userData);

      // Fill all fields from batch
      for (let i = 0; i < batchElements.length; i++) {
        const element = batchElements[i];
        let answer = batchAnswers[i];
        const metadata = batchMetadata[i];
        let answerSource = null; // Track if answer is from 'ai' or 'mock'

        // If batch AI returned empty or placeholder, try mock response as fallback
        if (!answer || answer === '' || isPlaceholder(answer)) {
          if (isPlaceholder(answer)) {
            console.log(`[Gemini Filler] Batch AI returned placeholder "${answer}" for: "${batchQuestions[i].question}", trying mock fallback...`);
          } else {
            console.log(`[Gemini Filler] No batch answer for: "${batchQuestions[i].question}", trying mock fallback...`);
          }

          const mockAnswer = getMockAIResponse(batchQuestions[i].question, userData, metadata.optionsText);
          if (mockAnswer && !isPlaceholder(mockAnswer)) {
            answer = mockAnswer;
            answerSource = 'mock';
            console.log(`[Gemini Filler] Mock fallback found: "${answer}"`);
          } else {
            console.log(`[Gemini Filler] No mock fallback either, will retry in second pass`);
            // Track this as potentially missing data
            if (missingFields && depth === 0) {
              console.log(`[Gemini Filler] Adding to missingFields: "${batchQuestions[i].question}" (depth=${depth}, missingFields.length before=${missingFields.length})`);
              missingFields.push({
                question: batchQuestions[i].question,
                reason: 'Brak danych w bazie wiedzy',
                element: element
              });
              console.log(`[Gemini Filler] missingFields.length after=${missingFields.length}`);
            } else {
              console.log(`[Gemini Filler] NOT adding to missingFields: missingFields=${missingFields ? 'exists' : 'null'}, depth=${depth}`);
            }
            continue;  // Don't add to processedElements - let second pass retry with full AI
          }
        } else {
          // Answer came from batch AI - check if it's actually from userData
          // Check both exact match and partial match (e.g., "Wyższe" in userData matches "Wyższe - magister" from SELECT)
          const answerLower = answer.toLowerCase();

          // Debug: log all userData values for this check
          console.log(`[Gemini Filler] Checking if answer "${answer}" matches any userData value...`);
          const userDataValues = Object.entries(userData).map(([key, val]) => {
            if (!val) return null;
            return { key, value: val, valueLower: val.toString().toLowerCase() };
          }).filter(Boolean);
          console.log(`[Gemini Filler] userData values to check:`, userDataValues.map(v => `${v.key}="${v.value}"`).join(', '));

          const isFromUserData = Object.values(userData).some(val => {
            if (!val) return false;
            const valStr = val.toString().toLowerCase();
            // Exact match OR userData value is contained in answer OR answer is contained in userData value
            // Use >= 3 instead of > 3 to catch values like "+48" (exactly 3 chars)
            const matches = valStr === answerLower ||
                   (valStr.length >= 3 && answerLower.includes(valStr)) ||
                   (answerLower.length >= 3 && valStr.includes(answerLower));

            if (matches) {
              console.log(`[Gemini Filler] ✓ Match found! answer "${answer}" matches userData value "${val}"`);
            }
            return matches;
          });

          answerSource = isFromUserData ? 'mock' : 'ai';
          if (isFromUserData) {
            console.log(`[Gemini Filler] Answer "${answer}" matches userData value, marking as mock`);
          } else {
            console.log(`[Gemini Filler] Answer "${answer}" does NOT match any userData value, marking as ai`);
          }
        }

        try {
          console.log(`[Gemini Filler] Batch filling: "${batchQuestions[i].question}" = "${answer}"`);

          let filled = false;  // Track if we actually filled the field

          if (element.tagName === 'SELECT') {
            const bestMatchText = findBestMatch(answer, metadata.optionsText);
            console.log(`[Gemini Filler] findBestMatch("${answer}") -> "${bestMatchText}" from ${metadata.optionsText?.length || 0} options`);
            if (bestMatchText) {
              const bestMatchOption = Array.from(element.options).find(o => o.text === bestMatchText);
              if (bestMatchOption) {
                const oldValue = element.value;
                element.value = bestMatchOption.value;
                element.selectedIndex = bestMatchOption.index;
                console.log(`[Gemini Filler] SELECT: set value from "${oldValue}" to "${element.value}", selectedIndex=${element.selectedIndex}, text="${bestMatchOption.text}"`);

                // Add delay before events to prevent stack overflow
                await new Promise(resolve => setTimeout(resolve, 200));
                const inputEvent = new Event('input', { bubbles: true });
                inputEvent._autofilledByExtension = true;
                const changeEvent = new Event('change', { bubbles: true });
                changeEvent._autofilledByExtension = true;
                element.dispatchEvent(inputEvent);
                element.dispatchEvent(changeEvent);

                // Verify value stuck after events
                await new Promise(resolve => setTimeout(resolve, 100));
                console.log(`[Gemini Filler] SELECT: dispatched input+change events, current value="${element.value}", selectedIndex=${element.selectedIndex}`);

                // Double-check: read selected option text
                const currentSelectedOption = element.options[element.selectedIndex];
                console.log(`[Gemini Filler] SELECT: currently selected option text="${currentSelectedOption?.text}", visible in UI=${element.offsetParent !== null}`);

                aChangeWasMade = true;
                filled = true;
              } else {
                console.warn(`[Gemini Filler] Matched text "${bestMatchText}" but option not found in SELECT`);
              }
            } else {
              console.warn(`[Gemini Filler] findBestMatch failed for answer "${answer}" in SELECT with ${metadata.optionsText?.length} options`);
            }
          } else if (element.getAttribute('role') === 'radiogroup') {
            const radioButtons = Array.from(element.querySelectorAll('button[role="radio"]'));
            const optionDetails = radioButtons.map(rb => {
              const label = document.querySelector(`label[for="${rb.id}"]`) || rb.closest('div')?.querySelector('label');
              return {
                button: rb,
                text: label ? label.textContent.trim() : rb.getAttribute('aria-label') || ''
              };
            });

            const bestMatchText = findBestMatch(answer, optionDetails.map(o => o.text));
            console.log(`[Gemini Filler] findBestMatch("${answer}") -> "${bestMatchText}" for radiogroup with ${optionDetails.length} options`);
            if (bestMatchText) {
              const matchingOption = optionDetails.find(o => o.text === bestMatchText);
              if (matchingOption) {
                matchingOption.button.click();
                aChangeWasMade = true;
                filled = true;
              } else {
                console.warn(`[Gemini Filler] Matched text "${bestMatchText}" but radio button not found`);
              }
            } else {
              console.warn(`[Gemini Filler] findBestMatch failed for answer "${answer}" in radiogroup with ${optionDetails.length} options`);
            }
          } else {
            // Text input, textarea, etc.
            element.value = answer;
            await new Promise(resolve => setTimeout(resolve, 200));
            const inputEvent = new Event('input', { bubbles: true });
            inputEvent._autofilledByExtension = true;
            const changeEvent = new Event('change', { bubbles: true });
            changeEvent._autofilledByExtension = true;
            element.dispatchEvent(inputEvent);
            element.dispatchEvent(changeEvent);
            aChangeWasMade = true;
            filled = true;
            console.log(`[Gemini Filler] Filled text input with: "${answer}"`);
          }

          // Only mark as processed if we actually filled it
          if (filled) {
            processedElements.add(element);
            console.log(`[Gemini Filler] Marked element as processed: "${batchQuestions[i].question}"`);
          } else {
            console.log(`[Gemini Filler] Element NOT marked as processed (will retry): "${batchQuestions[i].question}"`);
          }

          // Capture for learning (only if answer from AI, not mock, and not placeholder)
          if (filled && answerSource === 'ai' && !isPlaceholder(answer)) {
            try {
              const capturedHash = await captureQuestionBridge(element, answer);
              if (capturedHash) {
                console.log(`%c[SYSTEM UCZENIA] 💾 Zapisano pytanie: "${batchQuestions[i].question}" → "${answer}"`, 'color: purple; font-weight: bold;');
                console.log(`%c   Kliknij 👍/👎 obok pola żeby zwiększyć pewność odpowiedzi!`, 'color: purple;');
                addFeedbackButtonBridge(element, capturedHash);
              }
            } catch (err) {
              console.warn('[Gemini Filler] Error capturing batch question:', err);
            }
          } else if (filled && answerSource === 'ai' && isPlaceholder(answer)) {
            console.log(`[Gemini Filler] Skipping learning capture for placeholder answer: "${answer}"`);
          }
        } catch (error) {
          console.error(`[Gemini Filler] Error filling batch element:`, error);
        }
      }
    }

    // Now handle special types individually
    for (const element of formElements) {
      if (processedElements.has(element)) continue;
      if (!document.contains(element)) continue;

      try {
        if (element.type === 'file') {
          const question = getQuestionForInput(element);
          const keywords = ['cv', 'resume', 'życiorys', 'załącz', 'plik'];
          if (question && keywords.some(keyword => question.toLowerCase().includes(keyword))) {
            await handleFileInput(element);
            processedElements.add(element);
          }
          continue;
        }

        if (element.type === 'radio') {
          await handleRadioButton(element, userData, processedElements);
          continue;
        }

        if (element.type === 'checkbox') {
          await handleCheckbox(element, userData);
          processedElements.add(element);
          continue;
        }

        // Custom dropdowns
        if (element.tagName === 'BUTTON' && element.getAttribute('aria-haspopup') === 'dialog') {
          const question = getQuestionForInput(element);
          if (!question) {
            console.log('[Gemini Filler] Custom dropdown: no question found, skipping');
            continue;
          }

          let filled = false;  // Track if we successfully filled this

          try {
            console.log(`[Gemini Filler] Processing custom dropdown: "${question}"`);

            const result = await getAIResponse(question, userData, null);
            const answer = result.answer;
            const answerSource = result.source;

            if (!answer) {
              console.log(`[Gemini Filler] Custom dropdown: no answer for "${question}"`);
              continue;  // Don't mark as processed - let second pass retry
            }

            console.log(`[Gemini Filler] Custom dropdown: got answer "${answer}" from ${answerSource}`);

            element.click();
            await new Promise(resolve => setTimeout(resolve, 1000));

            const dialogId = element.getAttribute('aria-controls');
            let optionsInDialog = [];
            if (dialogId) {
              const dialog = document.getElementById(dialogId);
              if (dialog) {
                optionsInDialog = Array.from(dialog.querySelectorAll('[role="option"]'));
              }
            } else {
              optionsInDialog = Array.from(document.querySelectorAll('[role="option"]'));
            }

            console.log(`[Gemini Filler] Custom dropdown: found ${optionsInDialog.length} options in dialog`);

            // Debug: Show first 10 options to see format
            const optionsText = optionsInDialog.map(o => o.textContent.trim());
            const first10 = optionsText.slice(0, 10);
            console.log(`[Gemini Filler] Custom dropdown: first 10 options:`, first10);

            // Debug: Find options containing "poland" or "polska"
            const polandOptions = optionsText.filter(o =>
              o.toLowerCase().includes('poland') || o.toLowerCase().includes('polska')
            );
            console.log(`[Gemini Filler] Custom dropdown: options containing "poland"/"polska":`, polandOptions);

            const bestMatch = findBestMatch(answer, optionsText);
            console.log(`[Gemini Filler] Custom dropdown: findBestMatch("${answer}") -> "${bestMatch}"`);

            if (bestMatch) {
              const bestMatchElement = optionsInDialog.find(o => o.textContent === bestMatch);
              if (bestMatchElement) {
                bestMatchElement.click();
                aChangeWasMade = true;
                filled = true;
                console.log(`[Gemini Filler] Custom dropdown: successfully clicked option "${bestMatch}"`);

                // Capture for learning and add feedback button (only for AI answers, not placeholders)
                if (answerSource === 'ai' && !isPlaceholder(answer)) {
                  try {
                    const capturedHash = await captureQuestionBridge(element, answer);
                    if (capturedHash) {
                      addFeedbackButtonBridge(element, capturedHash);
                    }
                  } catch (err) {
                    console.warn('[Gemini Filler] Error capturing custom dropdown question:', err);
                  }
                }
              } else {
                console.warn(`[Gemini Filler] Custom dropdown: matched text "${bestMatch}" but element not found`);
              }
            } else {
              console.warn(`[Gemini Filler] Custom dropdown: no match for "${answer}" among ${optionsInDialog.length} options`);
            }

            // Only mark as processed if we successfully filled it
            if (filled) {
              processedElements.add(element);
              console.log(`[Gemini Filler] Custom dropdown: marked as processed`);
            } else {
              console.log(`[Gemini Filler] Custom dropdown: NOT marked as processed (will retry in second pass)`);
            }
          } catch (e) {
            console.error(`[Gemini Filler] Error with custom dropdown:`, e);
            // Don't add to processedElements on error - allow retry
          }
          continue;
        }
      } catch (error) {
        console.error('[Gemini Filler] Error processing special element:', error);
      }
    }

    // Recursively check for new fields
    if (aChangeWasMade) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      await fillFormWithAI(userData, processedElements, depth + 1, isRetry, missingFields);
    }

    // Second verification pass
    if (!isRetry) {
      await new Promise(resolve => setTimeout(resolve, 500));

      const allFields = document.querySelectorAll('input:not([type="file"]):not([type="radio"]):not([type="checkbox"]):not([type="submit"]):not([type="button"]):not([type="hidden"]), textarea, select');

      let missedFields = [];
      for (const field of allFields) {
        if (!processedElements.has(field) &&
            field.offsetParent !== null &&
            !field.value &&
            !field.disabled &&
            !field.readOnly) {
          missedFields.push(field);
        }
      }

      if (missedFields.length > 0) {
        console.log(`[Gemini Filler] Second pass: found ${missedFields.length} missed fields, retrying...`);
        await fillFormWithAI(userData, processedElements, 0, true, missingFields);
      } else {
        console.log('[Gemini Filler] Second pass: no missed fields found.');
      }
    }

    // Show summary of missing fields if any (BEFORE return!)
    console.log(`[Gemini Filler] Checking missing fields summary: missingFields=${missingFields ? 'exists' : 'null'}, length=${missingFields?.length || 0}`);
    if (missingFields && missingFields.length > 0) {
      console.log(`[Gemini Filler] Displaying missing fields summary for ${missingFields.length} fields:`, missingFields.map(f => f.question));
      showMissingFieldsSummary(missingFields, userData);
    } else {
      console.log('[Gemini Filler] No missing fields to display, or missingFields is empty');
    }

    return; // Exit early after batch processing
  }

  // INDIVIDUAL PROCESSING - for dynamic fields (depth > 0) or retry pass
  console.log(`[Gemini Filler] Individual processing mode (depth: ${depth}, retry: ${isRetry})...`);

  for (const element of formElements) {
    if (processedElements.has(element)) {
      continue;
    }
    processedElements.add(element);

    try {
      // Check if element is still in DOM
      if (!document.contains(element)) {
        continue;
      }

      if (element.type === 'file') {
        const question = getQuestionForInput(element);
        const keywords = ['cv', 'resume', 'życiorys', 'załącz', 'plik'];
        if (question && keywords.some(keyword => question.toLowerCase().includes(keyword))) {
          await handleFileInput(element);
        }
        continue;
      }

      // Handle radio buttons
      if (element.type === 'radio') {
        await handleRadioButton(element, userData, processedElements);
        continue;
      }

      // Handle checkboxes
      if (element.type === 'checkbox') {
        await handleCheckbox(element, userData);
        continue;
      }

      const question = getQuestionForInput(element);
      if (!question) {
        continue;
      }

      let optionsText = null;

      try {
        if (element.tagName === 'SELECT') {
          optionsText = Array.from(element.options).map(o => o.text);
        } else if (element.getAttribute('role') === 'radiogroup') {
          const radioButtons = element.querySelectorAll('button[role="radio"]');
          optionsText = Array.from(radioButtons).map(rb => {
            const label = document.querySelector(`label[for="${rb.id}"]`) || rb.closest('div')?.querySelector('label');
            return label ? label.textContent.trim() : rb.getAttribute('aria-label') || '';
          });
        }
      } catch (error) {
        console.warn('[Gemini Filler] Error extracting options for element:', error);
        continue;
      }

      let answer;
      let questionHash = null;
      let answerSource = null; // 'learned', 'mock', 'ai'

      // First, try to get suggestion from learned questions
      try {
        const suggestion = await getSuggestionForFieldBridge(element);
        if (suggestion && suggestion.confidence > 0.75) {
          answer = suggestion.answer;
          questionHash = suggestion.questionHash;
          answerSource = 'learned';
          console.log(`%c[SYSTEM UCZENIA] ✅ Używam nauczoneј odpowiedzi dla "${question}"`, 'color: green; font-weight: bold;');
          console.log(`%c   Odpowiedź: "${answer}" | Pewność: ${(suggestion.confidence * 100).toFixed(0)}% | Źródło: ${suggestion.source}`, 'color: green;');
        } else if (suggestion) {
          console.log(`%c[SYSTEM UCZENIA] ⏳ Znaleziono odpowiedź dla "${question}" ale pewność zbyt niska: ${(suggestion.confidence * 100).toFixed(0)}% (wymaga ≥75%)`, 'color: orange;');
        } else {
          console.log(`%c[SYSTEM UCZENIA] ℹ️ Brak nauczoneј odpowiedzi dla "${question}" - używam AI`, 'color: blue;');
        }
      } catch (err) {
        console.warn('[Gemini Filler] Error getting learned suggestion:', err);
      }

      // If no learned answer, use AI/mock
      if (!answer) {
        try {
          const result = await getAIResponse(question, userData, optionsText);
          answer = result.answer;
          answerSource = result.source;
        } catch (error) {
          console.error(`[Gemini Filler] AI error for question "${question}":`, error);
          // Continue to next field instead of failing completely
          continue;
        }
      }

      if (!answer) {
        continue;
      }

      try {
        if (element.tagName === 'SELECT') {
          const bestMatchText = findBestMatch(answer, optionsText);
          if (bestMatchText) {
            const bestMatchOption = Array.from(element.options).find(o => o.text === bestMatchText);
            if (bestMatchOption) {
              element.value = bestMatchOption.value;
              await new Promise(resolve => setTimeout(resolve, 200));
              const inputEvent = new Event('input', { bubbles: true });
              inputEvent._autofilledByExtension = true;
              const changeEvent = new Event('change', { bubbles: true });
              changeEvent._autofilledByExtension = true;
              element.dispatchEvent(inputEvent);
              element.dispatchEvent(changeEvent);
              aChangeWasMade = true;
            }
          }
        } else if (element.tagName === 'BUTTON' && element.getAttribute('aria-haspopup') === 'dialog') {
          try {
            element.click();
            await new Promise(resolve => setTimeout(resolve, 1000));

            const dialogId = element.getAttribute('aria-controls');
            let optionsInDialog = [];
            if (dialogId) {
              const dialog = document.getElementById(dialogId);
              if (dialog) {
                optionsInDialog = Array.from(dialog.querySelectorAll('[role="option"]'));
              }
            } else {
              optionsInDialog = Array.from(document.querySelectorAll('[role="option"]'));
            }

            const bestMatch = findBestMatch(answer, optionsInDialog.map(o => o.textContent));
            if (bestMatch) {
              const bestMatchElement = optionsInDialog.find(o => o.textContent === bestMatch);
              if (bestMatchElement) {
                bestMatchElement.click();
                aChangeWasMade = true;
              }
            }
          } catch (e) {
            console.error(`[Gemini Filler] Could not fill custom dropdown for "${question}":`, e);
          }
        } else if (element.getAttribute('role') === 'radiogroup') {
          const radioButtons = Array.from(element.querySelectorAll('button[role="radio"]'));
          const optionDetails = radioButtons.map(rb => {
            const label = document.querySelector(`label[for="${rb.id}"]`) || rb.closest('div')?.querySelector('label');
            return {
              button: rb,
              text: label ? label.textContent.trim() : rb.getAttribute('aria-label') || ''
            };
          });

          const bestMatchText = findBestMatch(answer, optionDetails.map(o => o.text));
          if (bestMatchText) {
            const matchingOption = optionDetails.find(o => o.text === bestMatchText);
            if (matchingOption) {
              matchingOption.button.click();
              aChangeWasMade = true;
            }
          }
        } else {
          element.value = answer;
          await new Promise(resolve => setTimeout(resolve, 200));
          const inputEvent = new Event('input', { bubbles: true });
          inputEvent._autofilledByExtension = true;
          const changeEvent = new Event('change', { bubbles: true });
          changeEvent._autofilledByExtension = true;
          element.dispatchEvent(inputEvent);
          element.dispatchEvent(changeEvent);
          aChangeWasMade = true;
        }

        // Log successful filling
        if (aChangeWasMade) {
          console.log(`[Gemini Filler] Individual processing: filled "${question}" = "${answer}" (source: ${answerSource})`);
        }

        // Capture the question and answer for learning (only if from AI and not a placeholder)
        if (answer && answerSource === 'ai' && !isPlaceholder(answer)) {
          try {
            console.log(`[DEBUG] Calling captureQuestion for "${question}"...`);
            const capturedHash = await captureQuestionBridge(element, answer);
            console.log(`[DEBUG] captureQuestion returned: ${capturedHash}`);
            if (capturedHash && !questionHash) {
              questionHash = capturedHash;
              console.log(`%c[SYSTEM UCZENIA] 💾 Zapisano pytanie: "${question}" → "${answer}"`, 'color: purple; font-weight: bold;');
              console.log(`%c   Kliknij 👍/👎 obok pola żeby zwiększyć pewność odpowiedzi!`, 'color: purple;');
            }
          } catch (err) {
            console.warn('[Gemini Filler] Error capturing question for learning:', err);
          }
        } else if (answer && answerSource === 'ai' && isPlaceholder(answer)) {
          console.log(`[Gemini Filler] Skipping learning capture for placeholder answer: "${answer}"`);
        }

        // Add feedback button for learned and AI answers (not for mock data)
        if (questionHash && (answerSource === 'learned' || answerSource === 'ai')) {
          try {
            addFeedbackButtonBridge(element, questionHash);
          } catch (err) {
            console.warn('[Gemini Filler] Error adding feedback button:', err);
          }
        }
      } catch (error) {
        console.error(`[Gemini Filler] Error filling element for "${question}":`, error);
        // Continue to next field
      }
    } catch (error) {
      console.error('[Gemini Filler] Error processing element:', error);
      // Continue to next element
    }
  }

  // Recursively check for new fields, with depth tracking
  if (aChangeWasMade) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    await fillFormWithAI(userData, processedElements, depth + 1, isRetry, missingFields);
  }

  // Note: For individual processing path (depth > 0 or isRetry), we don't show modal
  // Modal is only shown at the end of batch processing (depth 0, !isRetry)
}

function showMissingFieldsSummary(missingFields, userData) {
  console.log('[Gemini Filler] showMissingFieldsSummary called with:', missingFields);

  // Remove duplicates based on question
  const uniqueFields = [];
  const seen = new Set();

  for (const field of missingFields) {
    if (!seen.has(field.question)) {
      seen.add(field.question);
      uniqueFields.push(field);
    }
  }

  console.log(`[Gemini Filler] After deduplication: ${uniqueFields.length} unique fields`);
  if (uniqueFields.length === 0) {
    console.log('[Gemini Filler] No unique fields to display, returning');
    return;
  }

  // Create summary message
  let message = '⚠️ PODSUMOWANIE WYPEŁNIANIA FORMULARZA\n\n';
  message += `Nie udało się wypełnić ${uniqueFields.length} pól z powodu braku danych:\n\n`;

  uniqueFields.forEach((field, index) => {
    message += `${index + 1}. ${field.question}\n`;
    message += `   Powód: ${field.reason}\n\n`;
  });

  message += '💡 SUGESTIE:\n\n';
  message += '1. Uzupełnij te pola ręcznie\n';
  message += '2. Lub dodaj brakujące dane w opcjach rozszerzenia:\n';
  message += '   - Kliknij prawym na ikonę rozszerzenia\n';
  message += '   - Wybierz "Opcje"\n';
  message += '   - Dodaj brakujące dane\n\n';

  // Suggest specific fields to add
  const suggestions = getSuggestedFields(uniqueFields);
  if (suggestions.length > 0) {
    message += 'REKOMENDOWANE POLA DO DODANIA:\n';
    suggestions.forEach(sug => {
      message += `   • ${sug}\n`;
    });
  }

  // Create styled modal instead of basic alert
  console.log('[Gemini Filler] Creating summary modal...');
  const modal = createSummaryModal(uniqueFields, suggestions);
  console.log('[Gemini Filler] Appending modal to document.body');
  document.body.appendChild(modal);
  console.log('[Gemini Filler] Modal appended successfully');

  // Auto-close after 30 seconds
  setTimeout(() => {
    if (modal && modal.parentNode) {
      console.log('[Gemini Filler] Auto-closing modal after 30s');
      modal.remove();
    }
  }, 30000);
}

function getSuggestedFields(missingFields) {
  const suggestions = [];
  const questionKeywords = {
    'wykształcenie': 'Wykształcenie',
    'education': 'Wykształcenie',
    'doświadczenie': 'Lata doświadczenia',
    'experience': 'Lata doświadczenia',
    'lata': 'Lata doświadczenia',
    'years': 'Lata doświadczenia',
    'płeć': 'Płeć',
    'gender': 'Płeć',
    'wiek': 'Wiek',
    'age': 'Wiek',
    'data urodzenia': 'Data urodzenia',
    'birth': 'Data urodzenia',
    'obywatelstwo': 'Obywatelstwo',
    'citizenship': 'Obywatelstwo',
    'języki': 'Języki obce',
    'languages': 'Języki obce',
    'prawo jazdy': 'Prawo jazdy',
    'driving': 'Prawo jazdy',
    'linkedin': 'LinkedIn',
    'github': 'GitHub',
    'portfolio': 'Portfolio/Website'
  };

  const seen = new Set();

  for (const field of missingFields) {
    const lowerQuestion = field.question.toLowerCase();
    for (const [keyword, suggestion] of Object.entries(questionKeywords)) {
      if (lowerQuestion.includes(keyword) && !seen.has(suggestion)) {
        suggestions.push(suggestion);
        seen.add(suggestion);
        break;
      }
    }
  }

  return suggestions;
}

function createSummaryModal(missingFields, suggestions) {
  const modal = document.createElement('div');
  modal.id = 'gemini-filler-summary-modal';
  modal.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: white;
    border: 2px solid #ff9800;
    border-radius: 12px;
    padding: 24px;
    max-width: 500px;
    max-height: 80vh;
    overflow-y: auto;
    box-shadow: 0 10px 40px rgba(0,0,0,0.3);
    z-index: 999999;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #333;
  `;

  let content = `
    <div style="display: flex; align-items: center; margin-bottom: 16px;">
      <span style="font-size: 32px; margin-right: 12px;">⚠️</span>
      <h2 style="margin: 0; font-size: 20px; color: #ff9800;">Podsumowanie wypełniania</h2>
    </div>

    <div style="margin-bottom: 20px; padding: 12px; background: #fff3e0; border-left: 4px solid #ff9800; border-radius: 4px;">
      <strong>Nie wypełniono ${missingFields.length} pól</strong> z powodu braku danych w bazie wiedzy
    </div>

    <div style="margin-bottom: 20px;">
      <h3 style="font-size: 16px; margin-bottom: 12px; color: #555;">Niewypełnione pola:</h3>
      <ul style="margin: 0; padding-left: 20px; line-height: 1.8;">
  `;

  missingFields.forEach(field => {
    content += `
      <li style="margin-bottom: 8px;">
        <strong>${field.question}</strong>
        <div style="font-size: 13px; color: #666;">↳ ${field.reason}</div>
      </li>
    `;
  });

  content += `</ul></div>`;

  if (suggestions.length > 0) {
    content += `
      <div style="margin-bottom: 20px; padding: 12px; background: #e3f2fd; border-left: 4px solid #2196f3; border-radius: 4px;">
        <h3 style="font-size: 16px; margin-bottom: 12px; color: #1976d2;">💡 Dodaj do opcji rozszerzenia:</h3>
        <ul style="margin: 0; padding-left: 20px; line-height: 1.8;">
    `;

    suggestions.forEach(sug => {
      content += `<li><code style="background: #fff; padding: 2px 6px; border-radius: 3px; font-size: 13px;">${sug}</code></li>`;
    });

    content += `
        </ul>
      </div>
    `;
  }

  content += `
    <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid #e0e0e0;">
      <strong style="font-size: 14px;">Jak dodać dane:</strong>
      <ol style="margin: 8px 0 0 0; padding-left: 20px; font-size: 13px; line-height: 1.6; color: #666;">
        <li>Kliknij prawym na ikonę rozszerzenia</li>
        <li>Wybierz "Opcje"</li>
        <li>Dodaj brakujące pola</li>
      </ol>
    </div>

    <div style="text-align: center; margin-top: 20px;">
      <button id="close-summary-modal" style="
        background: #ff9800;
        color: white;
        border: none;
        padding: 10px 24px;
        border-radius: 6px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.2s;
      ">Rozumiem</button>
    </div>

    <div style="text-align: center; margin-top: 12px; font-size: 12px; color: #999;">
      To okno zamknie się automatycznie za 30s
    </div>
  `;

  modal.innerHTML = content;

  // Add close button handler
  setTimeout(() => {
    const closeBtn = document.getElementById('close-summary-modal');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => modal.remove());
      closeBtn.addEventListener('mouseenter', (e) => {
        e.target.style.background = '#f57c00';
      });
      closeBtn.addEventListener('mouseleave', (e) => {
        e.target.style.background = '#ff9800';
      });
    }
  }, 0);

  // Add overlay
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.5);
    z-index: 999998;
  `;
  overlay.addEventListener('click', () => {
    modal.remove();
    overlay.remove();
  });
  document.body.appendChild(overlay);

  // Remove overlay when modal is removed
  const observer = new MutationObserver((mutations) => {
    if (!document.contains(modal)) {
      overlay.remove();
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  return modal;
}

function findBestMatch(answer, options) {
  if (!options || options.length === 0) {
    return null;
  }

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

  // Try to translate Polish country names to English
  const lowerAnswer = answer.toLowerCase().trim();
  const translatedAnswer = countryTranslations[lowerAnswer] || answer;
  const wasTranslated = translatedAnswer !== answer;

  // Normalize answer by removing special chars for better matching
  const normalizedAnswer = translatedAnswer.toLowerCase().replace(/[^\w\s]/g, ' ').trim();
  const answerWords = normalizedAnswer.split(/\s+/).filter(w => w.length > 0);

  // PASS 1: Look for exact match (highest priority)
  // Try both translated and original if translation happened
  for (const optionText of options) {
    if (optionText.toLowerCase() === translatedAnswer.toLowerCase()) {
      return optionText;
    }
    // If translation occurred, also try original answer
    if (wasTranslated && optionText.toLowerCase() === lowerAnswer) {
      return optionText;
    }
  }

  // PASS 2: Look for substring match (second priority)
  let substringMatch = null;
  for (const optionText of options) {
    const lowerOption = optionText.toLowerCase();
    const lowerTranslatedAnswer = translatedAnswer.toLowerCase();

    // Try translated answer
    if (lowerOption.includes(lowerTranslatedAnswer) || lowerTranslatedAnswer.includes(lowerOption)) {
      if (!substringMatch || optionText.length < substringMatch.length) {
        substringMatch = optionText;
      }
    }

    // If translation occurred, also try original
    if (wasTranslated && (lowerOption.includes(lowerAnswer) || lowerAnswer.includes(lowerOption))) {
      if (!substringMatch || optionText.length < substringMatch.length) {
        substringMatch = optionText;
      }
    }
  }

  if (substringMatch) {
    return substringMatch;
  }

  // PASS 3: Word-based scoring (fallback)
  let bestMatch = null;
  let maxScore = 0;

  // Prepare original answer words if translation occurred
  const originalNormalized = wasTranslated ? lowerAnswer.replace(/[^\w\s]/g, ' ').trim() : null;
  const originalWords = wasTranslated ? originalNormalized.split(/\s+/).filter(w => w.length > 0) : null;

  for (const optionText of options) {
    const normalizedOption = optionText.toLowerCase().replace(/[^\w\s]/g, ' ').trim();
    const optionWords = normalizedOption.split(/\s+/).filter(w => w.length > 0);

    // Count matching words with translated answer
    let score = answerWords.filter(word => optionWords.includes(word)).length;

    // If translation occurred, also try original and use better score
    if (wasTranslated && originalWords) {
      const originalScore = originalWords.filter(word => optionWords.includes(word)).length;
      score = Math.max(score, originalScore);
    }

    if (score > maxScore) {
      maxScore = score;
      bestMatch = optionText;
    }
  }

  return bestMatch;
}

function getQuestionForInput(input) {
  let questionText = null;

  // 1. Check for a wrapping label
  if (input.parentElement.tagName === 'LABEL') {
    questionText = input.parentElement.textContent.trim();
  }

  // 2. Check for a `for` attribute
  if (!questionText && input.id) {
    const label = document.querySelector(`label[for="${input.id}"]`);
    if (label) {
      questionText = label.textContent.trim();
    }
  }

  // 3. Check for aria-labelledby
  if (!questionText && input.getAttribute('aria-labelledby')) {
    const ariaLabelledBy = input.getAttribute('aria-labelledby');
    const label = document.getElementById(ariaLabelledBy);
    if (label) {
      questionText = label.textContent.trim();
    }
  }
  
  // 4. Traverse up the DOM to find a nearby label
  if (!questionText) {
    let current = input;
    while (current.parentElement) {
      const parent = current.parentElement;
      const label = parent.querySelector('label');
      if (label && label.contains(input)) {
         questionText = label.textContent.trim();
         break;
      }
      const labels = parent.querySelectorAll('label');
      for(const l of labels) {
          if(l.contains(input)) { questionText = l.textContent.trim(); break; }
          if(l.nextElementSibling === input) { questionText = l.textContent.trim(); break; }
      }
      if (questionText) break;
      current = parent;
    }
  }

  // 5. Fallback to aria-label or placeholder
  if (!questionText && input.getAttribute('aria-label')) {
    questionText = input.getAttribute('aria-label').trim();
  }

  if (!questionText && input.getAttribute('placeholder')) {
    questionText = input.getAttribute('placeholder').trim();
  }

  return questionText;
}

function getCvFromStorage() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get('userCV', (result) => {
      // Check for storage errors
      if (chrome.runtime.lastError) {
        console.error('[Gemini Filler] Storage error when getting CV:', chrome.runtime.lastError);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (!result.userCV) {
        resolve(null);
        return;
      }

      // Convert data URL to Blob with error handling
      fetch(result.userCV.dataUrl)
        .then(res => {
          if (!res.ok) {
            throw new Error(`Failed to fetch CV data: ${res.status}`);
          }
          return res.blob();
        })
        .then(blob => {
          resolve({
            blob: blob,
            name: result.userCV.name,
            type: result.userCV.type
          });
        })
        .catch(error => {
          console.error('[Gemini Filler] Error converting CV data URL to blob:', error);
          reject(new Error('Failed to load CV file'));
        });
    });
  });
}

async function handleRadioButton(radioElement, userData, processedElements) {
  try {
    // Skip if already processed or not in a group
    const radioName = radioElement.name;
    if (!radioName) {
      return;
    }

    // Find all radio buttons in the same group
    const radioGroup = document.querySelectorAll(`input[type="radio"][name="${radioName}"]`);
    if (radioGroup.length === 0) {
      return;
    }

    // Check if we've already processed this group
    const groupKey = `radio-group-${radioName}`;
    if (processedElements.has(groupKey)) {
      return;
    }
    processedElements.add(groupKey);

    // Get the question for this radio group
    // Try to find from the first radio or from a group label
    const question = getQuestionForInput(radioElement) || getRadioGroupLabel(radioElement);
    if (!question) {
      console.log('[Gemini Filler] No question found for radio group:', radioName);
      return;
    }

    // Get all options
    const options = Array.from(radioGroup).map(radio => {
      // Try to find label
      const label = document.querySelector(`label[for="${radio.id}"]`) ||
                   radio.nextElementSibling?.tagName === 'LABEL' ? radio.nextElementSibling :
                   radio.parentElement?.querySelector('label') ||
                   radio.closest('div')?.querySelector('label');

      return {
        element: radio,
        text: label ? label.textContent.trim() : radio.getAttribute('aria-label') || radio.value
      };
    }).filter(opt => opt.text);

    if (options.length === 0) {
      console.log('[Gemini Filler] No options found for radio group:', radioName);
      return;
    }

    console.log(`[Gemini Filler] Processing radio group "${question}" with ${options.length} options`);

    // Get AI response
    const optionsText = options.map(o => o.text);
    let answer;
    try {
      const result = await getAIResponse(question, userData, optionsText);
      answer = result.answer;
    } catch (error) {
      console.error(`[Gemini Filler] AI error for radio group "${question}":`, error);
      return;
    }

    if (!answer) {
      return;
    }

    // Find best match and select it
    const bestMatchText = findBestMatch(answer, optionsText);
    if (bestMatchText) {
      const matchingOption = options.find(o => o.text === bestMatchText);
      if (matchingOption && matchingOption.element) {
        matchingOption.element.checked = true;
        matchingOption.element.dispatchEvent(new Event('change', { bubbles: true }));
        matchingOption.element.dispatchEvent(new Event('click', { bubbles: true }));

        // Trigger any onclick handlers
        if (matchingOption.element.onclick) {
          matchingOption.element.onclick.call(matchingOption.element);
        }

        console.log(`[Gemini Filler] Selected radio option: ${bestMatchText}`);
      }
    }
  } catch (error) {
    console.error('[Gemini Filler] Error handling radio button:', error);
  }
}

function getRadioGroupLabel(radioElement) {
  // Try to find a group label by looking for aria-labelledby on a parent
  let current = radioElement.parentElement;
  let depth = 0;

  while (current && depth < 5) {
    const labelledBy = current.getAttribute('aria-labelledby');
    if (labelledBy) {
      const labelElement = document.getElementById(labelledBy);
      if (labelElement) {
        return labelElement.textContent.trim();
      }
    }

    // Look for a label within the parent
    const label = current.querySelector('label');
    if (label && !label.getAttribute('for')) {
      // This might be a group label
      return label.textContent.trim();
    }

    current = current.parentElement;
    depth++;
  }

  return null;
}

async function handleCheckbox(checkboxElement, userData) {
  try {
    const question = getQuestionForInput(checkboxElement);
    if (!question) {
      return;
    }

    console.log(`[Gemini Filler] Processing checkbox: "${question}"`);

    // For checkboxes, we ask AI if this should be checked (yes/no question)
    const modifiedQuestion = `Should the following be checked/enabled? ${question}`;

    let answer;
    try {
      const result = await getAIResponse(modifiedQuestion, userData, ['Yes', 'No']);
      answer = result.answer;
    } catch (error) {
      console.error(`[Gemini Filler] AI error for checkbox "${question}":`, error);
      return;
    }

    if (!answer) {
      return;
    }

    // Check if answer is positive
    const shouldCheck = answer.toLowerCase().includes('yes') ||
                       answer.toLowerCase().includes('tak') ||
                       answer.toLowerCase().includes('true');

    if (shouldCheck !== checkboxElement.checked) {
      checkboxElement.checked = shouldCheck;
      checkboxElement.dispatchEvent(new Event('change', { bubbles: true }));
      checkboxElement.dispatchEvent(new Event('click', { bubbles: true }));

      console.log(`[Gemini Filler] Checkbox "${question}" set to: ${shouldCheck}`);
    }
  } catch (error) {
    console.error('[Gemini Filler] Error handling checkbox:', error);
  }
}

async function handleCustomResumeButtons(processedElements) {
  try {
    // Look for custom div-based upload buttons (like the one in the example)
    // These are typically divs or spans with specific classes and text content
    const customUploadSelectors = [
      '.attachmentBtn',
      '.addAttachments',
      '[class*="upload"]',
      'div[role="button"][aria-label*="Resume"]',
      'div[role="button"][aria-label*="CV"]',
      'span[role="button"][aria-label*="Resume"]',
      'span[role="button"][aria-label*="CV"]'
    ];

    for (const selector of customUploadSelectors) {
      const buttons = document.querySelectorAll(selector);

      for (const button of buttons) {
        // Skip if already processed
        if (processedElements.has(button)) {
          continue;
        }

        // Check if this looks like a resume upload button
        const buttonText = button.textContent?.toLowerCase() || '';
        const ariaLabel = button.getAttribute('aria-label')?.toLowerCase() || '';
        const ariaLabelledBy = button.getAttribute('aria-labelledby');
        let labelText = '';

        if (ariaLabelledBy) {
          const labelElement = document.getElementById(ariaLabelledBy);
          labelText = labelElement?.textContent?.toLowerCase() || '';
        }

        const combinedText = `${buttonText} ${ariaLabel} ${labelText}`;
        const resumeKeywords = ['resume', 'cv', 'curriculum', 'życiorys', 'załącz'];

        if (resumeKeywords.some(keyword => combinedText.includes(keyword))) {
          console.log('[Gemini Filler] Found custom resume upload button:', button);
          console.log('[Gemini Filler] Combined text:', combinedText);
          processedElements.add(button);

          try {
            // Click the button to open the file picker
            button.click();
            console.log('[Gemini Filler] Clicked custom upload button, waiting for file input...');

            // Wait for file input to appear (it might be dynamically created)
            await new Promise(resolve => setTimeout(resolve, 1500)); // Increased to 1.5s

            // Look for any newly appeared file inputs
            const fileInputs = document.querySelectorAll('input[type="file"]');
            console.log(`[Gemini Filler] Found ${fileInputs.length} file inputs after click`);

            let foundAndHandled = false;
            for (const fileInput of fileInputs) {
              const alreadyProcessed = processedElements.has(fileInput);
              const inDom = document.contains(fileInput);
              console.log('[Gemini Filler] Checking file input:', {
                id: fileInput.id,
                alreadyProcessed,
                inDom,
                offsetParent: fileInput.offsetParent,
                displayStyle: fileInput.style.display
              });

              if (!alreadyProcessed && inDom) {
                // Check if it's visible or in a modal/dialog
                const isVisible = fileInput.offsetParent !== null ||
                                 fileInput.closest('[role="dialog"]') !== null ||
                                 fileInput.closest('.modal') !== null;

                if (isVisible || fileInput.style.display !== 'none') {
                  console.log('[Gemini Filler] Found valid file input, attempting to attach CV...');
                  await handleFileInput(fileInput);
                  processedElements.add(fileInput);
                  foundAndHandled = true;
                  break; // Only handle the first one
                } else {
                  console.log('[Gemini Filler] File input not visible, skipping');
                }
              }
            }

            if (!foundAndHandled && fileInputs.length === 0) {
              console.warn('[Gemini Filler] No file inputs found after clicking custom button. May need to manually trigger.');
            }
          } catch (error) {
            console.error('[Gemini Filler] Error handling custom upload button:', error);
          }
        }
      }
    }
  } catch (error) {
    console.error('[Gemini Filler] Error in handleCustomResumeButtons:', error);
  }
}

async function handleFileInput(fileInputElement) {
  try {
    const cvData = await getCvFromStorage();
    if (!cvData) {
      console.log('[Gemini Filler] No CV found in storage.');
      return;
    }

    // Validate file element is still valid
    if (!document.contains(fileInputElement)) {
      console.warn('[Gemini Filler] File input element no longer in DOM');
      return;
    }

    const file = new File([cvData.blob], cvData.name, { type: cvData.type });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    fileInputElement.files = dataTransfer.files;

    // Dispatch events to notify the page of the change
    fileInputElement.dispatchEvent(new Event('change', { bubbles: true }));
    fileInputElement.dispatchEvent(new Event('input', { bubbles: true }));

    console.log(`[Gemini Filler] CV "${cvData.name}" attached to file input.`);
  } catch (error) {
    console.error('[Gemini Filler] Failed to attach CV:', error);
    // Don't throw - just log the error and continue with other fields
  }
}


// --- Overlay Functions ---

function showOverlay(text) {
  const overlay = document.createElement('div');
  overlay.id = 'gemini-filler-overlay';
  overlay.innerHTML = `
    <div id="gemini-filler-modal">
      <div class="spinner"></div>
      <p>${text}</p>
    </div>
  `;
  document.body.appendChild(overlay);
}

function showSuccessOverlay() {
  const modal = document.getElementById('gemini-filler-modal');
  if (modal) {
    modal.innerHTML = `
      <div class="checkmark">✓</div>
      <p>Gotowe!</p>
    `;
  }
}

function showErrorOverlay(errorMessage) {
  const modal = document.getElementById('gemini-filler-modal');
  if (modal) {
    modal.innerHTML = `
      <div class="error-icon">✗</div>
      <p>${errorMessage}</p>
    `;
  }
}

function hideOverlay() {
  const overlay = document.getElementById('gemini-filler-overlay');
  if (overlay) {
    overlay.remove();
  }
}

// ==================== Application Tracker ====================

// Detect recruitment form submission
function detectJobApplication() {
  // Common recruitment form indicators
  const isRecruitmentSite = () => {
    const url = window.location.href.toLowerCase();
    const hostname = window.location.hostname.toLowerCase();

    // Check for known job sites
    const jobSites = [
      'linkedin.com/jobs',
      'pracuj.pl',
      'nofluffjobs.com',
      'justjoin.it',
      'indeed.com',
      'glassdoor.com',
      'greenhouse.io',
      'workable.com',
      'lever.co',
      'jobvite.com',
      'smartrecruiters.com',
      'breezy.hr',
      'bamboohr.com',
      'recruitee.com'
    ];

    return jobSites.some(site => url.includes(site) || hostname.includes(site));
  };

  // Extract job information from the page
  function extractJobInfo() {
    console.log('[Application Tracker] Extracting job information...');

    const jobInfo = {
      job_title: '',
      company: '',
      location: '',
      salary: '',
      job_url: window.location.href,
      source: window.location.hostname
    };

    // Try to extract job title
    const titleSelectors = [
      'h1[class*="job"]',
      'h1[class*="title"]',
      '[class*="job-title"]',
      '[data-test="job-title"]',
      'h1',
      '.position-title',
      '.job-header h1'
    ];

    for (const selector of titleSelectors) {
      const elem = document.querySelector(selector);
      if (elem && elem.textContent.trim()) {
        jobInfo.job_title = elem.textContent.trim();
        console.log('[Application Tracker] Found job title:', jobInfo.job_title);
        break;
      }
    }

    // Try to extract company name
    const companySelectors = [
      '[class*="company-name"]',
      '[class*="employer"]',
      '[data-test="company-name"]',
      '.company',
      '.employer-name',
      'a[href*="/company/"]'
    ];

    for (const selector of companySelectors) {
      const elem = document.querySelector(selector);
      if (elem && elem.textContent.trim()) {
        jobInfo.company = elem.textContent.trim();
        console.log('[Application Tracker] Found company:', jobInfo.company);
        break;
      }
    }

    // Try to extract location
    const locationSelectors = [
      '[class*="location"]',
      '[data-test="location"]',
      '.job-location',
      '[class*="city"]'
    ];

    for (const selector of locationSelectors) {
      const elem = document.querySelector(selector);
      if (elem && elem.textContent.trim()) {
        jobInfo.location = elem.textContent.trim();
        console.log('[Application Tracker] Found location:', jobInfo.location);
        break;
      }
    }

    // Try to extract salary
    const salarySelectors = [
      '[class*="salary"]',
      '[class*="compensation"]',
      '[data-test="salary"]',
      '.pay-range'
    ];

    for (const selector of salarySelectors) {
      const elem = document.querySelector(selector);
      if (elem && elem.textContent.trim()) {
        jobInfo.salary = elem.textContent.trim();
        console.log('[Application Tracker] Found salary:', jobInfo.salary);
        break;
      }
    }

    // If we couldn't find title or company, try to get from page title
    if (!jobInfo.job_title && !jobInfo.company) {
      const pageTitle = document.title;
      // Common pattern: "Job Title - Company Name | Job Board"
      const titleParts = pageTitle.split(/[-|]/);
      if (titleParts.length >= 2) {
        jobInfo.job_title = titleParts[0].trim();
        jobInfo.company = titleParts[1].trim();
        console.log('[Application Tracker] Extracted from page title:', jobInfo);
      }
    }

    return jobInfo;
  }

  // Show save application modal
  function showSaveApplicationModal(jobInfo) {
    // Check if modal already exists
    if (document.getElementById('app-tracker-modal')) {
      return;
    }

    const modal = document.createElement('div');
    modal.id = 'app-tracker-modal';
    modal.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.7);
      z-index: 99999;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      animation: fadeIn 0.3s;
    `;

    const content = document.createElement('div');
    content.style.cssText = `
      background: white;
      padding: 30px;
      border-radius: 12px;
      max-width: 500px;
      width: 100%;
      box-shadow: 0 10px 40px rgba(0,0,0,0.3);
      animation: slideUp 0.3s;
    `;

    const today = new Date().toISOString().split('T')[0];

    content.innerHTML = `
      <style>
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes slideUp {
          from { transform: translateY(20px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
      </style>

      <h2 style="margin-top: 0; color: #333; font-size: 1.5em;">💼 Zapisać aplikację?</h2>
      <p style="color: #666; margin-bottom: 20px;">Znaleziono formularz rekrutacyjny. Czy chcesz zapisać tę aplikację?</p>

      <div style="margin-bottom: 15px;">
        <label style="display: block; margin-bottom: 5px; font-weight: 500; color: #555;">Stanowisko:</label>
        <input type="text" id="tracker-job-title" value="${escapeHtml(jobInfo.job_title)}"
          style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px;">
      </div>

      <div style="margin-bottom: 15px;">
        <label style="display: block; margin-bottom: 5px; font-weight: 500; color: #555;">Firma:</label>
        <input type="text" id="tracker-company" value="${escapeHtml(jobInfo.company)}"
          style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px;">
      </div>

      <div style="margin-bottom: 15px;">
        <label style="display: block; margin-bottom: 5px; font-weight: 500; color: #555;">Lokalizacja:</label>
        <input type="text" id="tracker-location" value="${escapeHtml(jobInfo.location)}"
          style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px;">
      </div>

      <div style="margin-bottom: 20px;">
        <label style="display: block; margin-bottom: 5px; font-weight: 500; color: #555;">Wynagrodzenie:</label>
        <input type="text" id="tracker-salary" value="${escapeHtml(jobInfo.salary)}"
          style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px;">
      </div>

      <div style="display: flex; gap: 10px;">
        <button id="tracker-save-btn" style="flex: 1; padding: 12px; background: #4CAF50; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 14px;">
          💾 Zapisz
        </button>
        <button id="tracker-cancel-btn" style="flex: 1; padding: 12px; background: #999; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px;">
          Anuluj
        </button>
      </div>
    `;

    modal.appendChild(content);
    document.body.appendChild(modal);

    // Helper for escaping HTML
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text || '';
      return div.innerHTML;
    }

    // Event listeners
    document.getElementById('tracker-cancel-btn').addEventListener('click', () => {
      modal.remove();
    });

    document.getElementById('tracker-save-btn').addEventListener('click', () => {
      const applicationData = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2),
        job_title: document.getElementById('tracker-job-title').value.trim(),
        company: document.getElementById('tracker-company').value.trim(),
        location: document.getElementById('tracker-location').value.trim(),
        salary: document.getElementById('tracker-salary').value.trim(),
        status: 'applied',
        applied_date: today,
        job_url: jobInfo.job_url,
        source: jobInfo.source,
        notes: '',
        timeline: [{
          date: new Date().toISOString(),
          event: 'Aplikacja wysłana'
        }],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      // Validate required fields
      if (!applicationData.job_title || !applicationData.company) {
        alert('Stanowisko i firma są wymagane!');
        return;
      }

      // Send to background script
      chrome.runtime.sendMessage({
        action: 'saveApplication',
        data: applicationData
      }, (response) => {
        if (response && response.success) {
          // Show success message
          content.innerHTML = `
            <div style="text-align: center; padding: 20px;">
              <div style="font-size: 48px; color: #4CAF50; margin-bottom: 15px;">✓</div>
              <h3 style="margin: 0; color: #333;">Aplikacja zapisana!</h3>
              <p style="color: #666; margin-top: 10px;">Możesz ją zobaczyć w ustawieniach rozszerzenia</p>
            </div>
          `;
          setTimeout(() => modal.remove(), 2000);
        } else {
          alert('Błąd zapisu aplikacji. Spróbuj ponownie.');
        }
      });
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.remove();
      }
    });
  }

  // Listen for form submissions
  document.addEventListener('submit', (event) => {
    // Only track if it looks like a recruitment site
    if (!isRecruitmentSite()) {
      return;
    }

    console.log('[Application Tracker] Form submission detected on recruitment site');

    // Extract job info and show modal
    const jobInfo = extractJobInfo();

    if (jobInfo.job_title || jobInfo.company) {
      // Small delay to ensure form is submitted first
      setTimeout(() => {
        showSaveApplicationModal(jobInfo);
      }, 500);
    } else {
      console.log('[Application Tracker] Could not extract enough job information');
    }
  }, true);

  console.log('[Application Tracker] Form submission detection initialized');
}

// Initialize application tracking
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', detectJobApplication);
} else {
  detectJobApplication();
}
