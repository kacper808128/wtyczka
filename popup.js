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
