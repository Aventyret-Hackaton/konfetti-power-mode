# Konfetti – Power Mode for Claude

A Chrome extension inspired by [Power Mode](https://github.com/hoovercj/vscode-power-mode).
Every character you type into a prompt on [claude.ai](https://claude.ai) is turned into
confetti: a copy of the character is thrown into the air together with a burst of paper,
tumbles down, and lands at the bottom of the screen. The heap of confetti keeps growing
for as long as you type. Blow into your microphone (or reload the tab) to sweep the floor.

For more, switch on [Super konfetti mode](#super-konfetti-mode).

## Install

0. Download and unpack the
   [latest zip](https://github.com/Aventyret-Hackaton/konfetti/archive/refs/heads/plan-b.zip)
   (or clone this repository).
1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Open (or reload) a claude.ai tab and start typing.

## What triggers confetti

| Action | Effect |
| --- | --- |
| Typing a character | The character plus a burst of confetti launch from where it was typed. The first character gets 10 pieces and every further character gets one more (up to 60), until you pause for 10 seconds |
| IME / dead-key composition | The committed text explodes when composition ends |
| Paste | One big burst from the caret, with some of the pasted characters mixed in |
| Blowing into the microphone (after switching it on) | The whole pile is blown off the screen and fades away, and a new pile starts as you keep typing |
| Any keystroke that edits the prompt (typing, deleting, pasting) | The prompt box gives a discreet 1.5px shake, plus a short vibration on devices that have a vibration motor |

It works in the main prompt box and in textareas such as the "edit message" box.
Single-line `<input>` fields (search, rename, login) are ignored on purpose.

## Blowing the pile away

1. Click the Konfetti button in Chrome's toolbar (pin it from the puzzle-piece menu
   if you don't see it). The button shows a **MIC** badge while this is on.
2. Chrome asks whether claude.ai may use your microphone. Allow it.
3. Blow into the microphone. The pile is blown off the screen and a new one starts
   as you type.

Click the button again to switch it off. The setting is remembered.

The microphone is only open while the claude.ai tab is visible and there is confetti
on screen, so Chrome's recording indicator comes and goes with the confetti. The sound
is measured for loudness on the page itself and immediately discarded: nothing is
recorded, stored or sent anywhere. If you refuse the permission, the feature switches
itself off again.

A blow is recognised as a loud, low rumble lasting about a fifth of a second. If it
does not react, lower `BLOW_LEVEL` in `content.js` (for example to `0.04`); if speech
or bumps set it off, raise it.

## Super konfetti mode

Off by default. To switch it on, right-click the Konfetti button in Chrome's toolbar
and choose **Options** (or open `chrome://extensions`, click **Details** on Konfetti,
then **Extension options**), and tick **Super konfetti mode**. It takes effect straight
away in open claude.ai tabs, and the setting is remembered.

While it is on:

| Action | Effect |
| --- | --- |
| Typing a character | The explosion comes a moment later (a random 0.2 to 1 second), and the character turns transparent in the prompt as it goes off |
| Paste | The burst comes a moment later |
| Claude answering | As the answer streams in, each new character is invisible at first and appears a moment later in a small burst of confetti (3 pieces each) |

Switching it off makes all transparent text visible again. The next three sections
describe the details; they only apply while Super konfetti mode is on.

### Claude's answers

Answers get the mirror image of your typing. Your characters disappear in a burst of
confetti; Claude's characters appear in one. Each new character of a streaming answer
is invisible at first and becomes visible after its random delay, in order, with a
small burst of confetti. Once it has appeared it stays readable. Code blocks, your own
messages and messages that were already on the page are left alone.

Answer characters get 3 confetti pieces each rather than the growing bursts of your
own typing, and at most 120 characters per second get confetti (the rest simply
appear), so a long answer does not flood the screen.

Switches at the top of `content.js`: `ANSWERS = false` turns this part off entirely,
`ANSWERS_APPEAR = false` keeps the confetti but shows the text immediately.

### The delay

A typed character stays readable for a random 0.2 to 1 second (`EXPLODE_DELAY_MIN`
and `EXPLODE_DELAY_MAX`, drawn separately for each character) and then explodes.
Characters always go off in the order they were typed: one whose delay would let it
overtake the character before it waits and goes off right behind it instead, so
characters often go off in small groups. Each then explodes
from wherever it is in the prompt at that moment. If you delete it before then, it
does not explode. If the message is sent before then, it still explodes, from the spot
where it was typed. The shake and vibration are immediate.

### The transparent text

A character that has exploded stays transparent, so you cannot read back what you
typed. The text is still there: it can be selected, edited and sent as usual, and
it is fully visible once the message is sent. Pasted text stays visible. To get typed
text back after a moment, set `REAPPEAR_SECONDS` in `content.js` (for example to `1`),
or set `HIDE_TYPED = false` to turn this part off. In plain textareas (such as the
"edit message" box) individual characters cannot be hidden, so there the text stays
visible.

## About haptics

Web pages and extensions can only reach a vibration motor through `navigator.vibrate`,
which works on phones and tablets. Desktop and laptop hardware (including trackpads)
is not reachable, so there the call does nothing. As a stand-in you can set
`KEY_SOUND = true` in `content.js` for a very quiet tick on every keystroke.

## Tuning

The constants at the top of `content.js` control the effect: `COLORS`,
`EXPLODE_DELAY_MIN`, `EXPLODE_DELAY_MAX`, `HIDE_TYPED`, `REAPPEAR_SECONDS`, `SHAKE_PX`, `SHAKE_MS`, `VIBRATE_MS`, `KEY_SOUND`, `PIECES_PER_CHAR`, `PIECES_GROWTH`, `MAX_PIECES_PER_CHAR`, `STREAK_TIMEOUT`, `GRAVITY`, `PILE_GROWTH` (how fast the heap rises) and so on.
After editing, press the reload button for the extension on `chrome://extensions`
and reload the claude.ai tab.

## Website

`site/` holds a one-page website with a download button (GitHub's zip of the `plan-b`
branch) and install instructions. It is not part of the extension. `wrangler.jsonc`
serves that folder as a static Cloudflare Worker; from the `plan-b` branch,
`npx wrangler preview` publishes it as the `plan-b` Preview of the `konfetti` Worker.

## Privacy

The extension makes no network requests. Its only permission is `storage`, used to
remember whether the microphone feature and Super konfetti mode are switched on. The microphone itself is only
used if you switch that feature on and allow it in Chrome.
It only runs on `https://claude.ai/*`, and the only thing it adds to the page is a
click-through canvas on top of it. The shake is a temporary animation and changes
nothing in the page.
