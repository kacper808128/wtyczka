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

// --- Event Listeners ---

document.addEventListener('DOMContentLoaded', () => {
    loadApiKey();
    loadData();
    loadCvStatus();
});
addRowBtn.addEventListener('click', () => createDataRow());
saveBtn.addEventListener('click', () => {
    saveApiKey();
    saveData();
});
cvUpload.addEventListener('change', handleCvUpload);
apiKeyInput.addEventListener('change', saveApiKey);
toggleApiKeyBtn.addEventListener('click', toggleApiKeyVisibility);
