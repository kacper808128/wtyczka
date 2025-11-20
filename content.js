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

async function fillFormWithAI(userData, processedElements = new Set(), depth = 0) {
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
      try {
        answer = await getAIResponse(question, userData, optionsText);
      } catch (error) {
        console.error(`[Gemini Filler] AI error for question "${question}":`, error);
        // Continue to next field instead of failing completely
        continue;
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
    await fillFormWithAI(userData, processedElements, depth + 1);
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
      answer = await getAIResponse(question, userData, optionsText);
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
      answer = await getAIResponse(modifiedQuestion, userData, ['Yes', 'No']);
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
