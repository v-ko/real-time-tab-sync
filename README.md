Real-Time Tab Sync
==================

**The extension is in maintenance mode!** Only regressions will receive fixes. As I'm enganged in other projects and seldom use it personally any more - feature requests will be frozen until someone volunteers to contribute to their development. I'll be happy to help out anyone who wants to part take.

Keeps the same tabs on all your machines. Tab changes are applied in real time on all of your devices.
The extension watches for tab changes and synchronizes them in real time across all of your devices that have it enabled. Btw you need to enable synchronization in the Chrome settings.

Link in the Chrome web store: https://chrome.google.com/webstore/detail/real-time-tab-sync/bflolmfdngaflefhmapdbbjmclioljck

Details:
- You can toggle synchronization on/off from the extensions icon.

- The extension works in unison with Chrome "On startup" settings :
-- If you choose "Open a new tab" - it will start with a new tab , and sync the tabs from other computers/previous session in the background . 
-- If you choose "Continue where I left off" or a set of pages it will merge them with the sync tabs

- Windows' and tabs' positions and size can be individual on each device , as the synchronization only takes in account the tabs' URLs.

- It's implied that you want to keep your tabs across sessions . Otherwise (if tabs were removed at sessions' end) when you close the browser on one device - the tabs (therefore windows) on all other devices would close.

- New tabs (chrome://newtab) and developer tools (chrome://developer-tools/*) are unaffected by the extension for fluency .

- On sync (if a change is detected on another machine) the extension just compares two lists - URLs of all local tabs , and URLs that are synced on the last remote tab change. Differences are applied to the local tabs and that's it . That has its limitations , but the biggest advantages are simplicity and speed (along with the aforementioned "feature" (for me at least) that the tabs can be in different windows with different sizes on separate devices) .

ToDo (maybe)
--------------------
- Last n syncs to be viewable/restorable from the popup
- Editable list of excluded addresses
