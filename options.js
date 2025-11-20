// options.js

const dataContainer = document.getElementById('data-container');
const addRowBtn = document.getElementById('add-row');
const saveBtn = document.getElementById('save');
const statusEl = document.getElementById('status');
const cvUpload = document.getElementById('cv-upload');
const cvStatusEl = document.getElementById('cv-status');
const apiKeyInput = document.getElementById('api-key');
const apiKeyStatusEl = document.getElementById('api-key-status');
const toggleApiKeyBtn = document.getElementById('toggle-api-key');

// --- Data Management ---

function createDataRow(key = '', value = '') {
  const row = document.createElement('div');
  row.className = 'data-row';
  row.innerHTML = `
    <input type="text" class="data-key" placeholder="Klucz (np. firstName)" value="${key}">
    <input type="text" class="data-value" placeholder="Wartość (np. Jan)" value="${value}">
    <button class="remove-row">Usuń</button>
  `;
  dataContainer.appendChild(row);

  row.querySelector('.remove-row').addEventListener('click', () => {
    row.remove();
  });
}

function loadData() {
  chrome.storage.sync.get('userData', (result) => {
    // Check for storage errors
    if (chrome.runtime.lastError) {
      console.error('Error loading data:', chrome.runtime.lastError);
      statusEl.textContent = 'Błąd ładowania danych: ' + chrome.runtime.lastError.message;
      statusEl.style.color = 'red';
      // Show default fields
      dataContainer.innerHTML = '';
      createDataRow('firstName', 'Jan');
      createDataRow('lastName', 'Kowalski');
      createDataRow('email', 'jan.kowalski@example.com');
      return;
    }

    if (result.userData && Object.keys(result.userData).length > 0) {
      // Data already exists in storage, just load it
      const data = result.userData;
      dataContainer.innerHTML = '';
      for (const key in data) {
        createDataRow(key, data[key]);
      }
    } else {
      // No data in storage, try to migrate from data.json
      fetch(chrome.runtime.getURL('data.json'))
        .then(response => {
          if (!response.ok) {
            throw new Error('data.json not found');
          }
          return response.json();
        })
        .then(data => {
          // Validate data structure
          if (typeof data !== 'object' || data === null) {
            throw new Error('Invalid data format');
          }

          // Save migrated data to storage
          chrome.storage.sync.set({ userData: data }, () => {
            if (chrome.runtime.lastError) {
              console.error('Error migrating data:', chrome.runtime.lastError);
              statusEl.textContent = 'Błąd migracji danych: ' + chrome.runtime.lastError.message;
              statusEl.style.color = 'red';
              return;
            }

            console.log('Data migrated from data.json to chrome.storage.sync');
            // Now load the migrated data
            dataContainer.innerHTML = '';
            for (const key in data) {
              createDataRow(key, data[key]);
            }
          });
        })
        .catch(error => {
          // If migration fails, just show default fields
          console.log('Could not migrate from data.json, showing default fields.', error);
          dataContainer.innerHTML = '';
          createDataRow('firstName', 'Jan');
          createDataRow('lastName', 'Kowalski');
          createDataRow('email', 'jan.kowalski@example.com');
        });
    }
  });
}

function validateEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function validatePhone(phone) {
  // Basic phone validation - allows various formats
  const phoneRegex = /^[\d\s\-\+\(\)]+$/;
  return phone.length >= 9 && phoneRegex.test(phone);
}

function saveData() {
  const dataRows = document.querySelectorAll('.data-row');
  const newData = {};
  const seenKeys = new Set();
  let hasError = false;
  let errorMessage = '';

  dataRows.forEach(row => {
    const keyInput = row.querySelector('.data-key');
    const valueInput = row.querySelector('.data-value');
    const key = keyInput.value.trim();
    const value = valueInput.value.trim();

    if (!key) {
      hasError = true;
      errorMessage = 'Błąd: Klucz nie może być pusty.';
      keyInput.style.borderColor = 'red';
      return;
    }

    // Check for duplicate keys
    if (seenKeys.has(key)) {
      hasError = true;
      errorMessage = `Błąd: Duplikat klucza "${key}".`;
      keyInput.style.borderColor = 'red';
      return;
    }

    seenKeys.add(key);

    // Validate specific fields
    if ((key === 'email' || key.toLowerCase().includes('email')) && value) {
      if (!validateEmail(value)) {
        hasError = true;
        errorMessage = `Błąd: Nieprawidłowy format email dla "${value}".`;
        valueInput.style.borderColor = 'red';
        return;
      }
    }

    if ((key === 'phone' || key.toLowerCase().includes('phone') || key.toLowerCase().includes('telefon')) && value) {
      if (!validatePhone(value)) {
        hasError = true;
        errorMessage = `Błąd: Nieprawidłowy format telefonu dla "${value}".`;
        valueInput.style.borderColor = 'red';
        return;
      }
    }

    // Reset border color on valid input
    keyInput.style.borderColor = '';
    valueInput.style.borderColor = '';

    newData[key] = value;
  });

  if (hasError) {
    statusEl.textContent = errorMessage;
    statusEl.style.color = 'red';
    setTimeout(() => {
      statusEl.textContent = '';
      statusEl.style.color = '';
    }, 3000);
    return;
  }

  // Check storage quota
  const dataSize = JSON.stringify(newData).length;
  const STORAGE_LIMIT = chrome.storage.sync.QUOTA_BYTES || 102400; // 100KB default

  if (dataSize > STORAGE_LIMIT * 0.9) {
    statusEl.textContent = 'Ostrzeżenie: Zbliżasz się do limitu pamięci!';
    statusEl.style.color = 'orange';
  }

  chrome.storage.sync.set({ userData: newData }, () => {
    // Check for storage errors
    if (chrome.runtime.lastError) {
      console.error('Error saving data:', chrome.runtime.lastError);
      statusEl.textContent = 'Błąd zapisu: ' + chrome.runtime.lastError.message;
      statusEl.style.color = 'red';
      setTimeout(() => {
        statusEl.textContent = '';
        statusEl.style.color = '';
      }, 3000);
      return;
    }

    statusEl.textContent = 'Zmiany zapisane!';
    statusEl.style.color = 'green';
    setTimeout(() => {
      statusEl.textContent = '';
      statusEl.style.color = '';
    }, 2000);
  });
}

// --- CV Management ---

function loadCvStatus() {
    chrome.storage.local.get('userCV', (result) => {
        // Check for storage errors
        if (chrome.runtime.lastError) {
            console.error('Error loading CV status:', chrome.runtime.lastError);
            cvStatusEl.textContent = 'Błąd ładowania CV: ' + chrome.runtime.lastError.message;
            cvStatusEl.style.color = 'red';
            return;
        }

        if (result.userCV && result.userCV.name) {
            cvStatusEl.textContent = `Załączono plik: ${result.userCV.name}`;
            cvStatusEl.style.color = 'green';
        } else {
            cvStatusEl.textContent = 'Nie załączono pliku CV.';
            cvStatusEl.style.color = '';
        }
    });
}

function handleCvUpload(event) {
    const file = event.target.files[0];
    if (!file) {
        return;
    }

    // Validate file type
    const allowedTypes = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    if (!allowedTypes.includes(file.type)) {
        cvStatusEl.textContent = 'Błąd: Dozwolone formaty to PDF, DOC, DOCX';
        cvStatusEl.style.color = 'red';
        setTimeout(() => {
            cvStatusEl.textContent = '';
            cvStatusEl.style.color = '';
        }, 3000);
        event.target.value = ''; // Reset file input
        return;
    }

    // Validate file size (max 5MB)
    const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB in bytes
    if (file.size > MAX_FILE_SIZE) {
        cvStatusEl.textContent = `Błąd: Plik jest za duży (${(file.size / 1024 / 1024).toFixed(2)}MB). Maksymalny rozmiar to 5MB.`;
        cvStatusEl.style.color = 'red';
        setTimeout(() => {
            cvStatusEl.textContent = '';
            cvStatusEl.style.color = '';
        }, 3000);
        event.target.value = ''; // Reset file input
        return;
    }

    cvStatusEl.textContent = 'Wczytywanie pliku...';
    cvStatusEl.style.color = 'blue';

    const reader = new FileReader();

    reader.onload = (e) => {
        const cvData = {
            name: file.name,
            type: file.type,
            dataUrl: e.target.result
        };

        // Check if data URL is valid
        if (!cvData.dataUrl || typeof cvData.dataUrl !== 'string') {
            cvStatusEl.textContent = 'Błąd: Nieprawidłowy format pliku';
            cvStatusEl.style.color = 'red';
            setTimeout(() => {
                cvStatusEl.textContent = '';
                cvStatusEl.style.color = '';
            }, 3000);
            return;
        }

        chrome.storage.local.set({ userCV: cvData }, () => {
            // Check for storage errors
            if (chrome.runtime.lastError) {
                console.error('Error saving CV:', chrome.runtime.lastError);
                cvStatusEl.textContent = 'Błąd zapisu CV: ' + chrome.runtime.lastError.message;
                cvStatusEl.style.color = 'red';
                setTimeout(() => {
                    cvStatusEl.textContent = '';
                    cvStatusEl.style.color = '';
                }, 3000);
                return;
            }

            loadCvStatus();
            statusEl.textContent = 'CV zapisane!';
            statusEl.style.color = 'green';
            setTimeout(() => {
                statusEl.textContent = '';
                statusEl.style.color = '';
            }, 2000);
        });
    };

    reader.onerror = (error) => {
        console.error('Error reading file:', error);
        cvStatusEl.textContent = 'Błąd odczytu pliku: ' + (error.message || 'Nieznany błąd');
        cvStatusEl.style.color = 'red';
        setTimeout(() => {
            cvStatusEl.textContent = '';
            cvStatusEl.style.color = '';
        }, 3000);
        event.target.value = ''; // Reset file input
    };

    reader.onabort = () => {
        console.warn('File reading aborted');
        cvStatusEl.textContent = 'Odczyt pliku przerwany';
        cvStatusEl.style.color = 'orange';
        setTimeout(() => {
            cvStatusEl.textContent = '';
            cvStatusEl.style.color = '';
        }, 3000);
    };

    reader.readAsDataURL(file);
}

// --- CV Analysis Functions ---

function loadCvSettings() {
    chrome.storage.local.get(['useCvData', 'cvAnalyzedData'], (result) => {
        if (chrome.runtime.lastError) {
            console.error('Error loading CV settings:', chrome.runtime.lastError);
            return;
        }

        // Load toggle state (default: false)
        const useCvData = result.useCvData || false;
        document.getElementById('use-cv-data').checked = useCvData;

        // Update UI based on analyzed data availability
        if (result.cvAnalyzedData) {
            document.getElementById('view-cv-data').disabled = false;
            showCvAnalysisStatus(result.cvAnalyzedData);
        }
    });
}

function handleUseCvDataToggle(event) {
    const useCvData = event.target.checked;
    chrome.storage.local.set({ useCvData }, () => {
        if (chrome.runtime.lastError) {
            console.error('Error saving CV setting:', chrome.runtime.lastError);
            statusEl.textContent = 'Błąd zapisu ustawień';
            statusEl.style.color = 'red';
            return;
        }

        statusEl.textContent = useCvData ?
            'Wypełnianie z CV włączone' :
            'Wypełnianie z CV wyłączone';
        statusEl.style.color = 'green';
        setTimeout(() => {
            statusEl.textContent = '';
            statusEl.style.color = '';
        }, 2000);
    });
}

async function analyzeCVData() {
    const analyzeBtn = document.getElementById('analyze-cv');
    const statusDiv = document.getElementById('cv-analysis-status');
    const infoDiv = document.getElementById('cv-analysis-info');

    // Check if CV file exists
    chrome.storage.local.get('userCV', async (result) => {
        if (!result.userCV || !result.userCV.dataUrl) {
            infoDiv.textContent = '❌ Najpierw załącz plik CV powyżej';
            infoDiv.style.color = 'red';
            statusDiv.style.display = 'block';
            setTimeout(() => {
                statusDiv.style.display = 'none';
            }, 3000);
            return;
        }

        // Check if API key exists
        const apiKeyResult = await new Promise(resolve => {
            chrome.storage.sync.get('geminiApiKey', resolve);
        });

        if (!apiKeyResult.geminiApiKey || apiKeyResult.geminiApiKey === 'YOUR_API_KEY_HERE') {
            infoDiv.textContent = '❌ Najpierw skonfiguruj klucz API Gemini';
            infoDiv.style.color = 'red';
            statusDiv.style.display = 'block';
            setTimeout(() => {
                statusDiv.style.display = 'none';
            }, 3000);
            return;
        }

        // Start analysis
        analyzeBtn.disabled = true;
        analyzeBtn.textContent = '⏳ Analizowanie...';
        statusDiv.style.display = 'block';
        infoDiv.innerHTML = '<div style="color: blue;">🔍 Analizuję CV za pomocą AI...</div>';

        try {
            // Call CV analysis function directly
            const analyzedData = await analyzeCVWithAI(result.userCV);

            if (analyzedData) {
                showCvAnalysisStatus(analyzedData);
                document.getElementById('view-cv-data').disabled = false;
                infoDiv.innerHTML = `
                    <div style="color: green;">✅ Analiza zakończona!</div>
                    <div style="font-size: 0.9em; margin-top: 5px;">
                        Znaleziono: ${analyzedData.experience?.length || 0} doświadczeń,
                        ${analyzedData.skills?.length || 0} umiejętności,
                        ${analyzedData.education?.length || 0} wykształceń
                    </div>
                `;
            } else {
                throw new Error('Nie udało się przeanalizować CV');
            }
        } catch (error) {
            console.error('CV analysis error:', error);
            infoDiv.innerHTML = `<div style="color: red;">❌ Błąd analizy: ${error.message}</div>`;
        } finally {
            analyzeBtn.disabled = false;
            analyzeBtn.textContent = '🔍 Analizuj CV';
        }
    });
}

function showCvAnalysisStatus(cvData) {
    const statusDiv = document.getElementById('cv-analysis-status');
    const infoDiv = document.getElementById('cv-analysis-info');

    const analyzedAt = cvData.analyzedAt ? new Date(cvData.analyzedAt).toLocaleString('pl-PL') : 'Nieznana';

    infoDiv.innerHTML = `
        <div style="color: green; margin-bottom: 8px;">✅ CV przeanalizowane</div>
        <div style="font-size: 0.85em; color: #666;">
            <strong>Ostatnia analiza:</strong> ${analyzedAt}<br>
            <strong>Doświadczeń:</strong> ${cvData.experience?.length || 0}<br>
            <strong>Umiejętności:</strong> ${cvData.skills?.length || 0}<br>
            <strong>Wykształceń:</strong> ${cvData.education?.length || 0}<br>
            <strong>Języków:</strong> ${cvData.languages?.length || 0}
        </div>
    `;
    statusDiv.style.display = 'block';
}

function viewCVData() {
    chrome.storage.local.get('cvAnalyzedData', (result) => {
        if (!result.cvAnalyzedData) {
            alert('Brak danych z CV. Najpierw przeanalizuj CV.');
            return;
        }

        // Create modal with CV data
        const modal = document.createElement('div');
        modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0,0,0,0.5);
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        `;

        const content = document.createElement('div');
        content.style.cssText = `
            background: white;
            padding: 30px;
            border-radius: 8px;
            max-width: 800px;
            max-height: 80vh;
            overflow-y: auto;
            box-shadow: 0 4px 20px rgba(0,0,0,0.3);
        `;

        content.innerHTML = `
            <h2 style="margin-top: 0;">Dane z CV</h2>
            <pre style="background: #f5f5f5; padding: 15px; border-radius: 4px; overflow-x: auto; font-size: 0.9em;">${JSON.stringify(result.cvAnalyzedData, null, 2)}</pre>
            <button id="close-modal" style="margin-top: 15px; padding: 10px 20px;">Zamknij</button>
        `;

        modal.appendChild(content);
        document.body.appendChild(modal);

        document.getElementById('close-modal').addEventListener('click', () => {
            modal.remove();
        });

        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });
    });
}


// --- API Key Management ---

function loadApiKey() {
    chrome.storage.sync.get('geminiApiKey', (result) => {
        if (chrome.runtime.lastError) {
            console.error('Error loading API key:', chrome.runtime.lastError);
            apiKeyStatusEl.textContent = 'Błąd ładowania klucza API';
            apiKeyStatusEl.style.color = 'red';
            return;
        }

        if (result.geminiApiKey && result.geminiApiKey !== 'YOUR_API_KEY_HERE') {
            apiKeyInput.value = result.geminiApiKey;
            apiKeyStatusEl.textContent = '✓ Klucz API zapisany';
            apiKeyStatusEl.style.color = 'green';
        } else {
            apiKeyStatusEl.textContent = 'Brak klucza API - rozszerzenie będzie działać w trybie podstawowym';
            apiKeyStatusEl.style.color = 'orange';
        }
    });
}

function saveApiKey() {
    const apiKey = apiKeyInput.value.trim();

    if (!apiKey) {
        apiKeyStatusEl.textContent = 'Ostrzeżenie: Brak klucza API - rozszerzenie będzie działać w trybie podstawowym';
        apiKeyStatusEl.style.color = 'orange';
        // Still save empty key to clear it
        chrome.storage.sync.set({ geminiApiKey: '' }, () => {
            if (chrome.runtime.lastError) {
                console.error('Error saving API key:', chrome.runtime.lastError);
            }
        });
        return;
    }

    // Basic validation - Google API keys typically start with "AIza"
    if (!apiKey.startsWith('AIza')) {
        apiKeyStatusEl.textContent = 'Ostrzeżenie: Klucz API wydaje się nieprawidłowy (powinien zaczynać się od "AIza")';
        apiKeyStatusEl.style.color = 'orange';
    }

    chrome.storage.sync.set({ geminiApiKey: apiKey }, () => {
        if (chrome.runtime.lastError) {
            console.error('Error saving API key:', chrome.runtime.lastError);
            apiKeyStatusEl.textContent = 'Błąd zapisu klucza API: ' + chrome.runtime.lastError.message;
            apiKeyStatusEl.style.color = 'red';
            return;
        }

        apiKeyStatusEl.textContent = '✓ Klucz API zapisany';
        apiKeyStatusEl.style.color = 'green';
    });
}

function toggleApiKeyVisibility() {
    if (apiKeyInput.type === 'password') {
        apiKeyInput.type = 'text';
        toggleApiKeyBtn.textContent = '🙈 Ukryj';
    } else {
        apiKeyInput.type = 'password';
        toggleApiKeyBtn.textContent = '👁️ Pokaż';
    }
}

// --- Learned Questions Management ---

// Direct storage access (options.html is extension page, not page context)
async function getLearnedQuestions() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['learnedQuestions'], (result) => {
      resolve(result.learnedQuestions || []);
    });
  });
}

async function saveLearnedQuestions(questions) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ learnedQuestions: questions }, resolve);
  });
}

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

async function importLearnedQuestions(jsonData) {
  try {
    const importedQuestions = JSON.parse(jsonData);
    if (!Array.isArray(importedQuestions)) {
      return { success: false, error: 'Invalid format' };
    }

    const existingQuestions = await getLearnedQuestions();
    const existingHashes = new Set(existingQuestions.map(q => q.question_hash));

    let imported = 0;
    for (const q of importedQuestions) {
      if (!existingHashes.has(q.question_hash)) {
        existingQuestions.push(q);
        imported++;
      }
    }

    await saveLearnedQuestions(existingQuestions);
    return { success: true, imported };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function clearAllLearnedQuestions() {
  await saveLearnedQuestions([]);
}

async function displayLearnedQuestions(searchTerm = '') {
  const questionsContainer = document.getElementById('questions-list');
  const questions = await getLearnedQuestions();

  // Filter by search term
  let filtered = questions;
  if (searchTerm) {
    const lowerSearch = searchTerm.toLowerCase();
    filtered = questions.filter(q =>
      q.question_text.toLowerCase().includes(lowerSearch) ||
      q.user_answer.toLowerCase().includes(lowerSearch)
    );
  }

  // Sort by frequency (most used first)
  filtered.sort((a, b) => b.frequency - a.frequency);

  // Update stats
  document.getElementById('total-questions').textContent = questions.length;
  const avgConfidence = questions.length > 0
    ? (questions.reduce((sum, q) => sum + q.confidence, 0) / questions.length * 100).toFixed(0)
    : 0;
  document.getElementById('avg-confidence').textContent = avgConfidence + '%';

  if (filtered.length === 0) {
    questionsContainer.innerHTML = '<p style="color: #999;">Brak wyuczonych pytań. Wypełnij formularz aby rozszerzenie zaczęło się uczyć.</p>';
    return;
  }

  questionsContainer.innerHTML = filtered.map(q => `
    <div class="question-card" data-hash="${q.question_hash}">
      <div class="question-header">
        <span class="question-text">${escapeHtml(q.question_text)}</span>
        <span class="confidence-badge" style="background: ${getConfidenceColor(q.confidence)}">
          ${Math.round(q.confidence * 100)}%
        </span>
      </div>
      <div class="question-details">
        <div><strong>Odpowiedź:</strong> <code>${escapeHtml(q.user_answer)}</code></div>
        <div><strong>Użyto:</strong> ${q.frequency} ${q.frequency === 1 ? 'raz' : 'razy'}</div>
        <div><strong>Ostatnio:</strong> ${formatDate(q.last_used)}</div>
        <div><strong>Feedback:</strong> 👍 ${q.feedback_positive} / 👎 ${q.feedback_negative}</div>
        <div><strong>Typ pola:</strong> ${q.field_type}</div>
      </div>
      <div class="question-actions">
        <button class="edit-btn" data-hash="${q.question_hash}">✏️ Edytuj</button>
        <button class="delete-btn" data-hash="${q.question_hash}">🗑️ Usuń</button>
      </div>
    </div>
  `).join('');

  // Add event listeners after rendering
  questionsContainer.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', () => editQuestion(btn.dataset.hash));
  });
  questionsContainer.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteQuestion(btn.dataset.hash));
  });
}

function getConfidenceColor(confidence) {
  if (confidence > 0.8) return '#4CAF50';
  if (confidence > 0.5) return '#FFC107';
  return '#F44336';
}

function formatDate(isoString) {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'przed chwilą';
  if (diffMins < 60) return `${diffMins} min temu`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours} godz. temu`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays} dni temu`;

  return date.toLocaleDateString('pl-PL');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function editQuestion(questionHash) {
  const questions = await getLearnedQuestions();
  const question = questions.find(q => q.question_hash === questionHash);

  if (!question) return;

  const newAnswer = prompt(`Edytuj odpowiedź dla: "${question.question_text}"`, question.user_answer);

  if (newAnswer !== null && newAnswer !== question.user_answer) {
    question.user_answer = newAnswer;
    await saveLearnedQuestions(questions);
    await displayLearnedQuestions();
    statusEl.textContent = 'Odpowiedź zaktualizowana!';
    statusEl.style.color = 'green';
    setTimeout(() => { statusEl.textContent = ''; statusEl.style.color = ''; }, 2000);
  }
}

async function deleteQuestion(questionHash) {
  if (!confirm('Czy na pewno chcesz usunąć to pytanie?')) return;

  const questions = await getLearnedQuestions();
  const filtered = questions.filter(q => q.question_hash !== questionHash);
  await saveLearnedQuestions(filtered);
  await displayLearnedQuestions();

  statusEl.textContent = 'Pytanie usunięte!';
  statusEl.style.color = 'green';
  setTimeout(() => { statusEl.textContent = ''; statusEl.style.color = ''; }, 2000);
}

async function handleExport() {
  await exportLearnedQuestions();
  statusEl.textContent = 'Pytania wyeksportowane!';
  statusEl.style.color = 'green';
  setTimeout(() => { statusEl.textContent = ''; statusEl.style.color = ''; }, 2000);
}

async function handleImport(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const result = await importLearnedQuestions(e.target.result);
      if (result.success) {
        await displayLearnedQuestions();
        statusEl.textContent = `Zaimportowano ${result.imported} nowych pytań!`;
        statusEl.style.color = 'green';
      } else {
        statusEl.textContent = `Błąd importu: ${result.error}`;
        statusEl.style.color = 'red';
      }
    } catch (error) {
      statusEl.textContent = 'Błąd odczytu pliku!';
      statusEl.style.color = 'red';
    }
    setTimeout(() => { statusEl.textContent = ''; statusEl.style.color = ''; }, 3000);
  };
  reader.readAsText(file);
  event.target.value = ''; // Reset file input
}

async function handleClear() {
  if (!confirm('Czy na pewno chcesz usunąć WSZYSTKIE wyuczone pytania? Tej operacji nie można cofnąć!')) return;

  await clearAllLearnedQuestions();
  await displayLearnedQuestions();

  statusEl.textContent = 'Wszystkie pytania usunięte!';
  statusEl.style.color = 'green';
  setTimeout(() => { statusEl.textContent = ''; statusEl.style.color = ''; }, 2000);
}

// --- Application Tracker Functions ---

// Generate unique ID
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Get applications from storage
async function getApplications() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['applications'], (result) => {
      resolve(result.applications || []);
    });
  });
}

// Save applications to storage
async function saveApplications(applications) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ applications }, resolve);
  });
}

// Load and render applications in Kanban view
async function loadApplications(searchText = '') {
  const applications = await getApplications();

  // Apply search filter
  let filtered = applications;
  if (searchText) {
    const searchLower = searchText.toLowerCase();
    filtered = applications.filter(app =>
      app.company.toLowerCase().includes(searchLower) ||
      app.job_title.toLowerCase().includes(searchLower) ||
      (app.location && app.location.toLowerCase().includes(searchLower)) ||
      (app.notes && app.notes.toLowerCase().includes(searchLower))
    );
  }

  renderKanbanBoard(filtered);
  updateKanbanCounts(filtered);
  initializeDragAndDrop();
}

// Render Kanban board
function renderKanbanBoard(applications) {
  const statuses = ['applied', 'interviews', 'offer', 'accepted', 'rejected'];

  statuses.forEach(status => {
    const column = document.getElementById(`kanban-${status}`);
    if (!column) return;

    const statusApps = applications.filter(app => app.status === status);

    if (statusApps.length === 0) {
      column.innerHTML = `
        <div class="empty-kanban">
          Brak aplikacji
        </div>
      `;
      return;
    }

    column.innerHTML = statusApps.map(app => `
      <div class="kanban-card" draggable="true" data-id="${app.id}">
        <h4 class="kanban-card-title">${escapeHtml(app.job_title)}</h4>
        <p class="kanban-card-company">${escapeHtml(app.company)}</p>
        <div class="kanban-card-details">
          ${app.location ? `<div class="kanban-card-detail">📍 ${escapeHtml(app.location)}</div>` : ''}
          ${app.salary ? `<div class="kanban-card-detail">💰 ${escapeHtml(app.salary)}</div>` : ''}
          <div class="kanban-card-detail">📅 ${formatApplicationDate(app.applied_date)}</div>
        </div>
        <div class="kanban-card-actions">
          <button class="kanban-card-btn view-app" data-id="${app.id}">👁️</button>
          <button class="kanban-card-btn edit-app" data-id="${app.id}">✏️</button>
          <button class="kanban-card-btn delete-app" data-id="${app.id}">🗑️</button>
        </div>
      </div>
    `).join('');

    // Add event listeners
    column.querySelectorAll('.view-app').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        viewApplication(btn.dataset.id);
      });
    });
    column.querySelectorAll('.edit-app').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        editApplication(btn.dataset.id);
      });
    });
    column.querySelectorAll('.delete-app').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteApplication(btn.dataset.id);
      });
    });
  });
}

// Update Kanban column counts
function updateKanbanCounts(applications) {
  const statuses = ['applied', 'interviews', 'offer', 'accepted', 'rejected'];

  statuses.forEach(status => {
    const count = applications.filter(app => app.status === status).length;
    const countEl = document.getElementById(`count-${status}`);
    if (countEl) {
      countEl.textContent = count;
    }
  });
}

// Get status label in Polish
function getStatusLabel(status) {
  const labels = {
    'applied': 'Zaaplikowano',
    'interviews': 'Rozmowy',
    'offer': 'Oferta',
    'accepted': 'Zaakceptowana oferta',
    'rejected': 'Odrzucone'
  };
  return labels[status] || status;
}

// Format application date
function formatApplicationDate(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Dzisiaj';
  if (diffDays === 1) return 'Wczoraj';
  if (diffDays < 7) return `${diffDays} dni temu`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} tyg. temu`;

  return date.toLocaleDateString('pl-PL');
}

// View application details
async function viewApplication(appId) {
  const applications = await getApplications();
  const app = applications.find(a => a.id === appId);

  if (!app) return;

  showApplicationModal(app, false);
}

// Edit application
async function editApplication(appId) {
  const applications = await getApplications();
  const app = applications.find(a => a.id === appId);

  if (!app) return;

  showApplicationModal(app, true);
}

// Delete application
async function deleteApplication(appId) {
  if (!confirm('Czy na pewno chcesz usunąć tę aplikację?')) return;

  const applications = await getApplications();
  const filtered = applications.filter(a => a.id !== appId);
  await saveApplications(filtered);

  // Reload with current search
  const searchText = document.getElementById('search-applications').value;
  await loadApplications(searchText);

  statusEl.textContent = 'Aplikacja usunięta!';
  statusEl.style.color = 'green';
  setTimeout(() => { statusEl.textContent = ''; statusEl.style.color = ''; }, 2000);
}

// Initialize drag and drop for Kanban
function initializeDragAndDrop() {
  const cards = document.querySelectorAll('.kanban-card');
  const columns = document.querySelectorAll('.kanban-cards');

  cards.forEach(card => {
    card.addEventListener('dragstart', handleDragStart);
    card.addEventListener('dragend', handleDragEnd);
  });

  columns.forEach(column => {
    column.addEventListener('dragover', handleDragOver);
    column.addEventListener('drop', handleDrop);
    column.addEventListener('dragleave', handleDragLeave);
  });
}

let draggedElement = null;

function handleDragStart(e) {
  draggedElement = this;
  this.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/html', this.innerHTML);
}

function handleDragEnd(e) {
  this.classList.remove('dragging');
}

function handleDragOver(e) {
  if (e.preventDefault) {
    e.preventDefault();
  }
  e.dataTransfer.dropEffect = 'move';
  this.classList.add('drag-over');
  return false;
}

function handleDragLeave(e) {
  this.classList.remove('drag-over');
}

async function handleDrop(e) {
  if (e.stopPropagation) {
    e.stopPropagation();
  }

  this.classList.remove('drag-over');

  if (draggedElement && draggedElement !== this) {
    const appId = draggedElement.dataset.id;
    const newStatus = this.dataset.status;

    // Update application status
    const applications = await getApplications();
    const app = applications.find(a => a.id === appId);

    if (app && app.status !== newStatus) {
      const oldStatus = app.status;
      app.status = newStatus;
      app.updated_at = new Date().toISOString();

      // Add timeline event
      if (!app.timeline) app.timeline = [];
      app.timeline.push({
        date: new Date().toISOString(),
        event: `Status zmieniony: ${getStatusLabel(oldStatus)} → ${getStatusLabel(newStatus)}`
      });

      // Save and reload
      await saveApplications(applications);
      const searchText = document.getElementById('search-applications').value;
      await loadApplications(searchText);
    }
  }

  return false;
}

// Show application modal (view or edit)
function showApplicationModal(app, isEdit) {
  const modal = document.createElement('div');
  modal.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0,0,0,0.5);
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    overflow-y: auto;
  `;

  const content = document.createElement('div');
  content.style.cssText = `
    background: white;
    padding: 30px;
    border-radius: 8px;
    max-width: 700px;
    width: 100%;
    max-height: 90vh;
    overflow-y: auto;
    box-shadow: 0 4px 20px rgba(0,0,0,0.3);
  `;

  content.innerHTML = `
    <h2 style="margin-top: 0;">${isEdit ? '✏️ Edycja aplikacji' : '👁️ Szczegóły aplikacji'}</h2>

    <div style="margin-bottom: 15px;">
      <label style="display: block; margin-bottom: 5px; font-weight: 500;">Stanowisko:</label>
      <input type="text" id="modal-job-title" value="${escapeHtml(app.job_title)}" ${isEdit ? '' : 'disabled'}
        style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">
    </div>

    <div style="margin-bottom: 15px;">
      <label style="display: block; margin-bottom: 5px; font-weight: 500;">Firma:</label>
      <input type="text" id="modal-company" value="${escapeHtml(app.company)}" ${isEdit ? '' : 'disabled'}
        style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">
    </div>

    <div style="margin-bottom: 15px;">
      <label style="display: block; margin-bottom: 5px; font-weight: 500;">Lokalizacja:</label>
      <input type="text" id="modal-location" value="${escapeHtml(app.location || '')}" ${isEdit ? '' : 'disabled'}
        style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">
    </div>

    <div style="margin-bottom: 15px;">
      <label style="display: block; margin-bottom: 5px; font-weight: 500;">Wynagrodzenie:</label>
      <input type="text" id="modal-salary" value="${escapeHtml(app.salary || '')}" ${isEdit ? '' : 'disabled'}
        style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">
    </div>

    <div style="margin-bottom: 15px;">
      <label style="display: block; margin-bottom: 5px; font-weight: 500;">Status:</label>
      <select id="modal-status" ${isEdit ? '' : 'disabled'}
        style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">
        <option value="applied" ${app.status === 'applied' ? 'selected' : ''}>Zaaplikowano</option>
        <option value="interviews" ${app.status === 'interviews' ? 'selected' : ''}>Rozmowy</option>
        <option value="offer" ${app.status === 'offer' ? 'selected' : ''}>Oferta</option>
        <option value="accepted" ${app.status === 'accepted' ? 'selected' : ''}>Zaakceptowana oferta</option>
        <option value="rejected" ${app.status === 'rejected' ? 'selected' : ''}>Odrzucone</option>
      </select>
    </div>

    <div style="margin-bottom: 15px;">
      <label style="display: block; margin-bottom: 5px; font-weight: 500;">Data aplikacji:</label>
      <input type="date" id="modal-applied-date" value="${app.applied_date}" ${isEdit ? '' : 'disabled'}
        style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">
    </div>

    <div style="margin-bottom: 15px;">
      <label style="display: block; margin-bottom: 5px; font-weight: 500;">Follow-up date:</label>
      <input type="date" id="modal-follow-up" value="${app.follow_up_date || ''}" ${isEdit ? '' : 'disabled'}
        style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">
    </div>

    <div style="margin-bottom: 15px;">
      <label style="display: block; margin-bottom: 5px; font-weight: 500;">Link do oferty:</label>
      <input type="url" id="modal-job-url" value="${escapeHtml(app.job_url || '')}" ${isEdit ? '' : 'disabled'}
        style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">
      ${!isEdit && app.job_url ? `<a href="${escapeHtml(app.job_url)}" target="_blank" style="font-size: 0.9em; color: #4CAF50;">Otwórz ofertę →</a>` : ''}
    </div>

    <div style="margin-bottom: 15px;">
      <label style="display: block; margin-bottom: 5px; font-weight: 500;">Źródło:</label>
      <input type="text" id="modal-source" value="${escapeHtml(app.source || '')}" ${isEdit ? '' : 'disabled'}
        style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">
    </div>

    <div style="margin-bottom: 15px;">
      <label style="display: block; margin-bottom: 5px; font-weight: 500;">Notatki:</label>
      <textarea id="modal-notes" ${isEdit ? '' : 'disabled'}
        style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; min-height: 100px; font-family: inherit;">${escapeHtml(app.notes || '')}</textarea>
    </div>

    ${!isEdit && app.timeline && app.timeline.length > 0 ? `
      <div style="margin-bottom: 15px;">
        <label style="display: block; margin-bottom: 5px; font-weight: 500;">Timeline:</label>
        <div style="background: #f5f5f5; padding: 10px; border-radius: 4px;">
          ${app.timeline.map(event => `
            <div style="margin-bottom: 5px; font-size: 0.9em;">
              <strong>${new Date(event.date).toLocaleDateString('pl-PL')}</strong>: ${escapeHtml(event.event)}
            </div>
          `).join('')}
        </div>
      </div>
    ` : ''}

    <div style="display: flex; gap: 10px; margin-top: 20px;">
      ${isEdit ? `
        <button id="save-app" style="flex: 1; padding: 10px; background: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: 500;">
          💾 Zapisz
        </button>
      ` : ''}
      <button id="close-modal" style="flex: 1; padding: 10px; background: #999; color: white; border: none; border-radius: 4px; cursor: pointer;">
        ${isEdit ? 'Anuluj' : 'Zamknij'}
      </button>
    </div>
  `;

  modal.appendChild(content);
  document.body.appendChild(modal);

  // Event listeners
  document.getElementById('close-modal').addEventListener('click', () => modal.remove());

  if (isEdit) {
    document.getElementById('save-app').addEventListener('click', async () => {
      const updatedApp = {
        ...app,
        job_title: document.getElementById('modal-job-title').value.trim(),
        company: document.getElementById('modal-company').value.trim(),
        location: document.getElementById('modal-location').value.trim(),
        salary: document.getElementById('modal-salary').value.trim(),
        status: document.getElementById('modal-status').value,
        applied_date: document.getElementById('modal-applied-date').value,
        follow_up_date: document.getElementById('modal-follow-up').value,
        job_url: document.getElementById('modal-job-url').value.trim(),
        source: document.getElementById('modal-source').value.trim(),
        notes: document.getElementById('modal-notes').value.trim(),
        updated_at: new Date().toISOString()
      };

      // Add timeline event for status change
      if (app.status !== updatedApp.status) {
        if (!updatedApp.timeline) updatedApp.timeline = [];
        updatedApp.timeline.push({
          date: new Date().toISOString(),
          event: `Status zmieniony: ${getStatusLabel(app.status)} → ${getStatusLabel(updatedApp.status)}`
        });
      }

      const applications = await getApplications();
      const index = applications.findIndex(a => a.id === app.id);
      if (index !== -1) {
        applications[index] = updatedApp;
        await saveApplications(applications);

        // Reload
        const searchText = document.getElementById('search-applications').value;
        await loadApplications(searchText);

        modal.remove();
        statusEl.textContent = 'Aplikacja zaktualizowana!';
        statusEl.style.color = 'green';
        setTimeout(() => { statusEl.textContent = ''; statusEl.style.color = ''; }, 2000);
      }
    });
  }

  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });
}

// Show add application modal
function showAddApplicationModal() {
  const modal = document.createElement('div');
  modal.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0,0,0,0.5);
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    overflow-y: auto;
  `;

  const content = document.createElement('div');
  content.style.cssText = `
    background: white;
    padding: 30px;
    border-radius: 8px;
    max-width: 700px;
    width: 100%;
    max-height: 90vh;
    overflow-y: auto;
    box-shadow: 0 4px 20px rgba(0,0,0,0.3);
  `;

  const today = new Date().toISOString().split('T')[0];

  content.innerHTML = `
    <h2 style="margin-top: 0;">➕ Dodaj nową aplikację</h2>

    <div style="margin-bottom: 15px;">
      <label style="display: block; margin-bottom: 5px; font-weight: 500;">Stanowisko: <span style="color: red;">*</span></label>
      <input type="text" id="new-job-title" required
        style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">
    </div>

    <div style="margin-bottom: 15px;">
      <label style="display: block; margin-bottom: 5px; font-weight: 500;">Firma: <span style="color: red;">*</span></label>
      <input type="text" id="new-company" required
        style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">
    </div>

    <div style="margin-bottom: 15px;">
      <label style="display: block; margin-bottom: 5px; font-weight: 500;">Lokalizacja:</label>
      <input type="text" id="new-location"
        style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">
    </div>

    <div style="margin-bottom: 15px;">
      <label style="display: block; margin-bottom: 5px; font-weight: 500;">Wynagrodzenie:</label>
      <input type="text" id="new-salary" placeholder="np. 10000-15000 PLN"
        style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">
    </div>

    <div style="margin-bottom: 15px;">
      <label style="display: block; margin-bottom: 5px; font-weight: 500;">Status:</label>
      <select id="new-status"
        style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">
        <option value="applied" selected>Zaaplikowano</option>
        <option value="interviews">Rozmowy</option>
        <option value="offer">Oferta</option>
        <option value="accepted">Zaakceptowana oferta</option>
        <option value="rejected">Odrzucone</option>
      </select>
    </div>

    <div style="margin-bottom: 15px;">
      <label style="display: block; margin-bottom: 5px; font-weight: 500;">Data aplikacji:</label>
      <input type="date" id="new-applied-date" value="${today}"
        style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">
    </div>

    <div style="margin-bottom: 15px;">
      <label style="display: block; margin-bottom: 5px; font-weight: 500;">Link do oferty:</label>
      <input type="url" id="new-job-url" placeholder="https://..."
        style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">
    </div>

    <div style="margin-bottom: 15px;">
      <label style="display: block; margin-bottom: 5px; font-weight: 500;">Źródło:</label>
      <input type="text" id="new-source" placeholder="np. LinkedIn, Pracuj.pl"
        style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">
    </div>

    <div style="margin-bottom: 15px;">
      <label style="display: block; margin-bottom: 5px; font-weight: 500;">Notatki:</label>
      <textarea id="new-notes"
        style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; min-height: 100px; font-family: inherit;"></textarea>
    </div>

    <div style="display: flex; gap: 10px; margin-top: 20px;">
      <button id="create-app" style="flex: 1; padding: 10px; background: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: 500;">
        ➕ Dodaj aplikację
      </button>
      <button id="cancel-add" style="flex: 1; padding: 10px; background: #999; color: white; border: none; border-radius: 4px; cursor: pointer;">
        Anuluj
      </button>
    </div>
  `;

  modal.appendChild(content);
  document.body.appendChild(modal);

  document.getElementById('cancel-add').addEventListener('click', () => modal.remove());

  document.getElementById('create-app').addEventListener('click', async () => {
    const jobTitle = document.getElementById('new-job-title').value.trim();
    const company = document.getElementById('new-company').value.trim();

    if (!jobTitle || !company) {
      alert('Stanowisko i firma są wymagane!');
      return;
    }

    const newApp = {
      id: generateId(),
      job_title: jobTitle,
      company: company,
      location: document.getElementById('new-location').value.trim(),
      salary: document.getElementById('new-salary').value.trim(),
      status: document.getElementById('new-status').value,
      applied_date: document.getElementById('new-applied-date').value || today,
      job_url: document.getElementById('new-job-url').value.trim(),
      source: document.getElementById('new-source').value.trim(),
      notes: document.getElementById('new-notes').value.trim(),
      timeline: [{
        date: new Date().toISOString(),
        event: 'Aplikacja utworzona'
      }],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const applications = await getApplications();
    applications.unshift(newApp);
    await saveApplications(applications);

    // Reload
    const searchText = document.getElementById('search-applications').value;
    await loadApplications(searchText);

    modal.remove();
    statusEl.textContent = 'Aplikacja dodana!';
    statusEl.style.color = 'green';
    setTimeout(() => { statusEl.textContent = ''; statusEl.style.color = ''; }, 2000);
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });
}

// Tab switching
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tabName = btn.dataset.tab;

      // Update active states
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      document.getElementById(`${tabName}-tab`).classList.add('active');

      // Load data for specific tabs
      if (tabName === 'applications') {
        loadApplications();
      } else if (tabName === 'learning') {
        displayLearnedQuestions();
      }
    });
  });
}

// --- Event Listeners ---

document.addEventListener('DOMContentLoaded', () => {
    loadApiKey();
    loadData();
    loadCvStatus();
    loadCvSettings();
    displayLearnedQuestions();
    initTabs();
});
addRowBtn.addEventListener('click', () => createDataRow());
saveBtn.addEventListener('click', () => {
    saveApiKey();
    saveData();
});
cvUpload.addEventListener('change', handleCvUpload);
apiKeyInput.addEventListener('change', saveApiKey);
toggleApiKeyBtn.addEventListener('click', toggleApiKeyVisibility);

// Learned questions event listeners
document.getElementById('refresh-questions').addEventListener('click', () => displayLearnedQuestions());
document.getElementById('question-search').addEventListener('input', (e) => {
  displayLearnedQuestions(e.target.value);
});
document.getElementById('export-questions').addEventListener('click', handleExport);
document.getElementById('import-questions').addEventListener('click', () => {
  document.getElementById('import-file').click();
});
document.getElementById('import-file').addEventListener('change', handleImport);
document.getElementById('clear-questions').addEventListener('click', handleClear);

// CV analysis event listeners
document.getElementById('use-cv-data').addEventListener('change', handleUseCvDataToggle);
document.getElementById('analyze-cv').addEventListener('click', analyzeCVData);
document.getElementById('view-cv-data').addEventListener('click', viewCVData);

// Application Tracker event listeners
document.getElementById('add-application-btn').addEventListener('click', showAddApplicationModal);
document.getElementById('search-applications').addEventListener('input', (e) => {
  loadApplications(e.target.value);
});
