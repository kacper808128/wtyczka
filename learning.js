// Learning System for Form Autofill Extension
// This module handles question detection, storage, and suggestion

// ==================== Core Functions ====================

/**
 * Normalize question text for comparison and hashing
 */
function normalizeQuestion(question) {
  if (!question) return '';

  return question
    .toLowerCase()
    .replace(/[^\w\sąćęłńóśźż]/g, '') // Remove special chars but keep Polish letters
    .replace(/\s+/g, ' ')              // Normalize whitespace
    .trim();
}

/**
 * Generate a simple hash for question identification
 */
function generateHash(text) {
  if (!text) return '0';

  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * Find question/label for a field element
 */
function findQuestionForField(fieldElement) {
  if (!fieldElement) return '';

  // Strategy 1: <label for="id">
  if (fieldElement.id) {
    const label = document.querySelector(`label[for="${fieldElement.id}"]`);
    if (label) return label.textContent.trim();
  }

  // Strategy 2: Parent <label>
  const parentLabel = fieldElement.closest('label');
  if (parentLabel) return parentLabel.textContent.trim();

  // Strategy 3: aria-labelledby
  const ariaLabelledBy = fieldElement.getAttribute('aria-labelledby');
  if (ariaLabelledBy) {
    const labelElement = document.getElementById(ariaLabelledBy);
    if (labelElement) return labelElement.textContent.trim();
  }

  // Strategy 4: Traverse up to find nearby label
  let current = fieldElement.parentElement;
  let depth = 0;
  while (current && depth < 3) {
    const label = current.querySelector('label');
    if (label && (label.contains(fieldElement) || label.textContent.trim().length > 0)) {
      return label.textContent.trim();
    }
    current = current.parentElement;
    depth++;
  }

  // Strategy 5: Previous text node
  const previousText = findPreviousTextNode(fieldElement);
  if (previousText) return previousText.trim();

  // Fallback: placeholder, aria-label, or name
  return fieldElement.placeholder ||
         fieldElement.getAttribute('aria-label') ||
         fieldElement.name ||
         'Unknown question';
}

/**
 * Find previous text node (helper)
 */
function findPreviousTextNode(element) {
  let prev = element.previousSibling;
  while (prev) {
    if (prev.nodeType === Node.TEXT_NODE && prev.textContent.trim()) {
      return prev.textContent;
    }
    if (prev.nodeType === Node.ELEMENT_NODE && prev.textContent.trim()) {
      return prev.textContent;
    }
    prev = prev.previousSibling;
  }
  return null;
}

// ==================== Storage Functions ====================
// Page context doesn't have access to chrome.storage, so we use storage bridge
let storageRequestCounter = 0;

/**
 * Get all learned questions from storage (via storage bridge)
 */
async function getLearnedQuestions() {
  return new Promise((resolve) => {
    const requestId = `storage_${Date.now()}_${storageRequestCounter++}`;
    console.log('[Learning] 📤 Sending storageGet request:', requestId);

    const responseHandler = (event) => {
      if (event.detail.requestId === requestId) {
        console.log('[Learning] 📥 Received storageGet response:', requestId, 'questions:', event.detail.data?.length || 0);
        clearTimeout(timeoutId);  // Clear timeout on success
        document.removeEventListener('learning:storageGetResponse', responseHandler);
        resolve(event.detail.data || []);
      }
    };

    document.addEventListener('learning:storageGetResponse', responseHandler);

    // Timeout after 5 seconds
    const timeoutId = setTimeout(() => {
      document.removeEventListener('learning:storageGetResponse', responseHandler);
      console.warn('[Learning] ❌ Storage get timeout for requestId:', requestId);
      resolve([]);
    }, 5000);

    document.dispatchEvent(new CustomEvent('learning:storageGet', {
      detail: { key: 'learnedQuestions', requestId }
    }));
    console.log('[Learning] ✅ StorageGet event dispatched:', requestId);
  });
}

/**
 * Save learned questions to storage (via storage bridge)
 */
async function saveLearnedQuestions(questions) {
  return new Promise((resolve, reject) => {
    // Check storage size limit (10MB for local storage)
    const dataSize = JSON.stringify(questions).length;
    const MAX_SIZE = 9 * 1024 * 1024; // 9MB to be safe

    if (dataSize > MAX_SIZE) {
      console.warn('[Learning] Storage limit approaching, removing old questions');
      // Keep only most used questions
      questions.sort((a, b) => b.frequency - a.frequency);
      questions = questions.slice(0, Math.floor(questions.length * 0.7));
    }

    const requestId = `storage_${Date.now()}_${storageRequestCounter++}`;
    console.log('[Learning] 📤 Sending storageSet request:', requestId, 'questions count:', questions.length);

    const responseHandler = (event) => {
      if (event.detail.requestId === requestId) {
        console.log('[Learning] 📥 Received storageSet response:', requestId, 'success:', event.detail.success);
        clearTimeout(timeoutId);  // Clear timeout on success
        document.removeEventListener('learning:storageSetResponse', responseHandler);
        if (event.detail.success) {
          resolve();
        } else {
          reject(new Error('Storage set failed'));
        }
      }
    };

    document.addEventListener('learning:storageSetResponse', responseHandler);

    // Timeout after 5 seconds
    const timeoutId = setTimeout(() => {
      document.removeEventListener('learning:storageSetResponse', responseHandler);
      console.warn('[Learning] ❌ Storage set timeout for requestId:', requestId);
      reject(new Error('Storage set timeout'));
    }, 5000);

    document.dispatchEvent(new CustomEvent('learning:storageSet', {
      detail: { key: 'learnedQuestions', value: questions, requestId }
    }));
    console.log('[Learning] ✅ StorageSet event dispatched:', requestId);
  });
}

/**
 * Find existing question by hash
 */
async function findExistingQuestion(questionHash) {
  const questions = await getLearnedQuestions();
  return questions.find(q => q.question_hash === questionHash);
}

/**
 * Find similar question using fuzzy matching
 */
async function findSimilarQuestion(normalizedQuestion) {
  const questions = await getLearnedQuestions();

  const queryWords = new Set(normalizedQuestion.split(' ').filter(w => w.length > 2));
  if (queryWords.size === 0) return null;

  let bestMatch = null;
  let bestScore = 0;

  questions.forEach(q => {
    const questionWords = new Set(normalizeQuestion(q.question_text).split(' ').filter(w => w.length > 2));
    if (questionWords.size === 0) return;

    const intersection = new Set([...queryWords].filter(x => questionWords.has(x)));
    const union = new Set([...queryWords, ...questionWords]);
    const similarity = intersection.size / union.size;

    // Check variations too
    let maxVariationSimilarity = 0;
    q.variations.forEach(variation => {
      const varWords = new Set(variation.split(' ').filter(w => w.length > 2));
      const varIntersection = new Set([...queryWords].filter(x => varWords.has(x)));
      const varUnion = new Set([...queryWords, ...varWords]);
      const varSimilarity = varIntersection.size / varUnion.size;
      maxVariationSimilarity = Math.max(maxVariationSimilarity, varSimilarity);
    });

    const finalSimilarity = Math.max(similarity, maxVariationSimilarity);

    if (finalSimilarity > 0.5 && finalSimilarity > bestScore) {
      bestScore = finalSimilarity;
      bestMatch = q;
    }
  });

  return bestMatch;
}

// ==================== Capture & Update Functions ====================

/**
 * Capture a question and user's answer
 */
async function captureQuestion(fieldElement, userAnswer) {
  try {
    if (!fieldElement || !userAnswer) return null;

    const questionText = findQuestionForField(fieldElement);
    if (!questionText || questionText === 'Unknown question') return null;

    const normalizedQuestion = normalizeQuestion(questionText);
    const questionHash = generateHash(normalizedQuestion);

    const existingQuestion = await findExistingQuestion(questionHash);

    if (existingQuestion) {
      await updateQuestionStats(existingQuestion, userAnswer);
    } else {
      await saveNewQuestion({
        question_hash: questionHash,
        question_text: questionText,
        variations: [normalizedQuestion],
        user_answer: userAnswer,
        frequency: 1,
        last_used: new Date().toISOString(),
        field_type: fieldElement.type || 'text',
        confidence: 0.5,
        context: {
          field_name: fieldElement.name || '',
          field_id: fieldElement.id || '',
          form_url: window.location.href
        },
        created_at: new Date().toISOString(),
        feedback_positive: 0,
        feedback_negative: 0
      });

      // Show notification for new question
      showNewQuestionNotification(questionText);
    }

    // Return the questionHash so content.js can add feedback button
    return questionHash;
  } catch (error) {
    console.error('[Learning] Error capturing question:', error);
    return null;
  }
}

/**
 * Save a new question
 */
async function saveNewQuestion(questionData) {
  try {
    const questions = await getLearnedQuestions();
    questions.push(questionData);
    await saveLearnedQuestions(questions);
    console.log('[Learning] New question saved:', questionData.question_text);
  } catch (error) {
    console.error('[Learning] Error saving new question:', error);
  }
}

/**
 * Update statistics for existing question
 */
async function updateQuestionStats(question, newAnswer) {
  try {
    const questions = await getLearnedQuestions();
    const index = questions.findIndex(q => q.question_hash === question.question_hash);

    if (index !== -1) {
      questions[index].frequency += 1;
      questions[index].last_used = new Date().toISOString();

      // If answer changed, lower confidence
      if (questions[index].user_answer !== newAnswer) {
        questions[index].user_answer = newAnswer;
        questions[index].confidence = Math.max(0.3, questions[index].confidence - 0.1);
        console.log('[Learning] Answer updated for:', questions[index].question_text);
      } else {
        // Same answer = higher confidence
        questions[index].confidence = Math.min(1.0, questions[index].confidence + 0.05);
      }

      await saveLearnedQuestions(questions);
    }
  } catch (error) {
    console.error('[Learning] Error updating question stats:', error);
  }
}

// ==================== Suggestion Functions ====================

/**
 * Get suggestion for a field
 */
async function getSuggestionForField(fieldElement) {
  try {
    const questionText = findQuestionForField(fieldElement);
    if (!questionText || questionText === 'Unknown question') return null;

    const normalizedQuestion = normalizeQuestion(questionText);
    const questionHash = generateHash(normalizedQuestion);

    // Try exact match first
    const existingQuestion = await findExistingQuestion(questionHash);
    if (existingQuestion && existingQuestion.confidence > 0.7) {
      return {
        answer: existingQuestion.user_answer,
        confidence: existingQuestion.confidence,
        source: 'learned',
        questionHash: existingQuestion.question_hash
      };
    }

    // Try fuzzy matching
    const similarQuestion = await findSimilarQuestion(normalizedQuestion);
    if (similarQuestion && similarQuestion.confidence > 0.6) {
      return {
        answer: similarQuestion.user_answer,
        confidence: similarQuestion.confidence * 0.8, // Lower confidence for fuzzy match
        source: 'similar',
        questionHash: similarQuestion.question_hash
      };
    }

    return null;
  } catch (error) {
    console.error('[Learning] Error getting suggestion:', error);
    return null;
  }
}

// ==================== Feedback Functions ====================

/**
 * Record user feedback for a question
 */
async function recordFeedback(questionHash, feedbackType) {
  try {
    const questions = await getLearnedQuestions();
    const index = questions.findIndex(q => q.question_hash === questionHash);

    if (index !== -1) {
      if (feedbackType === 'positive') {
        questions[index].feedback_positive += 1;
        questions[index].confidence = Math.min(1.0, questions[index].confidence + 0.1);
        console.log('[Learning] Positive feedback for:', questions[index].question_text);
      } else {
        questions[index].feedback_negative += 1;
        questions[index].confidence = Math.max(0.1, questions[index].confidence - 0.15);
        console.log('[Learning] Negative feedback for:', questions[index].question_text);
      }

      await saveLearnedQuestions(questions);
    }
  } catch (error) {
    console.error('[Learning] Error recording feedback:', error);
  }
}

// ==================== UI Functions ====================

/**
 * Edit answer for a learned question
 */
async function editAnswer(questionHash, fieldElement, feedbackContainer) {
  try {
    // Get current answer
    const questions = await getLearnedQuestions();
    const question = questions.find(q => q.question_hash === questionHash);

    if (!question) {
      console.error('[Learning] Question not found:', questionHash);
      return;
    }

    // Get current value from field
    let currentValue = '';
    if (fieldElement.tagName === 'SELECT') {
      // Safe array access with bounds checking
      if (fieldElement.selectedIndex >= 0 && fieldElement.selectedIndex < fieldElement.options.length) {
        const selectedOption = fieldElement.options[fieldElement.selectedIndex];
        currentValue = selectedOption ? selectedOption.text : '';
      }
    } else if (fieldElement.tagName === 'TEXTAREA' || fieldElement.type === 'text' || fieldElement.type === 'email' || fieldElement.type === 'tel') {
      currentValue = fieldElement.value || '';
    } else if (fieldElement.getAttribute('role') === 'radiogroup') {
      const selectedRadio = fieldElement.querySelector('button[role="radio"][aria-checked="true"]');
      if (selectedRadio) {
        const label = document.querySelector(`label[for="${selectedRadio.id}"]`) || selectedRadio.closest('div')?.querySelector('label');
        currentValue = label ? label.textContent.trim() : selectedRadio.getAttribute('aria-label') || '';
      }
    }

    // Show input for editing
    const label = feedbackContainer.querySelector('.feedback-label');
    const yesBtn = feedbackContainer.querySelector('.feedback-yes');
    const noBtn = feedbackContainer.querySelector('.feedback-no');
    const editBtn = feedbackContainer.querySelector('.feedback-edit');

    // Hide buttons and label
    yesBtn.style.display = 'none';
    noBtn.style.display = 'none';
    editBtn.style.display = 'none';
    label.style.display = 'none';

    // Create input field
    const editContainer = document.createElement('div');
    editContainer.className = 'feedback-edit-container';
    editContainer.innerHTML = `
      <input type="text" class="feedback-edit-input" value="${currentValue.replace(/"/g, '&quot;')}" placeholder="Wpisz odpowiedź...">
      <button type="button" class="feedback-btn feedback-save">💾 Zapisz</button>
      <button type="button" class="feedback-btn feedback-cancel">❌ Anuluj</button>
    `;
    feedbackContainer.appendChild(editContainer);

    const input = editContainer.querySelector('.feedback-edit-input');
    const saveBtn = editContainer.querySelector('.feedback-save');
    const cancelBtn = editContainer.querySelector('.feedback-cancel');

    // Focus input and select text
    input.focus();
    input.select();

    // Cancel handler
    const cancel = (event) => {
      // CRITICAL: Prevent form submission when clicking cancel button
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }

      editContainer.remove();
      yesBtn.style.display = '';
      noBtn.style.display = '';
      editBtn.style.display = '';
      label.style.display = '';
    };

    // Save handler
    const save = async (event) => {
      // CRITICAL: Prevent form submission when clicking save button
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }

      const newAnswer = input.value.trim();

      if (!newAnswer) {
        alert('Odpowiedź nie może być pusta');
        return;
      }

      // Update in storage
      const questions = await getLearnedQuestions();
      const index = questions.findIndex(q => q.question_hash === questionHash);

      if (index !== -1) {
        questions[index].user_answer = newAnswer;
        questions[index].confidence = 1.0; // 100% confidence for user-provided answer
        questions[index].feedback_positive += 1; // Count as positive feedback
        await saveLearnedQuestions(questions);
        console.log('[Learning] Answer updated:', question.question_text, '→', newAnswer);

        // Update field value in DOM
        if (fieldElement.tagName === 'TEXTAREA' || fieldElement.type === 'text' || fieldElement.type === 'email' || fieldElement.type === 'tel') {
          fieldElement.value = newAnswer;
          // Trigger change event
          const inputEvent = new Event('input', { bubbles: true });
          const changeEvent = new Event('change', { bubbles: true });
          fieldElement.dispatchEvent(inputEvent);
          fieldElement.dispatchEvent(changeEvent);
        }
        // For SELECT and radiogroup, user would need to manually select - we just saved the learned value

        // Show success message
        editContainer.remove();
        label.textContent = '✓ Odpowiedź zapisana!';
        label.style.color = 'green';
        label.style.display = '';

        // Disable all buttons
        yesBtn.disabled = true;
        noBtn.disabled = true;
        editBtn.disabled = true;
        yesBtn.style.display = '';
        noBtn.style.display = '';
        editBtn.style.display = '';
        yesBtn.style.opacity = '0.3';
        noBtn.style.opacity = '0.3';
        editBtn.style.opacity = '0.3';
      }
    };

    // Event listeners
    saveBtn.addEventListener('click', save);
    cancelBtn.addEventListener('click', cancel);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        save();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    });

  } catch (error) {
    console.error('[Learning] Error editing answer:', error);
  }
}

/**
 * Show notification for new question
 */
function showNewQuestionNotification(questionText) {
  // Don't show if there's already a notification
  if (document.querySelector('.autofill-new-question-notification')) {
    return;
  }

  const notification = document.createElement('div');
  notification.className = 'autofill-new-question-notification';
  notification.innerHTML = `
    <div class="notification-content">
      <div class="notification-icon">💡</div>
      <div class="notification-text">
        <strong>Nowe pytanie wykryte:</strong><br>
        "${questionText.length > 60 ? questionText.substring(0, 60) + '...' : questionText}"
      </div>
      <button class="notification-close">×</button>
    </div>
  `;

  document.body.appendChild(notification);

  // Close button
  notification.querySelector('.notification-close').addEventListener('click', () => {
    notification.style.animation = 'slideOut 0.3s ease-out';
    setTimeout(() => notification.remove(), 300);
  });

  // Auto-remove after 5 seconds
  setTimeout(() => {
    if (notification.parentElement) {
      notification.style.animation = 'slideOut 0.3s ease-out';
      setTimeout(() => notification.remove(), 300);
    }
  }, 5000);
}

/**
 * Add feedback buttons to a field
 */
function addFeedbackButton(fieldElement, questionHash) {
  try {
    // Don't add if already exists
    const parent = fieldElement.parentElement;
    if (!parent || parent.querySelector('.autofill-feedback')) {
      return;
    }

    const feedbackContainer = document.createElement('div');
    feedbackContainer.className = 'autofill-feedback';
    feedbackContainer.innerHTML = `
      <span class="feedback-label">Czy to poprawna odpowiedź?</span>
      <button type="button" class="feedback-btn feedback-yes" data-hash="${questionHash}" data-feedback="positive">
        👍 Tak
      </button>
      <button type="button" class="feedback-btn feedback-no" data-hash="${questionHash}" data-feedback="negative">
        👎 Nie
      </button>
      <button type="button" class="feedback-btn feedback-edit" data-hash="${questionHash}">
        ✏️ Edytuj
      </button>
    `;

    // Set relative positioning for parent
    const originalPosition = window.getComputedStyle(parent).position;
    if (originalPosition === 'static') {
      parent.style.position = 'relative';
    }

    parent.appendChild(feedbackContainer);

    // Event listeners for feedback buttons
    feedbackContainer.querySelectorAll('.feedback-yes, .feedback-no').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        const hash = e.target.dataset.hash;
        const feedback = e.target.dataset.feedback;
        await recordFeedback(hash, feedback);

        // Show confirmation but keep buttons visible (disabled)
        const yesBtn = feedbackContainer.querySelector('.feedback-yes');
        const noBtn = feedbackContainer.querySelector('.feedback-no');
        const editBtn = feedbackContainer.querySelector('.feedback-edit');
        const label = feedbackContainer.querySelector('.feedback-label');

        // Disable all buttons
        yesBtn.disabled = true;
        noBtn.disabled = true;
        editBtn.disabled = true;

        // Update styling to show which was clicked
        if (feedback === 'positive') {
          yesBtn.style.opacity = '1';
          yesBtn.style.fontWeight = 'bold';
          noBtn.style.opacity = '0.3';
        } else {
          noBtn.style.opacity = '1';
          noBtn.style.fontWeight = 'bold';
          yesBtn.style.opacity = '0.3';
        }
        editBtn.style.opacity = '0.3';

        // Update label to show confirmation
        label.textContent = '✓ Dziękujemy za feedback!';
        label.style.color = 'green';
      });
    });

    // Event listener for edit button
    const editBtn = feedbackContainer.querySelector('.feedback-edit');
    editBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      const hash = e.target.dataset.hash;
      await editAnswer(hash, fieldElement, feedbackContainer);
    });
  } catch (error) {
    console.error('[Learning] Error adding feedback button:', error);
  }
}

// ==================== Export/Import Functions ====================

/**
 * Export learned questions to JSON
 */
async function exportLearnedQuestions() {
  const questions = await getLearnedQuestions();
  const dataStr = JSON.stringify(questions, null, 2);
  const blob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `learned-questions-${new Date().toISOString().split('T')[0]}.json`;
  a.click();

  URL.revokeObjectURL(url);
}

/**
 * Import learned questions from JSON
 */
async function importLearnedQuestions(jsonData) {
  try {
    const questions = JSON.parse(jsonData);

    // Validate structure
    if (!Array.isArray(questions)) {
      throw new Error('Invalid format: expected array');
    }

    // Merge with existing questions (avoid duplicates)
    const existing = await getLearnedQuestions();
    const existingHashes = new Set(existing.map(q => q.question_hash));

    const newQuestions = questions.filter(q => !existingHashes.has(q.question_hash));
    const merged = [...existing, ...newQuestions];

    await saveLearnedQuestions(merged);

    return {
      success: true,
      imported: newQuestions.length,
      total: merged.length
    };
  } catch (error) {
    console.error('[Learning] Error importing questions:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Clear all learned questions
 */
async function clearAllLearnedQuestions() {
  await saveLearnedQuestions([]);
}

// ==================== Export to Window ====================
// Export functions to window object (for page context access)
window.captureQuestion = captureQuestion;
window.getSuggestionForField = getSuggestionForField;
window.addFeedbackButton = addFeedbackButton;
window.recordFeedback = recordFeedback;
window.getLearnedQuestions = getLearnedQuestions;
window.clearAllLearnedQuestions = clearAllLearnedQuestions;

console.log('[Learning] Functions exported to window:', {
  captureQuestion: typeof window.captureQuestion,
  getSuggestionForField: typeof window.getSuggestionForField,
  addFeedbackButton: typeof window.addFeedbackButton
});

// ==================== Event-Based Communication ====================
// Content scripts run in isolated world and can't access page's window directly
// Use custom DOM events for communication between isolated and page contexts

// Listen for captureQuestion requests from content script
document.addEventListener('learning:captureQuestion', async (event) => {
  try {
    const { questionText, answer, fieldType, fieldName, fieldId, requestId } = event.detail;

    // Create question data directly from passed data (no DOM element available)
    if (!questionText || !answer || questionText === 'Unknown question') {
      document.dispatchEvent(new CustomEvent('learning:captureQuestionResponse', {
        detail: { hash: null, requestId }
      }));
      return;
    }

    const normalizedQuestion = normalizeQuestion(questionText);
    const questionHash = generateHash(normalizedQuestion);
    const existingQuestion = await findExistingQuestion(questionHash);

    if (existingQuestion) {
      await updateQuestionStats(existingQuestion, answer);
    } else {
      await saveNewQuestion({
        question_hash: questionHash,
        question_text: questionText,
        variations: [normalizedQuestion],
        user_answer: answer,
        frequency: 1,
        last_used: new Date().toISOString(),
        field_type: fieldType || 'text',
        confidence: 0.5,
        context: {
          field_name: fieldName,
          field_id: fieldId,
          form_url: window.location.href
        },
        created_at: new Date().toISOString(),
        feedback_positive: 0,
        feedback_negative: 0
      });
      showNewQuestionNotification(questionText);
    }

    document.dispatchEvent(new CustomEvent('learning:captureQuestionResponse', {
      detail: { hash: questionHash, requestId }
    }));
  } catch (error) {
    console.error('[Learning] Error in captureQuestion event handler:', error);
    document.dispatchEvent(new CustomEvent('learning:captureQuestionResponse', {
      detail: { hash: null, error: error.message, requestId: event.detail?.requestId }
    }));
  }
});

// Listen for getSuggestion requests from content script
document.addEventListener('learning:getSuggestion', async (event) => {
  try {
    const { questionText, requestId } = event.detail;

    if (!questionText || questionText === 'Unknown question') {
      document.dispatchEvent(new CustomEvent('learning:getSuggestionResponse', {
        detail: { suggestion: null, requestId }
      }));
      return;
    }

    const normalizedQuestion = normalizeQuestion(questionText);
    const questionHash = generateHash(normalizedQuestion);

    // Try exact match first
    const existingQuestion = await findExistingQuestion(questionHash);
    if (existingQuestion && existingQuestion.confidence > 0.7) {
      document.dispatchEvent(new CustomEvent('learning:getSuggestionResponse', {
        detail: {
          suggestion: {
            answer: existingQuestion.user_answer,
            confidence: existingQuestion.confidence,
            source: 'learned',
            questionHash: existingQuestion.question_hash
          },
          requestId
        }
      }));
      return;
    }

    // Try fuzzy matching
    const similarQuestion = await findSimilarQuestion(normalizedQuestion);
    if (similarQuestion && similarQuestion.confidence > 0.6) {
      document.dispatchEvent(new CustomEvent('learning:getSuggestionResponse', {
        detail: {
          suggestion: {
            answer: similarQuestion.user_answer,
            confidence: similarQuestion.confidence * 0.8,
            source: 'similar',
            questionHash: similarQuestion.question_hash
          },
          requestId
        }
      }));
      return;
    }

    // No suggestion found
    document.dispatchEvent(new CustomEvent('learning:getSuggestionResponse', {
      detail: { suggestion: null, requestId }
    }));
  } catch (error) {
    console.error('[Learning] Error in getSuggestion event handler:', error);
    document.dispatchEvent(new CustomEvent('learning:getSuggestionResponse', {
      detail: { suggestion: null, error: error.message, requestId: event.detail?.requestId }
    }));
  }
});

// Listen for addFeedbackButton requests from content script
document.addEventListener('learning:addFeedbackButton', (event) => {
  try {
    const { elementId, questionHash } = event.detail;
    // Find element by the data attribute we added
    const element = document.querySelector(`[data-learning-feedback-id="${elementId}"]`);
    if (element) {
      addFeedbackButton(element, questionHash);
    } else {
      console.warn('[Learning] Could not find element for feedback button:', elementId);
    }
  } catch (error) {
    console.error('[Learning] Error in addFeedbackButton event handler:', error);
  }
});

console.log('[Learning] Event listeners registered for cross-context communication');
