// options.js

const dataContainer = document.getElementById('data-container');
const addRowBtn = document.getElementById('add-row');
const saveBtn = document.getElementById('save');
const statusEl = document.getElementById('status');
const cvUpload = document.getElementById('cv-upload');
const cvStatusEl = document.getElementById('cv-status');

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
        .then(response => response.ok ? response.json() : Promise.reject('data.json not found'))
        .then(data => {
          // Save migrated data to storage
          chrome.storage.sync.set({ userData: data }, () => {
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

function saveData() {
  const dataRows = document.querySelectorAll('.data-row');
  const newData = {};
  let hasError = false;

  dataRows.forEach(row => {
    const key = row.querySelector('.data-key').value.trim();
    const value = row.querySelector('.data-value').value.trim();
    if (key) {
      newData[key] = value;
    } else {
        hasError = true;
    }
  });

  if (hasError) {
      statusEl.textContent = 'Błąd: Klucz nie może być pusty.';
      return;
  }

  chrome.storage.sync.set({ userData: newData }, () => {
    statusEl.textContent = 'Zmiany zapisane!';
    setTimeout(() => { statusEl.textContent = ''; }, 2000);
  });
}

// --- CV Management ---

function loadCvStatus() {
    chrome.storage.local.get('userCV', (result) => {
        if (result.userCV && result.userCV.name) {
            cvStatusEl.textContent = `Załączono plik: ${result.userCV.name}`;
        } else {
            cvStatusEl.textContent = 'Nie załączono pliku CV.';
        }
    });
}

function handleCvUpload(event) {
    const file = event.target.files[0];
    if (!file) {
        return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        const cvData = {
            name: file.name,
            type: file.type,
            dataUrl: e.target.result
        };
        chrome.storage.local.set({ userCV: cvData }, () => {
            loadCvStatus();
            statusEl.textContent = 'CV zapisane!';
            setTimeout(() => { statusEl.textContent = ''; }, 2000);
        });
    };
    reader.readAsDataURL(file);
}


// --- Event Listeners ---

document.addEventListener('DOMContentLoaded', () => {
    loadData();
    loadCvStatus();
});
addRowBtn.addEventListener('click', () => createDataRow());
saveBtn.addEventListener('click', saveData);
cvUpload.addEventListener('change', handleCvUpload);
