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

async function fillFormWithAI(userData, processedElements = new Set(), depth = 0, isRetry = false) {
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
      if (typeof getSuggestionForField === 'function') {
        try {
          const suggestion = await getSuggestionForField(element);
          if (suggestion && suggestion.confidence > 0.75) {
            answer = suggestion.answer;
            questionHash = suggestion.questionHash;
            answerSource = 'learned';
            console.log(`[Gemini Filler] Using learned answer for "${question}" (confidence: ${suggestion.confidence})`);
          }
        } catch (err) {
          console.warn('[Gemini Filler] Error getting learned suggestion:', err);
        }
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
              element.dispatchEvent(new Event('input', { bubbles: true }));
              element.dispatchEvent(new Event('change', { bubbles: true }));
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
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
          aChangeWasMade = true;
        }

        // Capture the question and answer for learning
        if (typeof captureQuestion === 'function' && answer) {
          try {
            // captureQuestion now returns questionHash
            const capturedHash = await captureQuestion(element, answer);
            if (capturedHash && !questionHash) {
              questionHash = capturedHash;
            }
          } catch (err) {
            console.warn('[Gemini Filler] Error capturing question for learning:', err);
          }
        }

        // Add feedback button for learned and AI answers (not for mock data)
        if (questionHash && typeof addFeedbackButton === 'function' &&
            (answerSource === 'learned' || answerSource === 'ai')) {
          try {
            addFeedbackButton(element, questionHash);
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
    await fillFormWithAI(userData, processedElements, depth + 1, isRetry);
  }

  // Second verification pass - only on main call (depth 0) and not already a retry
  // This catches any fields that were missed during the first pass
  if (depth === 0 && !isRetry) {
    await new Promise(resolve => setTimeout(resolve, 500));

    // Check for missed empty fields
    const allFields = document.querySelectorAll('input:not([type="file"]):not([type="radio"]):not([type="checkbox"]):not([type="submit"]):not([type="button"]):not([type="hidden"]), textarea, select');

    let missedFields = [];
    for (const field of allFields) {
      // Check if field is visible, not processed, and empty
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
      await fillFormWithAI(userData, processedElements, 0, true);
    } else {
      console.log('[Gemini Filler] Second pass: no missed fields found.');
    }
  }
}

function findBestMatch(answer, options) {
  if (!options || options.length === 0) {
    return null;
  }

  let bestMatch = null;
  let maxScore = 0;

  const answerWords = answer.toLowerCase().split(/\s+/);

  for (const optionText of options) {
    if (optionText.toLowerCase() === answer.toLowerCase()) {
      return optionText;
    }

    const optionWords = optionText.toLowerCase().split(/\s+/);
    const score = answerWords.filter(word => optionWords.includes(word)).length;

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
          processedElements.add(button);

          try {
            // Click the button to open the file picker
            button.click();

            // Wait for file input to appear (it might be dynamically created)
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Look for any newly appeared file inputs
            const fileInputs = document.querySelectorAll('input[type="file"]');
            for (const fileInput of fileInputs) {
              if (!processedElements.has(fileInput) && document.contains(fileInput)) {
                // Check if it's visible or in a modal/dialog
                const isVisible = fileInput.offsetParent !== null ||
                                 fileInput.closest('[role="dialog"]') !== null ||
                                 fileInput.closest('.modal') !== null;

                if (isVisible || fileInput.style.display !== 'none') {
                  console.log('[Gemini Filler] Found file input after clicking custom button');
                  await handleFileInput(fileInput);
                  processedElements.add(fileInput);
                  break; // Only handle the first one
                }
              }
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
