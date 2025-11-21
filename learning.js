// Learning System for Form Autofill Extension
// This module handles question detection, storage, and suggestion

// ==================== Cache & Performance ====================

// In-memory cache for faster access
let questionsCache = null;
let questionsCacheMap = null; // Map<hash, question> for O(1) lookup
let cacheTimestamp = 0;
const CACHE_TTL = 30000; // 30 seconds

/**
 * Invalidate cache (call after any write operation)
 */
function invalidateCache() {
  questionsCache = null;
  questionsCacheMap = null;
  cacheTimestamp = 0;
}

/**
 * Build Map from questions array for O(1) lookup
 */
function buildQuestionsMap(questions) {
  return new Map(questions.map(q => [q.question_hash, q]));
}

// ==================== Synonyms Dictionary ====================

const FIELD_SYNONYMS = {
  // Name fields
  'imie': ['name', 'first name', 'imię', 'twoje imie', 'twoje imię', 'your name', 'vorname'],
  'nazwisko': ['last name', 'surname', 'family name', 'nachname'],
  'imie i nazwisko': ['full name', 'imię i nazwisko', 'your full name', 'name', 'vollständiger name'],

  // Contact fields
  'email': ['e-mail', 'adres email', 'adres e-mail', 'mail', 'your email', 'twój email', 'email address'],
  'telefon': ['phone', 'tel', 'numer telefonu', 'nr tel', 'phone number', 'mobile', 'komórka', 'nr telefonu'],

  // Address fields
  'adres': ['address', 'street', 'ulica', 'street address', 'adres zamieszkania'],
  'miasto': ['city', 'town', 'miejscowość'],
  'kod pocztowy': ['postal code', 'zip', 'zip code', 'postcode'],
  'kraj': ['country', 'państwo', 'land'],

  // Professional fields
  'stanowisko': ['position', 'job title', 'role', 'title', 'current position'],
  'firma': ['company', 'employer', 'organization', 'pracodawca', 'nazwa firmy'],
  'doswiadczenie': ['experience', 'doświadczenie', 'years of experience', 'lata doświadczenia'],
  'wyksztalcenie': ['education', 'wykształcenie', 'degree', 'studies'],
  'umiejetnosci': ['skills', 'umiejętności', 'competencies', 'kompetencje'],

  // Salary fields
  'wynagrodzenie': ['salary', 'pay', 'pensja', 'oczekiwane wynagrodzenie', 'expected salary'],
  'stawka': ['rate', 'hourly rate', 'stawka godzinowa'],

  // Other common fields
  'data urodzenia': ['birth date', 'date of birth', 'dob', 'birthday'],
  'linkedin': ['linkedin url', 'linkedin profile', 'profil linkedin'],
  'github': ['github url', 'github profile'],
  'portfolio': ['portfolio url', 'website', 'strona www'],
  'cv': ['resume', 'życiorys', 'curriculum vitae'],
  'list motywacyjny': ['cover letter', 'motivation letter'],
  'dostepnosc': ['availability', 'dostępność', 'available from', 'kiedy możesz zacząć'],
  'jezyki': ['languages', 'języki', 'language skills'],
};

/**
 * Find synonym group for a normalized question
 * Returns the canonical key if found, null otherwise
 */
function findSynonymGroup(normalizedText) {
  const words = normalizedText.toLowerCase().split(' ').filter(w => w.length > 1);

  for (const [canonical, synonyms] of Object.entries(FIELD_SYNONYMS)) {
    // Check if the text matches canonical or any synonym
    const allTerms = [canonical, ...synonyms];
    for (const term of allTerms) {
      const termWords = term.toLowerCase().split(' ');
      // Check if all term words are in the question
      const allWordsMatch = termWords.every(tw =>
        words.some(w => w.includes(tw) || tw.includes(w))
      );
      if (allWordsMatch && termWords.length > 0) {
        return canonical;
      }
    }
  }
  return null;
}

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
 * Uses in-memory cache for better performance
 */
async function getLearnedQuestions() {
  // Check cache first
  if (questionsCache && Date.now() - cacheTimestamp < CACHE_TTL) {
    console.log('[Learning] 📦 Using cached questions:', questionsCache.length);
    return questionsCache;
  }

  return new Promise((resolve) => {
    const requestId = `storage_${Date.now()}_${storageRequestCounter++}`;
    console.log('[Learning] 📤 Sending storageGet request:', requestId);

    let retryCount = 0;
    const maxRetries = 3;
    const baseDelay = 1000; // 1 second

    const attemptFetch = () => {
      const responseHandler = (event) => {
        if (event.detail.requestId === requestId) {
          console.log('[Learning] 📥 Received storageGet response:', requestId, 'questions:', event.detail.data?.length || 0);
          clearTimeout(timeoutId);
          document.removeEventListener('learning:storageGetResponse', responseHandler);

          const questions = event.detail.data || [];
          // Update cache
          questionsCache = questions;
          questionsCacheMap = buildQuestionsMap(questions);
          cacheTimestamp = Date.now();

          resolve(questions);
        }
      };

      document.addEventListener('learning:storageGetResponse', responseHandler);

      // Timeout with exponential backoff retry
      const timeoutId = setTimeout(() => {
        document.removeEventListener('learning:storageGetResponse', responseHandler);

        if (retryCount < maxRetries) {
          retryCount++;
          const delay = baseDelay * Math.pow(2, retryCount - 1); // 1s, 2s, 4s
          console.warn(`[Learning] ⏳ Storage get timeout, retry ${retryCount}/${maxRetries} in ${delay}ms`);
          setTimeout(attemptFetch, delay);
        } else {
          console.error('[Learning] ❌ Storage get failed after', maxRetries, 'retries');
          showStorageErrorNotification();
          resolve(questionsCache || []); // Return cached data if available, otherwise empty
        }
      }, 5000);

      document.dispatchEvent(new CustomEvent('learning:storageGet', {
        detail: { key: 'learnedQuestions', requestId }
      }));
    };

    attemptFetch();
    console.log('[Learning] ✅ StorageGet event dispatched:', requestId);
  });
}

/**
 * Show notification when storage operations fail
 */
function showStorageErrorNotification() {
  if (document.querySelector('.autofill-storage-error-notification')) return;

  const notification = document.createElement('div');
  notification.className = 'autofill-storage-error-notification';
  notification.innerHTML = `
    <div class="notification-content" style="background: #ffebee; border: 1px solid #f44336; border-radius: 8px; padding: 12px 16px; position: fixed; top: 20px; right: 20px; z-index: 999999; box-shadow: 0 4px 12px rgba(0,0,0,0.15); max-width: 350px;">
      <div style="display: flex; align-items: flex-start; gap: 10px;">
        <div style="font-size: 20px;">⚠️</div>
        <div style="flex: 1;">
          <strong style="color: #c62828;">Problem z pamięcią</strong><br>
          <span style="font-size: 13px; color: #666;">Nie udało się załadować zapisanych odpowiedzi. Sprawdź połączenie lub odśwież stronę.</span>
        </div>
        <button class="notification-close" style="background: none; border: none; font-size: 18px; cursor: pointer; color: #999;">×</button>
      </div>
    </div>
  `;

  document.body.appendChild(notification);

  notification.querySelector('.notification-close').addEventListener('click', () => {
    notification.remove();
  });

  setTimeout(() => notification.remove(), 10000);
}

/**
 * Calculate cleanup score for a question (lower = should be removed first)
 */
function calculateCleanupScore(question) {
  const now = Date.now();
  const lastUsed = new Date(question.last_used || question.created_at).getTime();
  const daysSinceUsed = (now - lastUsed) / (1000 * 60 * 60 * 24);

  // Score based on: confidence, frequency, recency, feedback
  const confidenceScore = question.confidence * 30;
  const frequencyScore = Math.min(question.frequency, 20) * 2;
  const recencyScore = Math.max(0, 30 - daysSinceUsed); // Higher for recent
  const feedbackScore = (question.feedback_positive - question.feedback_negative) * 5;

  return confidenceScore + frequencyScore + recencyScore + feedbackScore;
}

/**
 * Show warning before data cleanup with export option
 */
function showCleanupWarning(questionsToRemove, totalQuestions) {
  return new Promise((resolve) => {
    const notification = document.createElement('div');
    notification.className = 'autofill-cleanup-warning';
    notification.innerHTML = `
      <div class="notification-content" style="background: #fff3e0; border: 1px solid #ff9800; border-radius: 8px; padding: 16px; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 999999; box-shadow: 0 8px 32px rgba(0,0,0,0.3); max-width: 450px; text-align: center;">
        <div style="font-size: 48px; margin-bottom: 12px;">⚠️</div>
        <h3 style="margin: 0 0 8px 0; color: #e65100;">Pamięć prawie pełna</h3>
        <p style="margin: 0 0 16px 0; color: #666; font-size: 14px;">
          Aby kontynuować, musimy usunąć <strong>${questionsToRemove}</strong> z <strong>${totalQuestions}</strong> zapisanych pytań
          (najmniej używane i najstarsze).
        </p>
        <div style="display: flex; gap: 10px; justify-content: center; flex-wrap: wrap;">
          <button class="cleanup-export" style="padding: 10px 20px; background: #4CAF50; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px;">
            📥 Eksportuj najpierw
          </button>
          <button class="cleanup-continue" style="padding: 10px 20px; background: #ff9800; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px;">
            🗑️ Kontynuuj bez eksportu
          </button>
          <button class="cleanup-cancel" style="padding: 10px 20px; background: #9e9e9e; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px;">
            ❌ Anuluj
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(notification);

    notification.querySelector('.cleanup-export').addEventListener('click', async () => {
      await exportLearnedQuestions();
      notification.remove();
      resolve('continue');
    });

    notification.querySelector('.cleanup-continue').addEventListener('click', () => {
      notification.remove();
      resolve('continue');
    });

    notification.querySelector('.cleanup-cancel').addEventListener('click', () => {
      notification.remove();
      resolve('cancel');
    });
  });
}

/**
 * Save learned questions to storage (via storage bridge)
 */
async function saveLearnedQuestions(questions) {
  // Invalidate cache before save
  invalidateCache();

  return new Promise(async (resolveMain, rejectMain) => {
    // Check storage size limit (10MB for local storage)
    const dataSize = JSON.stringify(questions).length;
    const MAX_SIZE = 9 * 1024 * 1024; // 9MB to be safe
    const WARNING_SIZE = 8 * 1024 * 1024; // 8MB - show warning

    if (dataSize > MAX_SIZE) {
      const originalCount = questions.length;
      const targetCount = Math.floor(originalCount * 0.7);
      const toRemove = originalCount - targetCount;

      console.warn('[Learning] Storage limit exceeded, need to remove', toRemove, 'questions');

      // Show warning to user
      const userChoice = await showCleanupWarning(toRemove, originalCount);

      if (userChoice === 'cancel') {
        rejectMain(new Error('User cancelled cleanup'));
        return;
      }

      // Smart cleanup: sort by cleanup score and remove lowest scoring
      questions.sort((a, b) => calculateCleanupScore(b) - calculateCleanupScore(a));
      questions = questions.slice(0, targetCount);

      console.log('[Learning] Cleaned up to', questions.length, 'questions');
    } else if (dataSize > WARNING_SIZE) {
      // Just log warning, don't interrupt
      console.warn('[Learning] ⚠️ Storage usage high:', Math.round(dataSize / 1024 / 1024 * 100) / 100, 'MB');
    }

    const requestId = `storage_${Date.now()}_${storageRequestCounter++}`;
    console.log('[Learning] 📤 Sending storageSet request:', requestId, 'questions count:', questions.length);

    let retryCount = 0;
    const maxRetries = 3;
    const baseDelay = 1000;

    const attemptSave = () => {
      const responseHandler = (event) => {
        if (event.detail.requestId === requestId) {
          console.log('[Learning] 📥 Received storageSet response:', requestId, 'success:', event.detail.success);
          clearTimeout(timeoutId);
          document.removeEventListener('learning:storageSetResponse', responseHandler);

          if (event.detail.success) {
            // Update cache with saved data
            questionsCache = questions;
            questionsCacheMap = buildQuestionsMap(questions);
            cacheTimestamp = Date.now();
            resolveMain();
          } else {
            rejectMain(new Error('Storage set failed'));
          }
        }
      };

      document.addEventListener('learning:storageSetResponse', responseHandler);

      const timeoutId = setTimeout(() => {
        document.removeEventListener('learning:storageSetResponse', responseHandler);

        if (retryCount < maxRetries) {
          retryCount++;
          const delay = baseDelay * Math.pow(2, retryCount - 1);
          console.warn(`[Learning] ⏳ Storage set timeout, retry ${retryCount}/${maxRetries} in ${delay}ms`);
          setTimeout(attemptSave, delay);
        } else {
          console.error('[Learning] ❌ Storage set failed after', maxRetries, 'retries');
          rejectMain(new Error('Storage set timeout after retries'));
        }
      }, 5000);

      document.dispatchEvent(new CustomEvent('learning:storageSet', {
        detail: { key: 'learnedQuestions', value: questions, requestId }
      }));
    };

    attemptSave();
    console.log('[Learning] ✅ StorageSet event dispatched:', requestId);
  });
}

/**
 * Find existing question by hash (O(1) lookup using Map)
 */
async function findExistingQuestion(questionHash) {
  // First check if we have a cached Map
  if (questionsCacheMap && Date.now() - cacheTimestamp < CACHE_TTL) {
    return questionsCacheMap.get(questionHash) || null;
  }

  // Otherwise load questions (which will build the Map)
  await getLearnedQuestions();
  return questionsCacheMap ? questionsCacheMap.get(questionHash) || null : null;
}

/**
 * Find similar question using fuzzy matching + synonyms
 * @param {string} normalizedQuestion - normalized question text
 * @param {string} currentDomain - optional domain for context-aware matching
 */
async function findSimilarQuestion(normalizedQuestion, currentDomain = null) {
  const questions = await getLearnedQuestions();

  const queryWords = new Set(normalizedQuestion.split(' ').filter(w => w.length > 2));
  if (queryWords.size === 0) return null;

  // Check if query matches a synonym group
  const querySynonymGroup = findSynonymGroup(normalizedQuestion);

  let bestMatch = null;
  let bestScore = 0;

  questions.forEach(q => {
    const questionWords = new Set(normalizeQuestion(q.question_text).split(' ').filter(w => w.length > 2));
    if (questionWords.size === 0) return;

    // Standard Jaccard similarity
    const intersection = new Set([...queryWords].filter(x => questionWords.has(x)));
    const union = new Set([...queryWords, ...questionWords]);
    let similarity = intersection.size / union.size;

    // Boost similarity if both match the same synonym group
    const questionSynonymGroup = findSynonymGroup(normalizeQuestion(q.question_text));
    if (querySynonymGroup && questionSynonymGroup && querySynonymGroup === questionSynonymGroup) {
      similarity = Math.max(similarity, 0.8); // High similarity for synonym matches
    }

    // Check variations too
    let maxVariationSimilarity = 0;
    if (q.variations && q.variations.length > 0) {
      q.variations.forEach(variation => {
        const varWords = new Set(variation.split(' ').filter(w => w.length > 2));
        const varIntersection = new Set([...queryWords].filter(x => varWords.has(x)));
        const varUnion = new Set([...queryWords, ...varWords]);
        const varSimilarity = varIntersection.size / varUnion.size;
        maxVariationSimilarity = Math.max(maxVariationSimilarity, varSimilarity);
      });
    }

    let finalSimilarity = Math.max(similarity, maxVariationSimilarity);

    // Domain bonus: prefer matches from same domain
    if (currentDomain && q.context && q.context.domain === currentDomain) {
      finalSimilarity *= 1.1; // 10% bonus for same domain
    }

    if (finalSimilarity > 0.5 && finalSimilarity > bestScore) {
      bestScore = finalSimilarity;
      bestMatch = q;
    }
  });

  return bestMatch;
}

/**
 * Get current domain from URL
 */
function getCurrentDomain() {
  try {
    return new URL(window.location.href).hostname;
  } catch {
    return null;
  }
}

/**
 * Calculate Wilson score for confidence (Bayesian approach)
 * Returns lower bound of Wilson score interval at 95% confidence
 */
function calculateWilsonScore(positive, negative) {
  const n = positive + negative;
  if (n === 0) return 0.5; // Default confidence for no feedback

  const p = positive / n;
  const z = 1.96; // 95% confidence level

  // Wilson score interval lower bound
  const denominator = 1 + z * z / n;
  const center = p + z * z / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n);

  return (center - spread) / denominator;
}

/**
 * Calculate overall confidence combining Wilson score with other factors
 */
function calculateOverallConfidence(question) {
  const wilsonScore = calculateWilsonScore(
    question.feedback_positive || 0,
    question.feedback_negative || 0
  );

  // Frequency factor: more uses = more confidence (capped)
  const frequencyFactor = Math.min(1, (question.frequency || 1) / 10);

  // Recency factor: recent use = more relevant
  const daysSinceUsed = question.last_used
    ? (Date.now() - new Date(question.last_used).getTime()) / (1000 * 60 * 60 * 24)
    : 30;
  const recencyFactor = Math.max(0.5, 1 - daysSinceUsed / 60); // Decay over 60 days

  // Combine factors (Wilson score is primary, others are modifiers)
  const totalFeedback = (question.feedback_positive || 0) + (question.feedback_negative || 0);

  if (totalFeedback >= 3) {
    // Enough feedback - Wilson score is reliable
    return wilsonScore * 0.7 + frequencyFactor * 0.2 + recencyFactor * 0.1;
  } else {
    // Not enough feedback - rely more on frequency and recency
    return wilsonScore * 0.3 + frequencyFactor * 0.4 + recencyFactor * 0.3;
  }
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
          form_url: window.location.href,
          domain: getCurrentDomain() // Add domain for context-aware matching
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

      // Update domain if not set
      if (!questions[index].context.domain) {
        questions[index].context.domain = getCurrentDomain();
      }

      // If answer changed, count as implicit negative feedback
      if (questions[index].user_answer !== newAnswer) {
        questions[index].user_answer = newAnswer;
        questions[index].feedback_negative = (questions[index].feedback_negative || 0) + 1;
        console.log('[Learning] Answer updated for:', questions[index].question_text);
      } else {
        // Same answer = implicit positive feedback
        questions[index].feedback_positive = (questions[index].feedback_positive || 0) + 1;
      }

      // Recalculate confidence using Wilson score
      questions[index].confidence = calculateOverallConfidence(questions[index]);

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
    const currentDomain = getCurrentDomain();

    // Try exact match first
    const existingQuestion = await findExistingQuestion(questionHash);
    if (existingQuestion) {
      // Recalculate confidence using Wilson score
      const confidence = calculateOverallConfidence(existingQuestion);
      if (confidence > 0.5) { // Lowered threshold since Wilson is more conservative
        return {
          answer: existingQuestion.user_answer,
          confidence: confidence,
          source: 'learned',
          questionHash: existingQuestion.question_hash
        };
      }
    }

    // Try fuzzy matching with synonyms and domain context
    const similarQuestion = await findSimilarQuestion(normalizedQuestion, currentDomain);
    if (similarQuestion) {
      const confidence = calculateOverallConfidence(similarQuestion);
      if (confidence > 0.4) { // Lower threshold for fuzzy matches
        return {
          answer: similarQuestion.user_answer,
          confidence: confidence * 0.85, // Slight penalty for fuzzy match
          source: 'similar',
          questionHash: similarQuestion.question_hash
        };
      }
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
        questions[index].feedback_positive = (questions[index].feedback_positive || 0) + 1;
        console.log('[Learning] Positive feedback for:', questions[index].question_text);
      } else {
        questions[index].feedback_negative = (questions[index].feedback_negative || 0) + 1;
        console.log('[Learning] Negative feedback for:', questions[index].question_text);
      }

      // Recalculate confidence using Wilson score
      questions[index].confidence = calculateOverallConfidence(questions[index]);

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
      <div class="feedback-badge" title="Wypełniono przez AI - najedź aby ocenić">✓</div>
      <div class="feedback-tooltip">
        <div class="feedback-tooltip-content">
          <span class="feedback-label">Poprawna odpowiedź?</span>
          <div class="feedback-buttons">
            <button type="button" class="feedback-btn feedback-yes" data-hash="${questionHash}" data-feedback="positive" title="Tak, poprawna">
              👍
            </button>
            <button type="button" class="feedback-btn feedback-no" data-hash="${questionHash}" data-feedback="negative" title="Nie, niepoprawna">
              👎
            </button>
            <button type="button" class="feedback-btn feedback-edit" data-hash="${questionHash}" title="Edytuj odpowiedź">
              ✏️
            </button>
          </div>
        </div>
      </div>
    `;

    // Style feedback container with badge + tooltip
    feedbackContainer.style.cssText = `
      position: absolute;
      top: 50%;
      right: -35px;
      transform: translateY(-50%);
      z-index: 10000;
    `;

    // Style the badge (always visible)
    const badge = feedbackContainer.querySelector('.feedback-badge');
    badge.style.cssText = `
      width: 24px;
      height: 24px;
      background: #4CAF50;
      color: white;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      font-weight: bold;
      cursor: pointer;
      box-shadow: 0 2px 4px rgba(0,0,0,0.2);
      transition: all 0.2s ease;
    `;

    // Style the tooltip (hidden by default, shown on hover)
    const tooltip = feedbackContainer.querySelector('.feedback-tooltip');
    tooltip.style.cssText = `
      position: absolute;
      left: 100%;
      top: 50%;
      transform: translateY(-50%);
      margin-left: 8px;
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.2s ease, visibility 0.2s ease;
      pointer-events: none;
    `;

    const tooltipContent = feedbackContainer.querySelector('.feedback-tooltip-content');
    tooltipContent.style.cssText = `
      background: white;
      border: 1px solid #ddd;
      border-radius: 6px;
      padding: 8px 12px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      white-space: nowrap;
      display: flex;
      flex-direction: column;
      gap: 6px;
    `;

    const label = feedbackContainer.querySelector('.feedback-label');
    label.style.cssText = `
      font-size: 12px;
      color: #666;
      margin-bottom: 2px;
    `;

    const buttonsContainer = feedbackContainer.querySelector('.feedback-buttons');
    buttonsContainer.style.cssText = `
      display: flex;
      gap: 6px;
    `;

    // Style individual buttons
    feedbackContainer.querySelectorAll('.feedback-btn').forEach(btn => {
      btn.style.cssText = `
        padding: 6px 10px;
        border: 1px solid #ddd;
        background: white;
        border-radius: 4px;
        cursor: pointer;
        font-size: 16px;
        transition: all 0.2s ease;
      `;
    });

    // Show tooltip on badge hover
    badge.addEventListener('mouseenter', () => {
      tooltip.style.opacity = '1';
      tooltip.style.visibility = 'visible';
      tooltip.style.pointerEvents = 'auto';
      badge.style.transform = 'scale(1.1)';
    });

    // Keep tooltip visible when hovering over it
    tooltip.addEventListener('mouseenter', () => {
      tooltip.style.opacity = '1';
      tooltip.style.visibility = 'visible';
      tooltip.style.pointerEvents = 'auto';
    });

    // Hide tooltip when mouse leaves both badge and tooltip
    const hideTooltip = () => {
      setTimeout(() => {
        if (!feedbackContainer.matches(':hover')) {
          tooltip.style.opacity = '0';
          tooltip.style.visibility = 'hidden';
          tooltip.style.pointerEvents = 'none';
          badge.style.transform = 'scale(1)';
        }
      }, 100);
    };

    badge.addEventListener('mouseleave', hideTooltip);
    tooltip.addEventListener('mouseleave', hideTooltip);

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

        // Update badge to show feedback result
        const badgeElement = feedbackContainer.querySelector('.feedback-badge');
        const label = feedbackContainer.querySelector('.feedback-label');
        const yesBtn = feedbackContainer.querySelector('.feedback-yes');
        const noBtn = feedbackContainer.querySelector('.feedback-no');
        const editBtn = feedbackContainer.querySelector('.feedback-edit');

        if (feedback === 'positive') {
          badgeElement.textContent = '👍';
          badgeElement.style.background = '#4CAF50'; // Green
          badgeElement.title = 'Oznaczono jako poprawne';
        } else {
          badgeElement.textContent = '👎';
          badgeElement.style.background = '#f44336'; // Red
          badgeElement.title = 'Oznaczono jako niepoprawne';
        }

        // Update label confirmation
        label.textContent = '✓ Dziękujemy!';
        label.style.color = 'green';

        // Disable buttons
        yesBtn.disabled = true;
        noBtn.disabled = true;
        editBtn.disabled = true;
        yesBtn.style.opacity = '0.5';
        noBtn.style.opacity = '0.5';
        editBtn.style.opacity = '0.5';

        // Hide tooltip after 2 seconds
        setTimeout(() => {
          tooltip.style.opacity = '0';
          tooltip.style.visibility = 'hidden';
          tooltip.style.pointerEvents = 'none';
        }, 2000);
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
          form_url: window.location.href,
          domain: getCurrentDomain() // Add domain for context-aware matching
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
    const currentDomain = getCurrentDomain();

    // Try exact match first
    const existingQuestion = await findExistingQuestion(questionHash);
    if (existingQuestion) {
      const confidence = calculateOverallConfidence(existingQuestion);
      if (confidence > 0.5) { // Lowered threshold since Wilson is more conservative
        document.dispatchEvent(new CustomEvent('learning:getSuggestionResponse', {
          detail: {
            suggestion: {
              answer: existingQuestion.user_answer,
              confidence: confidence,
              source: 'learned',
              questionHash: existingQuestion.question_hash
            },
            requestId
          }
        }));
        return;
      }
    }

    // Try fuzzy matching with synonyms and domain context
    const similarQuestion = await findSimilarQuestion(normalizedQuestion, currentDomain);
    if (similarQuestion) {
      const confidence = calculateOverallConfidence(similarQuestion);
      if (confidence > 0.4) { // Lower threshold for fuzzy matches
        document.dispatchEvent(new CustomEvent('learning:getSuggestionResponse', {
          detail: {
            suggestion: {
              answer: similarQuestion.user_answer,
              confidence: confidence * 0.85, // Slight penalty for fuzzy match
              source: 'similar',
              questionHash: similarQuestion.question_hash
            },
            requestId
          }
        }));
        return;
      }
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
