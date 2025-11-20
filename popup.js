document.getElementById('fill-form').addEventListener('click', () => {
  const fillButton = document.getElementById('fill-form');
  const originalText = fillButton.textContent;

  // Disable button during processing
  fillButton.disabled = true;
  fillButton.textContent = 'Wypełnianie...';

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    // Check for errors in tabs.query
    if (chrome.runtime.lastError) {
      console.error('Error querying tabs:', chrome.runtime.lastError);
      alert('Błąd: Nie można znaleźć aktywnej karty.');
      fillButton.disabled = false;
      fillButton.textContent = originalText;
      return;
    }

    // Validate that we have a tab
    if (!tabs || tabs.length === 0) {
      console.error('No active tab found');
      alert('Błąd: Brak aktywnej karty.');
      fillButton.disabled = false;
      fillButton.textContent = originalText;
      return;
    }

    const tab = tabs[0];

    // Check if tab URL is accessible
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      alert('Błąd: Nie można wypełnić formularzy na tej stronie (strona systemowa Chrome).');
      fillButton.disabled = false;
      fillButton.textContent = originalText;
      return;
    }

    chrome.tabs.sendMessage(tab.id, { action: 'fill_form' }, (response) => {
      // Re-enable button
      fillButton.disabled = false;
      fillButton.textContent = originalText;

      if (chrome.runtime.lastError) {
        console.error('Error sending message:', chrome.runtime.lastError);
        // Common error when content script is not injected
        if (chrome.runtime.lastError.message.includes('Receiving end does not exist')) {
          alert('Błąd: Odśwież stronę i spróbuj ponownie.');
        } else {
          alert('Błąd komunikacji: ' + chrome.runtime.lastError.message);
        }
        return;
      }

      if (response && response.status === 'success') {
        console.log('Form filled successfully!');
        // Close popup after success
        window.close();
      } else if (response && response.status === 'error') {
        console.error('Error filling form:', response.message);
        alert('Błąd wypełniania formularza: ' + (response.message || 'Nieznany błąd'));
      } else {
        console.warn('Unexpected response:', response);
        alert('Nieoczekiwana odpowiedź. Sprawdź konsolę, aby uzyskać więcej informacji.');
      }
    });
  });
});

document.getElementById('open-settings').addEventListener('click', () => {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    // Fallback for older Chrome versions
    window.open(chrome.runtime.getURL('options.html'));
  }
});

// Learning system debug functions
async function updateLearnedCount() {
  chrome.storage.local.get(['learnedQuestions'], (result) => {
    const questions = result.learnedQuestions || [];
    const countDiv = document.getElementById('learned-count');

    if (questions.length === 0) {
      countDiv.textContent = 'Brak nauczonych pytań';
      countDiv.style.color = '#999';
    } else {
      const readyToUse = questions.filter(q => q.confidence >= 0.75).length;
      countDiv.innerHTML = `
        <strong>${questions.length}</strong> nauczonych pytań<br>
        <span style="color: green;">${readyToUse} gotowych do użycia</span> (confidence ≥ 0.75)
      `;
      countDiv.style.color = '#333';
    }
  });
}

document.getElementById('view-learned').addEventListener('click', () => {
  chrome.storage.local.get(['learnedQuestions'], (result) => {
    const questions = result.learnedQuestions || [];

    if (questions.length === 0) {
      alert('Brak nauczonych pytań.\n\nSystem uczenia zapisuje pytania gdy rozszerzenie wypełnia formularze używając AI.');
      return;
    }

    // Sort by confidence (highest first)
    questions.sort((a, b) => b.confidence - a.confidence);

    let output = `📚 NAUCZONE PYTANIA (${questions.length}):\n\n`;

    questions.forEach((q, i) => {
      const readyIcon = q.confidence >= 0.75 ? '✅' : '⏳';
      const confidencePercent = (q.confidence * 100).toFixed(0);

      output += `${i + 1}. ${readyIcon} "${q.question_text}"\n`;
      output += `   Odpowiedź: "${q.user_answer}"\n`;
      output += `   Pewność: ${confidencePercent}% | Użyć: ${q.frequency}x | 👍 ${q.feedback_positive} / 👎 ${q.feedback_negative}\n`;
      output += `   Typ: ${q.field_type}\n\n`;
    });

    output += '\n💡 Pytania z pewnością ≥75% są automatycznie używane zamiast AI.';
    output += '\n\n👍 Klikaj przyciski feedback żeby zwiększyć pewność!';

    // Create a modal to show the output (better than alert for long text)
    const modal = document.createElement('div');
    modal.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0,0,0,0.8);
      z-index: 10000;
      display: flex;
      align-items: center;
      justify-content: center;
    `;

    const content = document.createElement('div');
    content.style.cssText = `
      background: white;
      padding: 20px;
      border-radius: 8px;
      max-width: 600px;
      max-height: 80%;
      overflow-y: auto;
      position: relative;
    `;

    const pre = document.createElement('pre');
    pre.textContent = output;
    pre.style.cssText = `
      white-space: pre-wrap;
      font-size: 12px;
      margin: 0;
    `;

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕ Zamknij';
    closeBtn.style.cssText = `
      position: sticky;
      top: 0;
      float: right;
      margin-bottom: 10px;
    `;
    closeBtn.onclick = () => modal.remove();

    content.appendChild(closeBtn);
    content.appendChild(pre);
    modal.appendChild(content);
    document.body.appendChild(modal);
  });
});

document.getElementById('clear-learned').addEventListener('click', () => {
  if (confirm('Czy na pewno chcesz wyczyścić wszystkie nauczone pytania?\n\nTej operacji nie można cofnąć!')) {
    chrome.storage.local.set({ learnedQuestions: [] }, () => {
      alert('System uczenia został wyczyszczony.');
      updateLearnedCount();
    });
  }
});

// Update count on popup open
updateLearnedCount();
