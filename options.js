/*
 * Konfetti – options page.
 *
 * One checkbox: "Super konfetti mode". It is stored locally; the content
 * script on claude.ai reads it and reacts to changes straight away.
 */
const KEY = 'super';
const box = document.getElementById(KEY);

chrome.storage.local.get({ [KEY]: false }, (stored) => {
  box.checked = !!stored[KEY];
});

box.addEventListener('change', () => {
  chrome.storage.local.set({ [KEY]: box.checked });
});

// Keep several open copies of this page in step.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[KEY]) box.checked = !!changes[KEY].newValue;
});
