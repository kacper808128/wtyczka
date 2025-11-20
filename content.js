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

          // Modal will stay visible until user clicks "Dodaj do trackera" or "Pomiń"
          // No auto-hide for success overlay

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

// ==================== Field Type Detection & Metadata ====================

/**
 * Detects the type of a form field
 * @param {HTMLElement} element - The form element to analyze
 * @returns {Object} Field metadata { type, options, format, isCustom }
 */
function detectFieldType(element) {
  const metadata = {
    type: 'text',
    options: null,
    format: null,
    isCustom: false,
    htmlType: element.type || element.tagName.toLowerCase()
  };

  // SELECTIZE.JS detection (custom select library)
  // Selectize hides the original SELECT and creates a div-based UI
  if (element.tagName === 'SELECT' && element.classList.contains('selectized')) {
    metadata.type = 'selectize';
    metadata.isCustom = true;

    // Try to find selectize container (could be sibling or in parent)
    let selectizeContainer = element.nextElementSibling;
    if (!selectizeContainer || !selectizeContainer.classList.contains('selectize-control')) {
      selectizeContainer = element.parentElement?.querySelector('.selectize-control');
    }

    if (selectizeContainer) {
      // Try to extract options from dropdown (even if hidden)
      const dropdown = selectizeContainer.querySelector('.selectize-dropdown');
      if (dropdown) {
        const optionElements = dropdown.querySelectorAll('.option');
        if (optionElements.length > 0) {
          metadata.options = Array.from(optionElements).map(opt => opt.textContent.trim()).filter(Boolean);
          console.log(`[Selectize Detection] Found ${metadata.options.length} options in dropdown for ${element.id}`);
        }
      }

      // If dropdown empty, try clicking to populate it
      if (!metadata.options || metadata.options.length === 0) {
        console.log(`[Selectize Detection] Dropdown empty for ${element.id}, will extract options during fill`);
        metadata.options = []; // Empty array indicates Selectize but options need to be loaded
      }
    }

    // Fallback: use original SELECT options if found
    if ((!metadata.options || metadata.options.length === 0) && element.options.length > 0) {
      const placeholderPatterns = /^(--|select|choose|wybierz|seleccione|wählen)/i;
      metadata.options = Array.from(element.options)
        .map(o => o.text.trim())
        .filter(t => t && !placeholderPatterns.test(t));
      console.log(`[Selectize Detection] Using ${metadata.options.length} options from SELECT element for ${element.id}`);
    }

    return metadata;
  }

  // SELECT element (standard)
  if (element.tagName === 'SELECT') {
    metadata.type = 'select';
    const placeholderPatterns = /^(--|select|choose|wybierz|seleccione|wählen)/i;
    metadata.options = Array.from(element.options)
      .map(o => o.text.trim())
      .filter(t => t && !placeholderPatterns.test(t));
    return metadata;
  }

  // RADIO buttons (role="radiogroup" or input[type="radio"])
  if (element.getAttribute('role') === 'radiogroup' || element.type === 'radio') {
    metadata.type = 'radio';
    if (element.getAttribute('role') === 'radiogroup') {
      const radioButtons = element.querySelectorAll('button[role="radio"], input[type="radio"]');
      metadata.options = Array.from(radioButtons).map(rb => {
        const label = document.querySelector(`label[for="${rb.id}"]`) ||
                     rb.closest('div')?.querySelector('label') ||
                     rb.nextElementSibling;
        return label ? label.textContent.trim() : rb.getAttribute('aria-label') || rb.value || '';
      }).filter(t => t);
    }
    return metadata;
  }

  // CHECKBOX
  if (element.type === 'checkbox') {
    metadata.type = 'checkbox';
    return metadata;
  }

  // DATEPICKER detection
  const dateIndicators = [
    'date', 'calendar', 'picker', 'datepicker', 'data', 'fecha', 'datum',
    'dostępność', 'availability', 'start', 'end', 'birth', 'urodzenia'
  ];

  const hasDateClass = element.className && dateIndicators.some(ind =>
    element.className.toLowerCase().includes(ind)
  );
  const hasDateId = element.id && dateIndicators.some(ind =>
    element.id.toLowerCase().includes(ind)
  );
  const hasDatePlaceholder = element.placeholder && dateIndicators.some(ind =>
    element.placeholder.toLowerCase().includes(ind)
  );
  const hasDateType = element.type === 'date' || element.type === 'datetime-local';
  const hasDatePattern = element.pattern && /date|dd|mm|yyyy/i.test(element.pattern);

  if (hasDateClass || hasDateId || hasDatePlaceholder || hasDateType || hasDatePattern) {
    metadata.type = 'datepicker';
    metadata.format = element.placeholder || 'YYYY-MM-DD';
    return metadata;
  }

  // CUSTOM DROPDOWN detection (div-based selects)
  const dropdownIndicators = [
    element.getAttribute('role') === 'combobox',
    element.getAttribute('role') === 'listbox',
    element.getAttribute('aria-haspopup') === 'listbox',
    element.getAttribute('aria-haspopup') === 'menu',
    element.className && /select|dropdown|combobox|autocomplete/i.test(element.className),
    element.tagName === 'BUTTON' && element.getAttribute('aria-expanded') !== null
  ];

  if (dropdownIndicators.some(Boolean)) {
    metadata.type = 'custom-dropdown';
    metadata.isCustom = true;
    // Try to find options if dropdown is already open
    const listbox = document.querySelector(`[role="listbox"][aria-labelledby="${element.id}"]`) ||
                   document.querySelector(`[role="menu"][aria-labelledby="${element.id}"]`) ||
                   element.nextElementSibling?.querySelector('[role="option"]')?.parentElement;

    if (listbox) {
      const optionElements = listbox.querySelectorAll('[role="option"], [role="menuitem"]');
      metadata.options = Array.from(optionElements).map(opt => opt.textContent.trim()).filter(Boolean);
    }
    return metadata;
  }

  // TEXTAREA
  if (element.tagName === 'TEXTAREA') {
    metadata.type = 'textarea';
    return metadata;
  }

  // Default: text input
  return metadata;
}

/**
 * Fuzzy match answer to available options
 * @param {string} answer - The answer from AI
 * @param {Array<string>} options - Available options
 * @returns {string|null} Best matching option or null
 */
function fuzzyMatch(answer, options) {
  if (!answer || !options || options.length === 0) return null;

  const answerLower = answer.toLowerCase().trim();

  // 1. Exact match (case insensitive)
  const exactMatch = options.find(opt => opt.toLowerCase().trim() === answerLower);
  if (exactMatch) return exactMatch;

  // 2. Substring match (answer contains option or vice versa)
  const substringMatch = options.find(opt => {
    const optLower = opt.toLowerCase().trim();
    return answerLower.includes(optLower) || optLower.includes(answerLower);
  });
  if (substringMatch) return substringMatch;

  // 3. Word overlap (count matching words)
  const answerWords = answerLower.split(/\s+/).filter(w => w.length > 2);
  const optionScores = options.map(opt => {
    const optWords = opt.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const matches = answerWords.filter(aw => optWords.some(ow => ow.includes(aw) || aw.includes(ow)));
    return { option: opt, score: matches.length };
  });

  const bestMatch = optionScores.reduce((best, curr) =>
    curr.score > best.score ? curr : best
  );

  if (bestMatch.score > 0) return bestMatch.option;

  // 4. Semantic matching for common cases
  const semanticMappings = {
    'remote': ['zdalnie', 'zdalna', 'remote', 'remotely', 'home office'],
    'hybrid': ['hybrydowo', 'hybrydowa', 'hybrid', 'częściowo zdalnie'],
    'office': ['stacjonarnie', 'stacjonarna', 'office', 'on-site', 'biuro'],
    'full-time': ['pełny etat', 'full time', 'full-time', 'pełen etat'],
    'part-time': ['część etatu', 'part time', 'part-time', 'niepełny etat'],
    'b2b': ['b2b', 'kontrakt', 'contract', 'samozatrudnienie'],
    'uop': ['umowa o pracę', 'uop', 'employment contract']
  };

  for (const [key, variants] of Object.entries(semanticMappings)) {
    if (variants.some(v => answerLower.includes(v))) {
      const match = options.find(opt => variants.some(v => opt.toLowerCase().includes(v)));
      if (match) return match;
    }
  }

  // No match found
  console.log(`[Fuzzy Match] No match for "${answer}" in options:`, options);
  return null;
}

/**
 * Parse date from natural language text
 * @param {string} text - Natural language date ("za 3 miesiące", "three months from now", etc.)
 * @returns {Date|null} Parsed date or null
 */
function parseDateFromText(text) {
  if (!text) return null;

  const textLower = text.toLowerCase().trim();

  // Try to parse as ISO date first
  const isoMatch = textLower.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return new Date(isoMatch[0]);
  }

  // Try to parse DD/MM/YYYY or MM/DD/YYYY
  const dateMatch = textLower.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/);
  if (dateMatch) {
    // Assume DD/MM/YYYY for European formats
    return new Date(dateMatch[3], dateMatch[2] - 1, dateMatch[1]);
  }

  const now = new Date();

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

  // Parse "X days/weeks/months/years from now" (numeric)
  const futurePatterns = [
    { pattern: /(\d+)\s*(dni|day|days|dzień|dzieni)/i, unit: 'days' },
    { pattern: /(\d+)\s*(tydzień|tygodni|tygodnie|week|weeks)/i, unit: 'weeks' },
    { pattern: /(\d+)\s*(miesiąc|miesiące|miesięcy|month|months)/i, unit: 'months' },
    { pattern: /(\d+)\s*(rok|lata|lat|year|years)/i, unit: 'years' }
  ];

  for (const { pattern, unit } of futurePatterns) {
    const match = textLower.match(pattern);
    if (match) {
      const amount = parseInt(match[1]);
      const result = new Date(now);

      switch (unit) {
        case 'days':
          result.setDate(result.getDate() + amount);
          break;
        case 'weeks':
          result.setDate(result.getDate() + (amount * 7));
          break;
        case 'months':
          result.setMonth(result.getMonth() + amount);
          break;
        case 'years':
          result.setFullYear(result.getFullYear() + amount);
          break;
      }

      return result;
    }
  }

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
      switch (unit) {
        case 'days':
          result.setDate(result.getDate() + amount);
          break;
        case 'weeks':
          result.setDate(result.getDate() + (amount * 7));
          break;
        case 'months':
          result.setMonth(result.getMonth() + amount);
          break;
        case 'years':
          result.setFullYear(result.getFullYear() + amount);
          break;
      }
      console.log(`[Date Parser] Parsed "${text}" as ${amount} ${unit} from now = ${result.toISOString().split('T')[0]}`);
      return result;
    }
  }

  // Special cases
  if (/natychmiast|immediately|asap|now/i.test(textLower)) {
    return now;
  }

  if (/jutro|tomorrow/i.test(textLower)) {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow;
  }

  console.log(`[Date Parser] Could not parse date from: "${text}"`);
  return null;
}

/**
 * Fill a datepicker field
 * @param {HTMLElement} element - The datepicker input element
 * @param {Date|string} dateValue - Date object or string to fill
 */
function fillDatepicker(element, dateValue) {
  let date = dateValue;

  if (typeof dateValue === 'string') {
    date = parseDateFromText(dateValue);
  }

  if (!date || !(date instanceof Date) || isNaN(date)) {
    console.warn('[Datepicker] Invalid date:', dateValue);
    return false;
  }

  // Format date as YYYY-MM-DD for HTML5 date inputs
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const formattedDate = `${year}-${month}-${day}`;

  try {
    // Set value
    element.value = formattedDate;

    // Trigger events
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new Event('blur', { bubbles: true }));

    console.log(`[Datepicker] Filled with date: ${formattedDate}`);
    return true;
  } catch (error) {
    console.error('[Datepicker] Error filling:', error);
    return false;
  }
}

/**
 * Fill a Selectize.js dropdown
 * @param {HTMLElement} selectElement - The original SELECT element with .selectized class
 * @param {string} value - Value to select
 * @param {Array<string>} options - Available options
 * @returns {Promise<boolean>} Success status
 */
async function fillSelectize(selectElement, value, options) {
  try {
    console.log(`[Selectize] Attempting to fill with value: "${value}"`);

    // Find the selectize container
    const selectizeContainer = selectElement.parentElement?.querySelector('.selectize-control');
    if (!selectizeContainer) {
      console.warn('[Selectize] Could not find selectize container');
      return false;
    }

    // Find the input trigger
    const selectizeInput = selectizeContainer.querySelector('.selectize-input input');
    if (!selectizeInput) {
      console.warn('[Selectize] Could not find selectize input');
      return false;
    }

    // Click input to open dropdown
    selectizeInput.click();
    await new Promise(resolve => setTimeout(resolve, 300));

    // Find dropdown
    const dropdown = selectizeContainer.querySelector('.selectize-dropdown');
    if (!dropdown) {
      console.warn('[Selectize] Could not find dropdown');
      return false;
    }

    // Get all option elements
    const optionElements = Array.from(dropdown.querySelectorAll('.option'));
    console.log(`[Selectize] Found ${optionElements.length} options`);

    // Fuzzy match value to options
    const optionTexts = optionElements.map(opt => opt.textContent.trim());
    const matchedText = fuzzyMatch(value, optionTexts);

    if (!matchedText) {
      console.warn(`[Selectize] No match found for "${value}" in options:`, optionTexts);
      // Close dropdown
      selectizeInput.blur();
      return false;
    }

    // Find and click the matched option
    const matchedOption = optionElements.find(opt => opt.textContent.trim() === matchedText);
    if (matchedOption) {
      console.log(`[Selectize] Clicking option: "${matchedText}"`);
      matchedOption.click();

      // Wait for selection to complete
      await new Promise(resolve => setTimeout(resolve, 200));

      // For multi-select, might need to close dropdown
      if (selectElement.hasAttribute('multiple')) {
        selectizeInput.blur();
      }

      console.log(`[Selectize] Successfully selected: "${matchedText}"`);
      return true;
    }

    return false;
  } catch (error) {
    console.error('[Selectize] Error:', error);
    return false;
  }
}

/**
 * Fill a custom dropdown (div-based select)
 * @param {HTMLElement} element - The dropdown trigger element
 * @param {string} value - Value to select
 * @returns {Promise<boolean>} Success status
 */
async function fillCustomDropdown(element, value) {
  try {
    // IMPORTANT: First, close any previously opened dropdowns to avoid confusion
    const openDropdowns = document.querySelectorAll('[role="listbox"]:not([hidden]), [role="menu"]:not([hidden])');
    if (openDropdowns.length > 0) {
      console.log(`[Custom Dropdown] Closing ${openDropdowns.length} previously opened dropdown(s)`);
      // Try to close by clicking escape or clicking outside
      document.body.click();
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    // Click to open dropdown
    const elementLabel = getQuestionForInput(element);
    console.log(`[Custom Dropdown] Opening dropdown for "${elementLabel}" (id="${element.id}")`);
    element.click();

    // Wait for dropdown to open
    await new Promise(resolve => setTimeout(resolve, 500));

    // Find the dropdown menu - try multiple strategies with detailed logging
    let listbox = null;

    // Strategy 1: Use aria-labelledby
    if (element.id) {
      listbox = document.querySelector(`[role="listbox"][aria-labelledby="${element.id}"]`);
      if (listbox) {
        console.log(`[Custom Dropdown] ✓ Found listbox via aria-labelledby="${element.id}"`);
      }
    }

    // Strategy 2: Use aria-controls
    if (!listbox) {
      const ariaControls = element.getAttribute('aria-controls');
      if (ariaControls) {
        listbox = document.getElementById(ariaControls);
        if (listbox) {
          console.log(`[Custom Dropdown] ✓ Found listbox via aria-controls="${ariaControls}"`);
        }
      }
    }

    // Strategy 3: Find listbox that appeared most recently (after our click)
    if (!listbox) {
      const allListboxes = Array.from(document.querySelectorAll('[role="listbox"]:not([hidden]), [role="menu"]:not([hidden])'));
      console.log(`[Custom Dropdown] Found ${allListboxes.length} visible listbox(es) on page`);

      if (allListboxes.length === 1) {
        // Only one visible listbox - it must be ours
        listbox = allListboxes[0];
        console.log(`[Custom Dropdown] ✓ Using the only visible listbox (id="${listbox.id || 'no-id'}")`);
      } else if (allListboxes.length > 1) {
        // Multiple listboxes - try to find the one closest to our button
        console.warn(`[Custom Dropdown] ⚠ Multiple listboxes found! Trying to find the correct one...`);

        // Try to find listbox that is a descendant of a dialog/popup that appeared
        const dialogs = document.querySelectorAll('[role="dialog"]:not([hidden]), .popup:not([hidden])');
        for (const dialog of dialogs) {
          const dialogListbox = dialog.querySelector('[role="listbox"], [role="menu"]');
          if (dialogListbox && allListboxes.includes(dialogListbox)) {
            listbox = dialogListbox;
            console.log(`[Custom Dropdown] ✓ Found listbox inside dialog (id="${listbox.id || 'no-id'}")`);
            break;
          }
        }

        // If still not found, use the first one but log a warning
        if (!listbox) {
          listbox = allListboxes[0];
          console.warn(`[Custom Dropdown] ⚠ Using first listbox as fallback - this might be wrong!`);
        }
      }
    }

    if (!listbox) {
      console.warn(`[Custom Dropdown] ✗ Could not find opened listbox for "${elementLabel}"`);
      // Try to close the dropdown we just opened
      element.click();
      return false;
    }

    // Find all options
    const optionElements = Array.from(listbox.querySelectorAll('[role="option"], [role="menuitem"]'));
    const options = optionElements.map(opt => ({
      element: opt,
      text: opt.textContent.trim()
    }));

    console.log(`[Custom Dropdown] Listbox contains ${options.length} options. First 5:`, options.slice(0, 5).map(o => o.text));

    // Fuzzy match value to options
    const optionTexts = options.map(o => o.text);
    const matchedText = fuzzyMatch(value, optionTexts);

    if (!matchedText) {
      console.warn(`[Custom Dropdown] ✗ No match for "${value}" in ${options.length} options for "${elementLabel}"`);
      console.warn(`[Custom Dropdown] Available options:`, optionTexts);
      // Close dropdown
      element.click();
      return false;
    }

    // Find and click the matched option
    const matchedOption = options.find(o => o.text === matchedText);
    if (matchedOption) {
      matchedOption.element.click();
      console.log(`[Custom Dropdown] ✓ Selected "${matchedText}" for "${elementLabel}"`);

      // Wait for dropdown to close
      await new Promise(resolve => setTimeout(resolve, 200));
      return true;
    }

    return false;
  } catch (error) {
    console.error('[Custom Dropdown] Error:', error);
    return false;
  }
}

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

    // Collect all questions with metadata
    for (const element of formElements) {
      if (processedElements.has(element)) continue;
      if (!document.contains(element)) continue;

      // Skip special types that need individual handling
      if (element.type === 'file' || element.type === 'radio' || element.type === 'checkbox') {
        continue;
      }

      // Skip Selectize-generated inputs (they're created by Selectize.js and should be ignored)
      if (element.tagName === 'INPUT' &&
          (element.closest('.selectize-input') ||
           element.closest('.selectize-control') ||
           element.id.endsWith('-selectized'))) {
        console.log(`[Gemini Filler] Skipping Selectize-generated input: ${element.id}`);
        continue;
      }

      const question = getQuestionForInput(element);
      if (!question) continue;

      // Detect field type and metadata
      const fieldMetadata = detectFieldType(element);

      // Skip custom dropdowns in batch - they need individual handling
      if (fieldMetadata.type === 'custom-dropdown') {
        continue;
      }

      console.log(`[Gemini Filler] Field "${question}" detected as type: ${fieldMetadata.type}`, fieldMetadata);

      batchQuestions.push({
        question: question,
        options: fieldMetadata.options,
        type: fieldMetadata.type,
        format: fieldMetadata.format
      });
      batchElements.push(element);
      batchMetadata.push(fieldMetadata);
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

          // Handle different field types
          if (metadata.type === 'select') {
            const bestMatchText = fuzzyMatch(answer, metadata.options);
            console.log(`[Gemini Filler] fuzzyMatch("${answer}") -> "${bestMatchText}" from ${metadata.options?.length || 0} options`);
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
              console.warn(`[Gemini Filler] fuzzyMatch failed for answer "${answer}" in SELECT with ${metadata.options?.length} options`);
            }
          } else if (metadata.type === 'radio' && element.getAttribute('role') === 'radiogroup') {
            const radioButtons = Array.from(element.querySelectorAll('button[role="radio"]'));
            const optionDetails = radioButtons.map(rb => {
              const label = document.querySelector(`label[for="${rb.id}"]`) || rb.closest('div')?.querySelector('label');
              return {
                button: rb,
                text: label ? label.textContent.trim() : rb.getAttribute('aria-label') || ''
              };
            });

            const bestMatchText = fuzzyMatch(answer, optionDetails.map(o => o.text));
            console.log(`[Gemini Filler] fuzzyMatch("${answer}") -> "${bestMatchText}" for radiogroup with ${optionDetails.length} options`);
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
              console.warn(`[Gemini Filler] fuzzyMatch failed for answer "${answer}" in radiogroup with ${optionDetails.length} options`);
            }
          } else if (metadata.type === 'datepicker') {
            // Handle datepicker
            const success = fillDatepicker(element, answer);
            if (success) {
              aChangeWasMade = true;
              filled = true;
            } else {
              console.warn(`[Gemini Filler] Failed to fill datepicker with: "${answer}"`);
            }
          } else if (metadata.type === 'selectize') {
            // Handle Selectize.js dropdown
            const success = await fillSelectize(element, answer, metadata.options);
            if (success) {
              aChangeWasMade = true;
              filled = true;
            } else {
              console.warn(`[Gemini Filler] Failed to fill selectize with: "${answer}"`);
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

      // Skip Selectize-generated inputs (they're created by Selectize.js and should be ignored)
      if (element.tagName === 'INPUT' &&
          (element.closest('.selectize-input') ||
           element.closest('.selectize-control') ||
           element.id.endsWith('-selectized'))) {
        continue;
      }

      const question = getQuestionForInput(element);
      if (!question) {
        continue;
      }

      // Detect field type and metadata
      const fieldMetadata = detectFieldType(element);
      const optionsText = fieldMetadata.options;

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
        // Handle different field types
        if (fieldMetadata.type === 'select') {
          const bestMatchText = fuzzyMatch(answer, optionsText);
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
        } else if (fieldMetadata.type === 'custom-dropdown') {
          // Use new custom dropdown handler
          const success = await fillCustomDropdown(element, answer);
          if (success) {
            aChangeWasMade = true;
          }
        } else if (fieldMetadata.type === 'radio' && element.getAttribute('role') === 'radiogroup') {
          const radioButtons = Array.from(element.querySelectorAll('button[role="radio"]'));
          const optionDetails = radioButtons.map(rb => {
            const label = document.querySelector(`label[for="${rb.id}"]`) || rb.closest('div')?.querySelector('label');
            return {
              button: rb,
              text: label ? label.textContent.trim() : rb.getAttribute('aria-label') || ''
            };
          });

          const bestMatchText = fuzzyMatch(answer, optionDetails.map(o => o.text));
          if (bestMatchText) {
            const matchingOption = optionDetails.find(o => o.text === bestMatchText);
            if (matchingOption) {
              matchingOption.button.click();
              aChangeWasMade = true;
            }
          }
        } else if (fieldMetadata.type === 'datepicker') {
          const success = fillDatepicker(element, answer);
          if (success) {
            aChangeWasMade = true;
          }
        } else if (fieldMetadata.type === 'selectize') {
          // Handle Selectize.js dropdown
          const success = await fillSelectize(element, answer, fieldMetadata.options);
          if (success) {
            aChangeWasMade = true;
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
  let matchStrategy = null;

  // 1. Check for a wrapping label
  if (input.parentElement.tagName === 'LABEL') {
    questionText = input.parentElement.textContent.trim();
    matchStrategy = '1:wrapping-label';
  }

  // 2. Check for a `for` attribute
  if (!questionText && input.id) {
    const label = document.querySelector(`label[for="${input.id}"]`);
    if (label) {
      questionText = label.textContent.trim();
      matchStrategy = `2:label-for[${input.id}]`;
    }

    // Special case: Selectize.js creates inputs with ID ending in '-selectized'
    // and moves the label to point to that input, so for original SELECT elements
    // with class 'selectized', also check for label pointing to ID + '-selectized'
    if (!questionText && input.tagName === 'SELECT' && input.classList.contains('selectized')) {
      const selectizeLabel = document.querySelector(`label[for="${input.id}-selectized"]`);
      if (selectizeLabel) {
        questionText = selectizeLabel.textContent.trim();
        matchStrategy = `2:selectize-label-for[${input.id}-selectized]`;
        console.log(`[Gemini Filler] Found Selectize label for SELECT: "${questionText}"`);
      }
    }
  }

  // 3. Check for aria-labelledby
  if (!questionText && input.getAttribute('aria-labelledby')) {
    const ariaLabelledBy = input.getAttribute('aria-labelledby');
    const label = document.getElementById(ariaLabelledBy);
    if (label) {
      questionText = label.textContent.trim();
      matchStrategy = `3:aria-labelledby[${ariaLabelledBy}]`;
    }
  }

  // 4. Traverse up the DOM to find a nearby label
  if (!questionText) {
    let current = input;
    let depth = 0;
    while (current.parentElement && depth < 5) {
      const parent = current.parentElement;
      const parentTag = parent.tagName + (parent.className ? '.' + parent.className.split(' ')[0] : '');

      const label = parent.querySelector('label');
      if (label && label.contains(input)) {
         questionText = label.textContent.trim();
         matchStrategy = `4a:parent-label-contains[depth=${depth}, parent=${parentTag}]`;
         console.log(`[getQuestion DEBUG] Strategy 4a matched: "${questionText}" (label contains input)`);
         break;
      }

      const labels = parent.querySelectorAll('label');
      console.log(`[getQuestion DEBUG] Checking parent at depth ${depth} (${parentTag}): found ${labels.length} labels`);

      for(let i = 0; i < labels.length; i++) {
          const l = labels[i];
          const labelText = l.textContent.trim().substring(0, 50);

          if(l.contains(input)) {
            questionText = l.textContent.trim();
            matchStrategy = `4b:label-contains[depth=${depth}, parent=${parentTag}, labelIdx=${i}]`;
            console.log(`[getQuestion DEBUG] Strategy 4b matched: "${labelText}..." (label ${i} contains input)`);
            break;
          }

          if(l.nextElementSibling === input) {
            questionText = l.textContent.trim();
            matchStrategy = `4c:label-nextSibling[depth=${depth}, parent=${parentTag}, labelIdx=${i}]`;
            console.log(`[getQuestion DEBUG] Strategy 4c matched: "${labelText}..." (label ${i} nextSibling is input)`);
            break;
          }

          // NEW: Check if label's next sibling is a container that contains the input
          if (l.nextElementSibling && l.nextElementSibling.contains && l.nextElementSibling.contains(input)) {
            questionText = l.textContent.trim();
            matchStrategy = `4d:label-nextSibling-contains[depth=${depth}, parent=${parentTag}, labelIdx=${i}]`;
            console.log(`[getQuestion DEBUG] Strategy 4d matched: "${labelText}..." (label ${i} nextSibling contains input)`);
            break;
          }
      }
      if (questionText) break;
      current = parent;
      depth++;
    }
  }

  // 5. Fallback to aria-label or placeholder
  if (!questionText && input.getAttribute('aria-label')) {
    questionText = input.getAttribute('aria-label').trim();
    matchStrategy = '5:aria-label';
  }

  if (!questionText && input.getAttribute('placeholder')) {
    questionText = input.getAttribute('placeholder').trim();
    matchStrategy = '6:placeholder';
  }

  // Log detailed information about the match
  if (questionText && matchStrategy) {
    console.log(`[getQuestion] Element ${input.tagName}${input.id ? '#'+input.id : ''}${input.name ? '[name='+input.name+']' : ''} → Question: "${questionText.substring(0, 80)}" [${matchStrategy}]`);
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

        // CRITICAL: Never click submit/send buttons!
        const submitKeywords = ['submit', 'send', 'wyślij', 'aplikuj', 'apply', 'prześlij'];
        const isSubmitButton = submitKeywords.some(keyword => combinedText.includes(keyword));

        // Also check if it's an actual submit button element
        const isSubmitElement = (button.tagName === 'BUTTON' && button.type === 'submit') ||
                               (button.tagName === 'INPUT' && button.type === 'submit');

        if (isSubmitButton || isSubmitElement) {
          console.log('[Gemini Filler] SKIPPING button - appears to be a submit button:', combinedText);
          continue;
        }

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
    // Always show tracker prompt after form fill
    // User can click "Pomiń" if they don't want to add to tracker
    modal.innerHTML = `
      <div class="checkmark">✓</div>
      <p>Gotowe!</p>
      <div style="margin-top: 20px; padding-top: 15px; border-top: 1px solid #e0e0e0;">
        <p style="font-size: 0.9em; margin-bottom: 10px;">Czy dodać tę aplikację do trackera?</p>
        <div style="display: flex; gap: 10px;">
          <button id="add-to-tracker-btn" style="
            flex: 1;
            padding: 8px 16px;
            background: #4CAF50;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-weight: 500;
            font-size: 0.9em;
          ">
            📋 Dodaj do trackera
          </button>
          <button id="skip-tracker-btn" style="
            flex: 1;
            padding: 8px 16px;
            background: #999;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.9em;
          ">
            Pomiń
          </button>
        </div>
      </div>
    `;

    // Add event listeners for the buttons
    setTimeout(() => {
      const addBtn = document.getElementById('add-to-tracker-btn');
      const skipBtn = document.getElementById('skip-tracker-btn');

      if (addBtn) {
        addBtn.addEventListener('click', () => {
          hideOverlay();
          const jobInfo = extractJobInfoFromPage();
          showAddApplicationModalFromContent(jobInfo);
        });
      }

      if (skipBtn) {
        skipBtn.addEventListener('click', () => {
          hideOverlay();
        });
      }
    }, 100);
  } else {
    console.log('[Tracker] Modal element not found!');
  }
}

// Extract job info from current page
function extractJobInfoFromPage() {
  console.log('[Application Tracker] Extracting job information from page...');

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
      break;
    }
  }

  // If we couldn't find title or company, try to get from page title
  if (!jobInfo.job_title && !jobInfo.company) {
    const pageTitle = document.title;
    const titleParts = pageTitle.split(/[-|]/);
    if (titleParts.length >= 2) {
      jobInfo.job_title = titleParts[0].trim();
      jobInfo.company = titleParts[1].trim();
    }
  }

  return jobInfo;
}

// Show modal to add application from content script
function showAddApplicationModalFromContent(jobInfo) {
  // Check if modal already exists
  if (document.getElementById('tracker-add-modal')) {
    return;
  }

  const modal = document.createElement('div');
  modal.id = 'tracker-add-modal';
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
    max-height: 80vh;
    overflow-y: auto;
    box-shadow: 0 10px 40px rgba(0,0,0,0.3);
    animation: slideUp 0.3s;
  `;

  const today = new Date().toISOString().split('T')[0];

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

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

    <h2 style="margin-top: 0; color: #333; font-size: 1.5em;">💼 Dodaj aplikację</h2>

    <div style="margin-bottom: 15px;">
      <label style="display: block; margin-bottom: 5px; font-weight: 500; color: #555;">Stanowisko:</label>
      <input type="text" id="content-job-title" value="${escapeHtml(jobInfo.job_title)}"
        style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px;">
    </div>

    <div style="margin-bottom: 15px;">
      <label style="display: block; margin-bottom: 5px; font-weight: 500; color: #555;">Firma:</label>
      <input type="text" id="content-company" value="${escapeHtml(jobInfo.company)}"
        style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px;">
    </div>

    <div style="margin-bottom: 15px;">
      <label style="display: block; margin-bottom: 5px; font-weight: 500; color: #555;">Lokalizacja:</label>
      <input type="text" id="content-location" value="${escapeHtml(jobInfo.location)}"
        style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px;">
    </div>

    <div style="margin-bottom: 20px;">
      <label style="display: block; margin-bottom: 5px; font-weight: 500; color: #555;">Wynagrodzenie:</label>
      <input type="text" id="content-salary" value="${escapeHtml(jobInfo.salary)}"
        style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px;">
    </div>

    <div style="display: flex; gap: 10px;">
      <button id="content-save-btn" style="flex: 1; padding: 12px; background: #4CAF50; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 14px;">
        💾 Zapisz
      </button>
      <button id="content-cancel-btn" style="flex: 1; padding: 12px; background: #999; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px;">
        Anuluj
      </button>
    </div>
  `;

  modal.appendChild(content);
  document.body.appendChild(modal);

  // Event listeners
  document.getElementById('content-cancel-btn').addEventListener('click', () => {
    modal.remove();
  });

  document.getElementById('content-save-btn').addEventListener('click', () => {
    const applicationData = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2),
      job_title: document.getElementById('content-job-title').value.trim(),
      company: document.getElementById('content-company').value.trim(),
      location: document.getElementById('content-location').value.trim(),
      salary: document.getElementById('content-salary').value.trim(),
      status: 'applied',
      applied_date: today,
      job_url: jobInfo.job_url,
      source: jobInfo.source,
      notes: '',
      timeline: [{
        date: new Date().toISOString(),
        event: 'Aplikacja dodana po wypełnieniu formularza'
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
// Tracker prompt is now shown directly in showSuccessOverlay() after form fill
