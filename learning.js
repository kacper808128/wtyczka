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

/**
 * Get all learned questions from storage
 */
async function getLearnedQuestions() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['learnedQuestions'], (result) => {
      if (chrome.runtime.lastError) {
        console.error('[Learning] Error getting questions:', chrome.runtime.lastError);
        resolve([]);
        return;
      }
      resolve(result.learnedQuestions || []);
    });
  });
}

/**
 * Save learned questions to storage
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

    chrome.storage.local.set({ learnedQuestions: questions }, () => {
      if (chrome.runtime.lastError) {
        console.error('[Learning] Error saving questions:', chrome.runtime.lastError);
        reject(chrome.runtime.lastError);
      } else {
        resolve();
      }
    });
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
      <button class="feedback-btn feedback-yes" data-hash="${questionHash}" data-feedback="positive">
        👍 Tak
      </button>
      <button class="feedback-btn feedback-no" data-hash="${questionHash}" data-feedback="negative">
        👎 Nie
      </button>
    `;

    // Set relative positioning for parent
    const originalPosition = window.getComputedStyle(parent).position;
    if (originalPosition === 'static') {
      parent.style.position = 'relative';
    }

    parent.appendChild(feedbackContainer);

    // Event listeners
    feedbackContainer.querySelectorAll('.feedback-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        const hash = e.target.dataset.hash;
        const feedback = e.target.dataset.feedback;
        await recordFeedback(hash, feedback);

        // Show quick confirmation
        feedbackContainer.innerHTML = `<span style="color: green;">✓ Dziękujemy za feedback!</span>`;
        setTimeout(() => feedbackContainer.remove(), 2000);
      });
    });

    // Auto-remove after 10 seconds
    setTimeout(() => {
      if (feedbackContainer.parentElement) {
        feedbackContainer.remove();
      }
    }, 10000);
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
