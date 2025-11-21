// Background Service Worker for Application Tracker

// Setup alarm for checking follow-ups
chrome.runtime.onInstalled.addListener(() => {
  console.log('[Application Tracker] Extension installed, setting up alarms');

  // Check follow-ups every hour
  chrome.alarms.create('checkFollowUps', {
    periodInMinutes: 60
  });
});

// Listen for alarms
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'checkFollowUps') {
    checkFollowUpReminders();
  }
});

// Check for upcoming follow-ups and send notifications
async function checkFollowUpReminders() {
  try {
    const result = await chrome.storage.local.get(['applications']);
    const applications = result.applications || [];
    const now = new Date();

    console.log('[Application Tracker] Checking follow-ups for', applications.length, 'applications');

    applications.forEach(app => {
      if (!app.follow_up_date) return;

      const followUpDate = new Date(app.follow_up_date);
      const diffHours = (followUpDate - now) / (1000 * 60 * 60);

      // Send notification 24 hours before follow-up
      if (diffHours > 0 && diffHours <= 24) {
        // Check if we already sent notification for this follow-up
        const notificationKey = `notif_${app.id}_${app.follow_up_date}`;

        chrome.storage.local.get([notificationKey], (result) => {
          if (!result[notificationKey]) {
            // Send notification
            chrome.notifications.create({
              type: 'basic',
              iconUrl: 'icon.png',
              title: '⏰ Przypomnienie o follow-up',
              message: `${app.company} - ${app.job_title}\nFollow-up za ${Math.round(diffHours)}h`,
              priority: 2,
              requireInteraction: true
            });

            // Mark as sent
            chrome.storage.local.set({ [notificationKey]: true });

            console.log('[Application Tracker] Notification sent for', app.company, app.job_title);
          }
        });
      }
    });
  } catch (error) {
    console.error('[Application Tracker] Error checking follow-ups:', error);
  }
}

// Handle notification clicks - open options page
chrome.notifications.onClicked.addListener((notificationId) => {
  chrome.runtime.openOptionsPage();
});

// Listen for messages from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'saveApplication') {
    saveApplication(request.data).then(response => {
      sendResponse(response);
    });
    return true; // Keeps the message channel open for async response
  }

  if (request.action === 'openOptions') {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return true;
  }
});

// Save application to storage
async function saveApplication(applicationData) {
  try {
    const result = await chrome.storage.local.get(['applications']);
    const applications = result.applications || [];

    // Add to beginning (newest first)
    applications.unshift(applicationData);

    await chrome.storage.local.set({ applications });

    console.log('[Application Tracker] Application saved:', applicationData.company, applicationData.job_title);

    return { success: true };
  } catch (error) {
    console.error('[Application Tracker] Error saving application:', error);
    return { success: false, error: error.message };
  }
}
