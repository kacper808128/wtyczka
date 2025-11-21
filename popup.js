// Theme Management
function initTheme() {
  chrome.storage.local.get(['darkMode'], (result) => {
    if (result.darkMode) {
      document.body.classList.add('dark-mode');
      document.getElementById('theme-icon').textContent = '☀️';
    }
  });
}

function toggleTheme() {
  const isDark = document.body.classList.toggle('dark-mode');
  document.getElementById('theme-icon').textContent = isDark ? '☀️' : '🌙';
  chrome.storage.local.set({ darkMode: isDark });
}

// Status Management
function updateStatus() {
  const indicator = document.getElementById('status-indicator');
  const title = document.getElementById('status-title');
  const message = document.getElementById('status-message');

  chrome.storage.sync.get(['geminiApiKey'], (result) => {
    if (result.geminiApiKey && result.geminiApiKey.startsWith('AIza')) {
      indicator.className = 'status-indicator ready';
      title.textContent = 'Gotowy do pracy';
      message.textContent = 'Klucz API skonfigurowany';
    } else {
      indicator.className = 'status-indicator warning';
      title.textContent = 'Wymaga konfiguracji';
      message.textContent = 'Ustaw klucz API w ustawieniach';
    }
  });
}

// Statistics
function loadStats() {
  // Load learned questions count
  chrome.storage.local.get(['learnedQuestions', 'applications'], (result) => {
    const questions = result.learnedQuestions || [];
    const applications = result.applications || [];

    document.getElementById('stat-questions').textContent = questions.length;
    document.getElementById('stat-applications').textContent = applications.length;
  });
}

// Fill Form Handler
document.getElementById('fill-form').addEventListener('click', () => {
  const fillButton = document.getElementById('fill-form');

  // Add loading state
  fillButton.classList.add('loading');
  fillButton.disabled = true;

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    // Check for errors in tabs.query
    if (chrome.runtime.lastError) {
      console.error('Error querying tabs:', chrome.runtime.lastError);
      showError('Nie mozna znalezc aktywnej karty.');
      resetButton(fillButton);
      return;
    }

    // Validate that we have a tab
    if (!tabs || tabs.length === 0) {
      console.error('No active tab found');
      showError('Brak aktywnej karty.');
      resetButton(fillButton);
      return;
    }

    const tab = tabs[0];

    // Check if tab URL is accessible
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      showError('Nie mozna wypelnic formularzy na tej stronie.');
      resetButton(fillButton);
      return;
    }

    chrome.tabs.sendMessage(tab.id, { action: 'fill_form' }, (response) => {
      resetButton(fillButton);

      if (chrome.runtime.lastError) {
        console.error('Error sending message:', chrome.runtime.lastError);
        if (chrome.runtime.lastError.message.includes('Receiving end does not exist')) {
          showError('Odswiez strone i sprobuj ponownie.');
        } else {
          showError('Blad komunikacji: ' + chrome.runtime.lastError.message);
        }
        return;
      }

      if (response && response.status === 'success') {
        console.log('Form filled successfully!');
        window.close();
      } else if (response && response.status === 'error') {
        console.error('Error filling form:', response.message);
        showError(response.message || 'Nieznany blad');
      } else {
        console.warn('Unexpected response:', response);
        showError('Nieoczekiwana odpowiedz.');
      }
    });
  });
});

// Settings Handler
document.getElementById('open-settings').addEventListener('click', () => {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    window.open(chrome.runtime.getURL('options.html'));
  }
});

// Theme Toggle Handler
document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

// Help Link Handler
document.getElementById('help-link').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// Helper Functions
function resetButton(button) {
  button.classList.remove('loading');
  button.disabled = false;
}

function showError(message) {
  // Update status card to show error
  const indicator = document.getElementById('status-indicator');
  const title = document.getElementById('status-title');
  const statusMessage = document.getElementById('status-message');

  indicator.className = 'status-indicator error';
  title.textContent = 'Blad';
  statusMessage.textContent = message;

  // Reset status after 5 seconds
  setTimeout(updateStatus, 5000);
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  updateStatus();
  loadStats();
});
