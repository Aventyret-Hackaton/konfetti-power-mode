/*
 * Konfetti – toolbar button.
 *
 * Clicking the button switches "blow the pile away with the microphone" on
 * or off. The switch is stored locally; the content script on claude.ai
 * reads it and reacts to changes. Nothing else happens here.
 */
const KEY = 'blow';

async function refresh() {
  const { [KEY]: on = false } = await chrome.storage.local.get(KEY);
  await chrome.action.setBadgeBackgroundColor({ color: '#ff3b6b' });
  await chrome.action.setBadgeText({ text: on ? 'MIC' : '' });
  await chrome.action.setTitle({
    title: on
      ? 'Konfetti: blow into your microphone to clear the pile. Click to turn the microphone off.'
      : 'Konfetti: click to clear the pile by blowing into your microphone.',
  });
}

chrome.action.onClicked.addListener(async () => {
  const { [KEY]: on = false } = await chrome.storage.local.get(KEY);
  await chrome.storage.local.set({ [KEY]: !on });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[KEY]) refresh();
});

chrome.runtime.onInstalled.addListener(refresh);
chrome.runtime.onStartup.addListener(refresh);
refresh();
