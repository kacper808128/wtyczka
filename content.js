// Inject the stylesheet
const link = document.createElement('link');
link.rel = 'stylesheet';
link.type = 'text/css';
link.href = chrome.runtime.getURL('styles.css');
document.head.appendChild(link);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "fill_form") {
    showOverlay("Wypełnianie w toku...");
    chrome.storage.sync.get('userData', (result) => {
      const data = result.userData;
      if (!data || Object.keys(data).length === 0) {
        console.log('[Gemini Filler] No user data found. Please set your data in the extension options.');
        hideOverlay();
        return;
      }
      
      (async () => {
        await fillFormWithAI(data);
        showSuccessOverlay();
        setTimeout(hideOverlay, 2000);
        sendResponse({ status: "success" });
      })();
    });
    return true; // Indicates that the response is sent asynchronously
  }
});

async function fillFormWithAI(userData, processedElements = new Set()) {
  const formElements = document.querySelectorAll('input, textarea, select, button[aria-haspopup="dialog"], div[role="radiogroup"]');
  let aChangeWasMade = false;

  for (const element of formElements) {
    if (processedElements.has(element)) {
      continue;
    }
    processedElements.add(element);

    if (element.type === 'file') {
      const question = getQuestionForInput(element);
      const keywords = ['cv', 'resume', 'życiorys', 'załącz', 'plik'];
      if (question && keywords.some(keyword => question.toLowerCase().includes(keyword))) {
        await handleFileInput(element);
      }
      continue;
    }

    const question = getQuestionForInput(element);
    if (question) {
      let optionsText = null;
      if (element.tagName === 'SELECT') {
        optionsText = Array.from(element.options).map(o => o.text);
      } else if (element.getAttribute('role') === 'radiogroup') {
        const radioButtons = element.querySelectorAll('button[role="radio"]');
        optionsText = Array.from(radioButtons).map(rb => {
            const label = document.querySelector(`label[for="${rb.id}"]`) || rb.closest('div').querySelector('label');
            return label ? label.textContent.trim() : rb.getAttribute('aria-label');
        });
      }

      const answer = await getAIResponse(question, userData, optionsText);

      if (answer) {
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
            console.error(`Could not fill custom dropdown for "${question}":`, e);
          }
        } else if (element.getAttribute('role') === 'radiogroup') {
            const radioButtons = Array.from(element.querySelectorAll('button[role="radio"]'));
            const optionDetails = radioButtons.map(rb => {
                const label = document.querySelector(`label[for="${rb.id}"]`) || rb.closest('div').querySelector('label');
                return {
                    button: rb,
                    text: label ? label.textContent.trim() : rb.getAttribute('aria-label')
                };
            });
            
            const bestMatchText = findBestMatch(answer, optionDetails.map(o => o.text));
            if (bestMatchText) {
                const matchingOption = optionDetails.find(o => o.text === bestMatchText);
                if(matchingOption) {
                  matchingOption.button.click();
                  aChangeWasMade = true;
                }
            }
        } else {
          element.value = answer;
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    }
  }

  if (aChangeWasMade) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    await fillFormWithAI(userData, processedElements);
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
  return new Promise((resolve) => {
    chrome.storage.local.get('userCV', (result) => {
      if (result.userCV) {
        // Convert data URL to Blob
        fetch(result.userCV.dataUrl)
          .then(res => res.blob())
          .then(blob => {
            resolve({
              blob: blob,
              name: result.userCV.name,
              type: result.userCV.type
            });
          });
      } else {
        resolve(null);
      }
    });
  });
}

async function handleFileInput(fileInputElement) {
  const cvData = await getCvFromStorage();
  if (!cvData) {
    console.log('[Gemini Filler] No CV found in storage.');
    return;
  }

  try {
    const file = new File([cvData.blob], cvData.name, { type: cvData.type });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    fileInputElement.files = dataTransfer.files;

    // Dispatch events to notify the page of the change
    fileInputElement.dispatchEvent(new Event('change', { bubbles: true }));
    fileInputElement.dispatchEvent(new Event('input', { bubbles: true }));

    console.log(`[Gemini Filler] CV "${cvData.name}" attached to file input.`);
  } catch (e) {
    console.error('[Gemini Filler] Failed to attach CV using DataTransfer API:', e);
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

function hideOverlay() {
  const overlay = document.getElementById('gemini-filler-overlay');
  if (overlay) {
    overlay.remove();
  }
}
