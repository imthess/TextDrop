# TextDrop

A browser extension that keeps a list of text snippets and inserts any of them into a text box with one click, even on websites that block copy, paste and right-click.

## Install

**Chrome, Chromium, Brave, Edge (folder `textdrop-chrome`)**
1. Unzip, then open `chrome://extensions` (Brave: `brave://extensions`, Edge: `edge://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `textdrop-chrome` folder.
4. Pin the extension (puzzle icon > pin) so the toolbar button is easy to reach.
5. Refresh any tabs that were already open.

**Firefox (folder `textdrop-firefox`)**
1. Open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**, choose `manifest.json` inside the folder. (Temporary add-ons vanish when Firefox closes; a permanent install needs the add-on signed by Mozilla, or Firefox Developer/Nightly/ESR with `xpinstall.signatures.required` set to false.)
2. Open `about:addons`, select TextDrop, open **Permissions**, and turn on "Access your data for all websites". Firefox leaves this off by default and the extension cannot see pages without it.

## Use

1. Click the toolbar icon to add text to your list. Each item can be any length. Set the maximum number of items under **Settings** (default 20, up to 500).
2. On any web page a small **TextDrop** tab sits at the bottom right. Click it to open your list. Drag the header to move it.
3. Put your cursor in a text box (or don't) and click an item. The text goes in at the cursor.
   - Cursor already in a box: text goes there.
   - Cursor left the box: the last box you used is re-selected automatically.
   - Never clicked a box and the page has one: it is selected for you.
   - Page has several and you haven't chosen: every box gets a numbered outline. Click the one you want (Esc cancels). The target icon in the list header does the same on demand.
4. Save text from a page: select it and click **+** in the list header, or press **Alt+Shift+S**. This works even where Ctrl+C is blocked.
5. **Alt+Shift+V** opens or collapses the list.
6. The circular-arrow icon in the list header reloads the page. After you reload or update the extension, pages that were already open lose their connection; the list then opens by itself with that icon highlighted.

## Settings worth knowing

- **When a page loads, the list is**: as you left it (default), always open, or always collapsed. Opening or closing the list in one tab does not affect other tabs.
- **When a text box already has text**: add at the cursor (default), add at the end, replace what you inserted last time, or replace everything in the box.
- **Press Enter after inserting**: off by default. Turn it on to send chat messages, run searches or submit forms right after the text goes in. It is skipped if the site rejected the text, so an empty box is never submitted.
- If a site throws the text away right after it is inserted, the list tells you and suggests "Insert one character at a time".

## Sites that block copy and paste

Clicking an item never uses the clipboard or a paste event, so there is nothing for the site to block. It works the same way as typing.

Under **Settings** there are two extra options:
- **Unlock right-click, copy and paste** (per site or everywhere): stops the site's scripts from cancelling those actions, so your own Ctrl+C, Ctrl+V and right-click menu work again. Off by default because it can break editors that handle paste themselves.
- **Insert one character at a time**: for the few sites that reject text arriving all at once.

## Limits

- Cross-origin iframes (some embedded payment or login forms): click once inside the box first so the extension knows which frame to use.
- Editors drawn on a canvas (Google Docs, Figma and similar) have no real text box to insert into.
- Browsers do not let extensions run on their own pages (`chrome://`, the Web Store, `about:` pages, the built-in PDF viewer).
- After you reload or update the extension, refresh open tabs.
