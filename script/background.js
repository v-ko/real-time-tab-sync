//========Global variables===========
const startDuration = 6000; //(ms) sync conservatively at startup
const writeDelay = 1500; //(ms) write storage after a delay from latest update
const redirectDelay = 1500; //(ms) consider as redirection if a tab loads twice within short interval
const stepDelay = 1000; //(ms) delay to run next step in sync
const recreateDelay = 300 * 1000; //(ms) don't recreate a recently closed URL
const cleanRecentTabsInterval = recreateDelay * 10; // (ms) interval between cleaning recent tabs
const cleanRecycleInterval = 3600 * 1000; // (ms) interval between cleaning recycle info
const recycleDuration = 3600 * 3 * 1000; // (ms) recycle info expires if no update for a while
const timeOfStart = Date.now();

var syncingAllowed = false; // indicates if the syncing is started internally (listeners are on)
var syncTriggerListenersAdded = false; // an indicator used by the last two functions (handling listeners) so they don't register duplicate listeners
var normalWindowPresent = false;
var browserActionIcon = "none";

var allTabsHaveCompletedLoading = true;
var inSyncFunctionLock = false; // indicates if one of the two (from/to sync storage) functions is executing right now
var doMergeWhenPossible = false;

var recentTabs = {}; // URL -> closed time
var recycledTabs = {}; // URL -> tab items

var machineId; // unique identifier of this machine
var syncAllTabs; // indicates whether to sync all tabs ('syncAll' in storage.sync is true)
var autoSyncEnabled; // indicates if the user has enabled syncing ('autoSyncEnabled' in storage.local is true)
var tabMap = {}; // tab id -> {updateTime, url, originalUrl, source}
var sourceSyncTimes; // source machine id -> last sync time
var destSyncTimes; // dest machine id -> last sync time

//note: default values must be consistent with popup.js.
const settings = {
	// variables in storage
	machineId: {
		storage: chrome.storage.local,
		set: function (value) {
			machineId = value;
		},
		defValue: Math.random().toString(36).slice(2),
	},
	autoSyncEnabled: {
		storage: chrome.storage.local,
		set: setAutoSync,
		defValue: false,
	},
	syncAll: {
		storage: chrome.storage.sync,
		set: function (value) {
			syncAllTabs = value;
		},
		defValue: true,
	},
	sourceSyncTimes: {
		storage: chrome.storage.local,
		set: function (value) {
			sourceSyncTimes = value;
		},
		defValue: {},
	},
	destSyncTimes: {
		storage: chrome.storage.local,
		set: function (value) {
			destSyncTimes = value;
		},
		defValue: {},
	},
	tabMap: {
		storage: chrome.storage.local,
		set: recycleTabs,
		defValue: {},
	},
};

const debuggingMode = true;
var debug = function () {};
if (debuggingMode) {
	debug = chrome.extension.getBackgroundPage().console.log;
}

debug("-----Starting up-----");

//========Program startup==============
initSettings(function () {
	initTabsFromRecycled(function () {
		updateNormalWindowPresent(function () {
			updateSyncAllowedState();
		});
	});
});

initPeriodicRun(cleanRecentTabs, cleanRecentTabsInterval);
initPeriodicRun(cleanRecycle, cleanRecycleInterval);

//Default event listeners
chrome.runtime.onStartup.addListener(handleStartup);
chrome.runtime.onInstalled.addListener(handleInstalled);

chrome.windows.onCreated.addListener(handleWindowCreated);
chrome.windows.onRemoved.addListener(handleWindowRemoved);

chrome.extension.onMessage.addListener(handleMessage);

//==========Function definitions==============
//-----------Sync event listeners-----------
function addSyncTriggerListeners() {
	if (syncTriggerListenersAdded) {
		return;
	}

	debug("Adding autosync listeners");
	// Add storage change event listener
	chrome.storage.onChanged.addListener(handleStorageChange);
	//Add tab removed/created/updated event listeners
	chrome.tabs.onCreated.addListener(handleTabCreated);
	chrome.tabs.onUpdated.addListener(handleTabUpdated);
	chrome.tabs.onRemoved.addListener(handleTabRemoved);
	chrome.webRequest.onBeforeRedirect.addListener(
		handleRedirect,
		{ urls: ["http://*/*", "https://*/*"] },
		[]
	);

	syncTriggerListenersAdded = true;
}

function removeSyncTriggerListeners() {
	if (syncTriggerListenersAdded) {
		debug("Removing autosync listeners");
		// Remove storage change event listener
		chrome.storage.onChanged.removeListener(handleStorageChange);
		// Stop tab and windows event listeners
		chrome.tabs.onCreated.removeListener(handleTabCreated);
		chrome.tabs.onUpdated.removeListener(handleTabUpdated);
		chrome.tabs.onRemoved.removeListener(handleTabRemoved);
		chrome.webRequest.onBeforeRedirect.removeListener(handleRedirect);
	}

	syncTriggerListenersAdded = false;
}

//-----------Window events handlers-----------
function handleWindowCreated(window) {
	debug("[chrome.windows.onCreated] Window type: ", window.type);

	if (window.type === "normal") {
		normalWindowPresent = true;
		updateSyncAllowedState();
	}
}

function handleWindowRemoved() {
	debug("[chrome.windows.onRemoved]");

	updateNormalWindowPresent(function () {
		updateSyncAllowedState();
	});
}

//-----------Settings getters and setters-----------
function initSettings(callback) {
	function initVar(name, c) {
		settings[name].storage.get(name, function (data) {
			if (data[name]) {
				debug("[init]", name, ":", data[name]);
				settings[name].set(data[name]);
				if (c && typeof c === "function") {
					c();
				}
			} else {
				debug("[init]", name, ":", settings[name].defValue);
				setSetting(name, settings[name].defValue, false, c);
			}
		});
	}

	function initVars(names, c) {
		let name = names.shift();
		if (names.length > 0) {
			initVar(name, function () {
				initVars(names, c);
			});
		} else {
			initVar(name, c);
		}
	}

	initVars(Object.keys(settings), callback);
}

function setSetting(name, value, update, callback) {
	let items = {};
	items[name] = value;
	settings[name].storage.set(items, function () {
		debug("[setSetting]", name, ":", value);
		settings[name].set(value);
		if (update) {
			updateSyncAllowedState();
		}
		if (callback && typeof callback === "function") {
			callback();
		}
	});
}

function setAutoSync(value) {
	autoSyncEnabled = value;

	if (autoSyncEnabled) {
		//Listeners are always on if the user has enabled syncing
		addSyncTriggerListeners();
		doMergeWhenPossible = true;
	} else {
		removeSyncTriggerListeners();
	}

	updateBrowserIcon();
}

function recycleTabs(oldTabMap) {
	for (tabId in oldTabMap)
		recycleTab(oldTabMap[tabId]);
}

function recycleTab(item) {
	if (item && item.url && !shouldIgnoreUrl(item.url)) {
		if (!recycledTabs[item.url]) {
			recycledTabs[item.url] = [];
		}
		recycledTabs[item.url].push(item);
	}
}

function reuseRecycledTab(tab) {
	if (tab.url && recycledTabs[tab.url] && recycledTabs[tab.url].length > 0) {
		tabMap[tab.id] = recycledTabs[tab.url].shift();
		if (recycledTabs[tab.url].length === 0) {
			delete recycledTabs[tab.url];
		}
		debug(
			"[reuseRecycledTab] tabId",
			tab.id,
			"uses recycled tab:",
			tabMap[tab.id]
		);
	}
}

const getQueryInfo = () => (syncAllTabs) ? {} : { pinned: true };

//-----------Extension events handlers-----------
function handleMessage(message) {
	debug(`[handleMessage] Message: ${message}`);

	switch (message) {
		case "start":
			setSetting("autoSyncEnabled", true, true);
			break;
		case "stop":
			setSetting("autoSyncEnabled", false, true);
			break;
		case "syncAll":
			setSetting("syncAll", true, true);
			break;
		case "syncPinned":
			setSetting("syncAll", false, true);
			break;
		case "saveTabs":
			saveTabs();
			break;
		case "restoreTabs":
			restoreTabs();
			break;
	}
}

function handleStartup() {
	debug("[chrome.runtime.onStartup]");
}

function handleInstalled(details) {
	debug("[chrome.runtime.onInstalled] Reason: ", details.reason);
}

function handleStorageChange(changes, areaname, callback) {
	processSyncAllChange(changes, function () {
		processSyncRecordChange(changes, callback);
	});
}

function processSyncAllChange(changes, callback) {
	if (changes.syncAll) {
		//skip if there's no item syncAll in the changes
		debug(
			"[processSyncAllChange] syncAll",
			changes.syncAll.oldValue,
			"->",
			changes.syncAll.newValue
		);
		setSetting("syncAll", changes.syncAll.newValue, true, callback);
		return;
	}
	if (callback && typeof callback === "function") {
		callback();
	}
}

function processSyncRecordChange(changes, callback) {
	if (changes.syncRecord) {
		//skip if there's no item syncRecord in the changes
		let syncRecord = uncompressRecord(changes.syncRecord.newValue); //storage.onChanged returns the old and new storage values
		if (!syncRecord || !syncRecord.tabs || syncRecord.tabs.length === 0) {
			debug("[processSyncRecordChange] syncRecord: false. Returning.");
		} else if (syncRecord.machineId === machineId) {
			debug(
				"[processSyncRecordChange] skipping storage change from self"
			);
		} else {
			runInSync("processSyncRecordChange", callback, function (c) {
				// Stop tab and windows events while applying changes

				updateTabsFromRecord(syncRecord, c);
			});
			return;
		}
	}
	if (callback && typeof callback === "function") {
		callback();
	}
}

//Tabs event handlers
function handleTabCreated(tab) {
	debug(
		"[handleTabCreatedEvent] id:",
		tab.id,
		"url:",
		tab.url,
		"pending:",
		tab.pendingUrl,
		"tab:",
		tab
	);
	if (!tab.pendingUrl && tab.status == "unloaded") {
		reuseRecycledTab(tab);
	}
	allTabsHaveCompletedLoading = false;
}

//here we handle several special cases when a tab updates:
//- For automatic redirection, including server-side redirection (i.e. 3xx redirection) and
//  client-side redirection (i.e. javascript redirection), we need to identify the original
//  url and use it as originalUrl (aka canonical). This is important because redirection is
//  often part of authentication, meaning the same originalUrl may result in different urls
//  in different machines.
//- When user navigates within the same page, i.e. only hashtag changes, syncing across
//  machines and closing/creating tabs would be confusing to user.
function handleTabUpdated(tabId, changes, tab) {
	if (changes.status === "loading") {
		processTabLoading(tabId, tab);
	} else if (changes.status === "complete") {
		processTabComplete(tabId, tab);
	}
}

function processTabLoading(tabId, tab) {
	debug(`[processTabLoading] loading - tabId: ${tabId} URL: ${tab.url}`);
	let item = getTabItem(tabId);
	if (!item.redirectUrl) {
		// client-side redirection may occur now or later
		if (
			item.originalUrl &&
			item.updateTime &&
			Date.now() - item.updateTime < redirectDelay
		) {
			item.redirectUrl = item.originalUrl;
			item.assumedRedirect = true;
			debug(`[processTabLoading] tabId: ${tabId} assumed redirection: ${item.redirectUrl}`);
		} else {
			item.redirectUrl = tab.url;
			debug(`[processTabLoading] tabId: ${tabId} potential redirection: ${item.redirectUrl}`);
		}
	}
	allTabsHaveCompletedLoading = false;
}

function processTabComplete(tabId, tab) {
	debug(`[processTabComplete] complete - tabId: ${tabId} URL: ${tab.url}`);
	let item = getTabItem(tabId);

	//now that this page is completed, calculate its server-side redirection, if any.
	if (!item.redirectUrl && item.redirects) {
		// client-side redirection takes precedence
		let url = tab.url;
		while (url in item.redirects) {
			url = item.redirects[url];
		}
		if (url !== tab.url && !shouldIgnoreUrl(url)) {
			debug(`[processTabComplete] tracked server-side redirection source for tabId ${data.tabId} : ${url}`);
			item.redirectUrl = url;
		}
	}

	//calculate original url
	if (!item.url) {
		// first URL in this tab
		if (!item.originalUrl && item.redirectUrl && !shouldIgnoreUrl(item.redirectUrl)) {
			//no originalUrl previously set; use redirectUrl as its canonical value
			item.originalUrl = item.redirectUrl;
		}
	} else if (item.url !== tab.url) {
		//tab URL changed from previously observed value
		if (stripHashTag(item.url) === stripHashTag(tab.url)) {
			//user is navigating within the same page
			debug(`[processTabComplete] tabId: ${tabId} ignore plain hashtag change`);
			if (!item.originalUrl) {
				item.originalUrl = item.url; // track navigations within the same page back to one canonical URL
			}
		} else if (item.assumedRedirect) {
			//user navigated to another page
			debug(`[processTabComplete] tabId: ${tabId} assumed redirection ${item.url} -> ${tab.url}`);
		} else {
			//user navigated to another page
			debug(`[processTabComplete] tabId: ${tabId} assumed manual navigation ${item.url} -> ${tab.url}`);
			trackRecentTab([item.originalUrl, item.url]); // track the replaced URL
			delete item.source;
			if (item.redirectUrl && !shouldIgnoreUrl(item.redirectUrl)) {
				//use redirectUrl as canonical
				item.originalUrl = item.redirectUrl;
			} else {
				delete item.originalUrl;
			}
		}
	}

	item.updateTime = Date.now();
	item.url = tab.url;
	debug(`[processTabComplete] tabId: ${tabId} complete with URL: ${tab.url} original: ${item.originalUrl}`);
	delete item.redirectUrl;
	delete item.assumedRedirect;
	delete item.redirects;
	updateIfAllTabsAreComplete();
}

function handleTabRemoved(tabId, info) {
	debug(`[handleTabRemovedEvent] tabId: ${tabId} isWindowClosing: ${info.isWindowClosing}`);
	if (info.isWindowClosing) {
		recycleTab(tabMap[tabId]);
	} else {
		if (tabId in tabMap) {
			let item = tabMap[tabId];
			debug(`[handleTabRemovedEvent] tab removed: ${item}`);
			if (!item.deleting) {
				// only track manual deletion
				trackRecentTab([item.originalUrl, item.redirectUrl, item.url]);
			}
			delete tabMap[tabId];
		}
		updateIfAllTabsAreComplete();
	}
}

function handleRedirect(data) {
	debug(`[handleRedirect] detected server-side redirection: tabId: ${data.tabId,data.url} -> ${data.redirectUrl}`);
	let item = getTabItem(data.tabId);
	if (!item.redirects) {
		item.redirects = {};
	}
	item.redirects[data.redirectUrl] = data.url; // dest -> source
}

//-----------Sync functions-----------

function updateNormalWindowPresent(callback) {
	chrome.windows.getAll({ populate: false }, function (windows) {
		normalWindowPresent = false;

		for (let w = 0; w < windows.length; w++) {
			if (windows[w].type === "normal") {
				normalWindowPresent = true;
			}
		}
		if (callback && typeof callback === "function") {
			callback();
		}
	});
}

function updateSyncAllowedState(callback) {
	if (!updateSyncAllowedState.locked) {
		updateSyncAllowedState.locked = true;

		debug(`[updateSyncAllowedState] normalWindowPresent: ${normalWindowPresent} (should be true)`);
		if (!normalWindowPresent) {
			//Check for a normal window
			disallowSyncing();
		} else {
			debug(`[updateSyncAllowedState] allTabsHaveCompletedLoading: ${allTabsHaveCompletedLoading} (should be true)`);
			if (allTabsHaveCompletedLoading) {
				//Check if there are tabs still loading (significant for the initial call only?)
				allowSyncing();

				if (doMergeWhenPossible) {
					restoreTabs(callback);
					doMergeWhenPossible = false;
				}
			}
		}

		updateSyncAllowedState.locked = false;
	}
	if (callback && typeof callback === "function") {
		callback();
	}
}

function updateTabsFromRecord(syncRecord, callback) {
	debug(`[updateTabsFromRecord] tabs from record: ${printSyncRecord(syncRecord)}`);

	if (syncRecord.machineId === machineId) {
		debug("[updateTabsFromRecord] ignore our own update");
		if (callback && typeof callback === "function") {
			callback();
		}
		return;
	}

	diffCurrentTabsTo(
		syncRecord.tabs,
		function (additionalTabs, missingTabs, allCurrentTabs) {
            let tabCount = allCurrentTabs.length;
            sourceSyncTimes[syncRecord.machineId] = syncRecord.time;
            let syncTime = getSyncTime(syncRecord);

            tabCount += createTabs(additionalTabs);
            removeTabs(missingTabs, syncRecord.machineId, syncTime, tabCount);
			

			if (callback && typeof callback === "function") {
				callback();
			}
		}
	);
}

function createTabs(tabs) {
	let numCreated = 0;
	let now = Date.now();
	for (let l = 0; l < tabs.length; l++) {
		let url = tabs[l].url;
		let source = tabs[l].source;
		if (shouldIgnoreUrl(url)) {
			debug(`[createTabs] Skipping empty tab found in syncRecord: ${url}`);
		} else if (source === machineId) {
			debug(`[createTabs] Skipping tab originally created in this machine: ${url}`);
		} else if (recentTabs[url] && now - recentTabs[url] < recreateDelay) {
			debug(`[createTabs] Skipping tab recently closed in this machine: ${url} closed at ${printTime(recentTabs[url])}`);
		} else {
			debug(`[createTabs] Creating tab: ${url}`);
			chrome.tabs.create({ url: url, active: false, pinned: tabs[l].pinned }, function (tab) {
				debug(`[createTabs] Created tab: ${tab.id} originalUrl: ${url} source: ${source}`);
				let item = getTabItem(tab.id);
				item.originalUrl = url;
				item.source = source;
			});
			numCreated++;
		}
	}
	return numCreated;
}

function removeTabs(tabs, source, syncTime, tabCount) {
	//in the first few seconds don't remove more than one tab at a time, because syncing may not be
	//ready yet, and since there's no API to detect that we just wait
	if (tabs.length === 1 || Date.now() - timeOfStart > startDuration) {
		for (let l = 0; l < tabs.length; l++) {
			let tab = tabs[l];
			let item = getTabItem(tab.id);
			debug(`[removeTabs] Removing tab: ${tab.id} ${tab.url} ${item}`);

			let updateTime = timeOfStart; // keep tabs created in previous session or before this extension was enabled.
			if (item.updateTime) {
				updateTime = item.updateTime;
			}

			// do not remove this tab if:
			// - the machine issuing the sync record is not the source of this tab, and
			// - the issuing machine is not aware of this machine, or this tab is not known
			// (i.e. synced) to the issuing machine.
			if ((!item.source || item.source !== source) && (!syncTime || syncTime < updateTime)) {
				debug(`[removeTabs] Skip removing tab: ${tab.id} ${tab.url} from ${source} updated at ${printTime(updateTime)}`);
			} else {
				// should remove this tab
				item.deleting = true; // mark deletion caused by sync
				if (--tabCount > 0) {
					chrome.tabs.remove(tab.id);
					debug(`[removeTabs] Removed tab: ${tab.id} ${tab.url}`);
				} else {
					//it's the last tab - create a new blank tab so chrome doesn't close
					chrome.tabs.create(
						{ url: "chrome://newtab", active: false },
						() => {
							chrome.tabs.remove(tab.id);
							debug(`[removeTabs] Removed tab:", ${tab.id}, ${tab.url} (last tab)`);
						}
					);
				}
			}
		}
	}
}

function initTabsFromRecycled(callback) {
	chrome.tabs.query(getQueryInfo(), function (currentTabs) {
		for (let j = 0; j < currentTabs.length; ++j) {
			reuseRecycledTab(currentTabs[j]);
		}
		if (callback && typeof callback === "function") {
			callback();
		}
	});
}

function saveTabs(callback) {
    debug(`[saveTabs] action triggered`);

	runInSync("updateStorageFromTabs", callback, function (c) {
		chrome.storage.sync.get("syncRecord", (data) => {
			// try to get synced tabs
			let record = (data && data.syncRecord) ? uncompressRecord(data.syncRecord) : null;
            
			if (!record || !record.tabs || record.tabs.length === 0) {
				updateStorageFromTabsDirectly(null, [], c); // if we have just installed the extension
			} else {
				updateStorageFromTabsDirectly(record.machineId, record.tabs, c); // save action
			}
		});
	});
}

function restoreTabs(callback) {
	debug("[restoreTabs] action triggered");

	runInSync("updateStorageFromTabs", callback, function (c) {
		chrome.storage.sync.get("syncRecord", (data) => {
			let record = (data && data.syncRecord) ? uncompressRecord(data.syncRecord) : null;

			if (!record || !record.tabs || record.tabs.length === 0) {
				updateStorageFromTabsDirectly(null, [], c); // if we have just installed the extension
			} else {
				//merge tabs; storage will be automatically updated later if needed
				updateTabsFromRecord(record, c);
			}
		});
	});
}

/**
 * @description	updates sync storage with current device tabs.
 * @param {string | null} device current device
 * @param {[]} tabs array of current tabs. each tab is a { url: string, pinned: bool }
 * @param {function} callback passthrough callback function
 */
// note: use syncTabs to calculate whether an update to storage is needed, i.e. whether there is diff to sync
function updateStorageFromTabsDirectly(device, tabs, callback) {
	debug(`[updateStorageFromTabsDirectly] comparing with ${tabs.length} tabs from ${device}`);
	diffCurrentTabsTo(
		tabs,
		function (additionalTabs, missingTabs, allCurrentTabs) {
			if (!allCurrentTabs) {
				debug("[updateStorageFromTabsDirectly] diffCurrentTabsTo ruturns undefined var-s . Returning.");
			} else if (!syncingAllowed) {
				//make a check closest to the actual sync
				debug("[updateStorageFromTabsDirectly] syncingAllowed: false. Returning.");
				//if there's no changes - don't write (=>don't invoke a 'storage changed' event)
			} else if (
				additionalTabs.length !== 0 ||
				missingTabs.length !== 0
			) {
				writeTabsWithDelay(allCurrentTabs, callback);
				return;
			} else {
				debug("[updateStorageFromTabsDirectly] No diff in stored and current tabs.");
				if (device != machineId) {
					//skip sync but need to track timestamp
					destSyncTimes[device] = Date.now();
				}
			}
			if (callback && typeof callback === "function") {
				callback();
			}
		}
	);
}

// note: throttle writes to storage
function writeTabsWithDelay(tabs, callback) {
	if (!writeTabsWithDelay.buffer) {
		writeTabsWithDelay.buffer = {};
	}
	let d = { tabs: tabs, time: Date.now(), callback: callback };
	scheduleRun(writeTabsWithDelay.buffer, d, writeDelay, function (data) {
		writeTabs(data.tabs, data.time, data.callback);
	});
}

function writeTabs(tabs, time, callback) {
	let record = {
		tabs: [],
		machineId: machineId,
		time: time,
		sourceTimes: sourceSyncTimes,
	};

	for (let t = 0; t < tabs.length; t++) {
		if (shouldIgnoreUrl(tabs[t].url)) {
			continue;
		}
		updateRecordWithTab(tabs[t], record);
	}

	chrome.storage.sync.set(
		{ syncRecord: compressRecord(record) },
		function () {
			let state = {
				tabMap: tabMap,
				sourceSyncTimes: sourceSyncTimes,
				destSyncTimes: destSyncTimes,
			};
			chrome.storage.local.set(state, function () {
				debug(
					"[writeTabs] tabs saved to sync:",
					printSyncRecord(record)
				);
				if (callback && typeof callback === "function") {
					callback();
				}
			});
		}
	);
}

function updateRecordWithTab(tab, record) {
	let item = getTabItem(tab.id);

    record.tabs.push(
        {
            url: (item.originalUrl) ? item.originalUrl : tab.url,
            pinned: tab.pinned,
            source: (item.source) ? source = item.source : machineId
        }
    );
}

// TODO: rewrite me!
function diffCurrentTabsTo(syncTabs, callback) {
	debug("[diffCurrentTabsTo]");

	let additionalTabs = (syncTabs) ? syncTabs.slice() : [];
	let missingTabs = [];
	let allCurrentTabs = [];

	// Get current tabs
	chrome.tabs.query(getQueryInfo(), function (currentTabs) {
		// debug("[diffCurrentTabsTo] chrome.tabs.query() returned: " + currentTabs);

		if (!currentTabs) {
			debug("Current tabs query returned none");
		} else if (currentTabs.length === 0) {
			debug("Current tabs query returned an empty array");
		} else {
			allCurrentTabs = currentTabs.slice(); // copy the array for later
			debug(`[diffCurrentTabsTo] currentTabs count: ${allCurrentTabs.length}`);

			// For all local tabs
			for (let t = 0; t < currentTabs.length; t++) {
				let curUrl = currentTabs[t].url;
				if (shouldIgnoreUrl(curUrl)) {
					currentTabs.splice(t, 1);
					t--; //object is removed => the one in its place is not inspected =>loop with the same index
					continue;
				}
				curUrl = normalizeUrl(curUrl);

				let originalUrl = "";
				if (
					tabMap[currentTabs[t].id] &&
					tabMap[currentTabs[t].id].originalUrl
				) {
					originalUrl = normalizeUrl(
						tabMap[currentTabs[t].id].originalUrl
					);
				}

				// For all sync tabs (those in the sync DB)
				for (let s = 0; s < additionalTabs.length; s++) {
					let syncUrl = normalizeUrl(additionalTabs[s]);
					if (syncUrl === curUrl || syncUrl === originalUrl) {
						//if we find the tab in sync - remove it from the sync and tabs lists
						additionalTabs.splice(s, 1);
						currentTabs.splice(t, 1);
						t--;
						break; //start the loop anew
					}
				} //next sync tab
			} //next local tab

			missingTabs = currentTabs.slice();

			debug(`diffCurrentTabsTo() ended: #additionalTabs = ${additionalTabs.length}, #missingTabs = ${missingTabs.length}`);
		}

		if (callback && typeof callback === "function") {
			callback(additionalTabs, missingTabs, allCurrentTabs);
		}
	});
}

// note: add delay to detect redirection; this also reduce duplicate calls during syncing.
function updateIfAllTabsAreComplete() {
	debug("[updateIfAllTabsAreComplete]");
	if (!updateIfAllTabsAreComplete.buffer) {
		updateIfAllTabsAreComplete.buffer = {};
	}
	scheduleRun(
		updateIfAllTabsAreComplete.buffer,
		{},
		redirectDelay,
		function (data) {
			debug("[updateIfAllTabsAreCompleteImmediately]");

			chrome.tabs.query(getQueryInfo(), (currentTabs) => {
				//return if no tabs are found
				if (!currentTabs) {
					debug("[updateIfAllTabsAreCompleteImmediately] currentTabs: false. Returning.");
					return;
				}
		
				//assume all tabs loading is complete
				allTabsHaveCompletedLoading = true;
				for (let t = 0; t < currentTabs.length; t++) {
					// if any tab loading is not completed, return (otherwise there would be overlapping events,
					// the merging on startup will be overridden , etc.)
					if (currentTabs[t].status === "loading") {
						debug(`[updateIfAllTabsAreCompleteImmediately] tab ${currentTabs[t].id} is still loading. Returning.`);
						allTabsHaveCompletedLoading = false;
						return;
					}
				}
		
				//update storage from the current tabs if the function has not yet returned
				saveTabs();
		
				//update the sync state and say the function is no longer running
				updateSyncAllowedState();
			});
		}
	);
}

//-----------Schedule functions-----------

//function runInSync( name, callback, runnable ) : invoke runnable(c) now or later when sync lock is available.
//IMPORTANT: runnable must call c() before exiting.
const runInSync = (function () {
	var queue = []; // queue of [runnable, callable] to run with sync lock
	var scheduled = false; // whether a next step has been scheduled

	function step() {
		scheduled = false;
		if (queue.length === 0) {
			debug("[runInSync] exhausted sync queue");
		} else if (inSyncFunctionLock) {
			debug("[runInSync] locked; skip this step.");
			scheduleNext();
		} else if (!allTabsHaveCompletedLoading) {
			debug("[runInSync] tabs are still loading; skip this step.");
			updateIfAllTabsAreComplete();
			scheduleNext();
		} else {
			let [name, runnable, callback] = queue.shift();
			if (!syncingAllowed) {
				debug("[runInSync] syncingAllowed: false. Returning.");
				if (callback && typeof callback === "function") {
					callback();
				}
				scheduleNext();
			} else {
				runAndScheduleNext(name, runnable, callback);
			}
		}
	}

	function scheduleNext() {
		if (!scheduled && queue.length > 0) {
			scheduled = true;
			setTimeout(step, stepDelay); // schedule the next step with delay
		}
	}

	function runAndScheduleNext(name, runnable, callback) {
		debug("[runInSync] locking for [", name, "]");
		inSyncFunctionLock = true;
		updateBrowserIcon();

		//note: ensure that finalize() is called in all situations so that
		//the lock is released and further steps may be attempted. In finalize(),
		//release lock early; later calls may throw exception.
		function finalize() {
			debug(
				"[runInSync] step done for [",
				name,
				"]. remaining:",
				queue.length
			);
			inSyncFunctionLock = false;
			updateBrowserIcon();
			if (callback && typeof callback === "function") {
				callback();
			}
			scheduleNext();
		}

		let succeeded = false;
		try {
			runnable(finalize);
			succeeded = true;
		} finally {
			if (!succeeded && inSyncFunctionLock) {
				finalize(); //this step failed; do not block further steps
			}
		}
	}

	return function (name, callback, runnable) {
		queue.push([name, runnable, callback]);
		scheduleNext();
	};
})();

//schedule a runnable to run with the specified data and delay.
//if new data is provided before the scheduled run starts, the new data overwrites
//the old data, but the scheduled time does not change.
function scheduleRun(buffer, data, delay, runnable) {
	debug(`[scheduleRun] delay = ${delay}`);
	function run() {
		if (buffer.data) {
			if (Date.now() - buffer.scheduleTime > delay) {
				data = buffer.data;
				buffer.data = null;
				runnable(data);
			} else {
				setTimeout(run, delay);
			}
		}
	}

	if (!buffer.data) {
		buffer.scheduleTime = Date.now();
		setTimeout(run, delay);
	}
	buffer.data = data; //overwrite purposefully
}

function initPeriodicRun(runnable, interval) {
	function run() {
		runnable();
		setTimeout(run, interval);
	}

	setTimeout(run, interval);
}

//-----------Update internal ready flag-----------
function allowSyncing() {
	if (syncingAllowed) {
		return;
	}

	debug("[allowSyncing]");
	syncingAllowed = true;
	updateBrowserIcon();
}

function disallowSyncing() {
	if (!syncingAllowed) {
		return;
	}

	debug("[disallowSyncing]");
	syncingAllowed = false;
	updateBrowserIcon();
}

//-----------Update browser icon-----------
function updateBrowserIcon(callback) {
	debug("[updateBrowserIcon]");

	if (inSyncFunctionLock) {
		if (browserActionIcon !== "yellow") {
			chrome.browserAction.setIcon({
				path: {
					19: "img/icon19yellow.png",
					38: "img/icon38yellow.png",
				},
			});
			browserActionIcon = "yellow";
		}
	} else if (autoSyncEnabled) {
		if (syncingAllowed) {
			if (browserActionIcon !== "green") {
				chrome.browserAction.setIcon({
					path: { 19: "img/icon19.png", 38: "img/icon38.png" },
				});
				browserActionIcon = "green";
			}
		} else {
			//syncing is not yet ready
			if (browserActionIcon !== "red") {
				chrome.browserAction.setIcon({
					path: { 19: "img/icon19red.png", 38: "img/icon38red.png" },
				});
				browserActionIcon = "red";
			}
		}
	} else {
		//user doesn't want sync
		if (browserActionIcon !== "grey") {
			chrome.browserAction.setIcon({
				path: { 19: "img/icon19grey.png", 38: "img/icon38grey.png" },
			});
			browserActionIcon = "grey";
		}
	}
}

//-----------Helper functions-----------

//return the last time the issuing machine of the given syncRecord sync from this machine
function getSyncTime(syncRecord) {
	let v = 0;
	if (syncRecord.sourceTimes[machineId]) {
		v = syncRecord.sourceTimes[machineId];
	}
	let t = destSyncTimes[syncRecord.machineId];
	if (t && v < t) {
		debug(`[getSyncTime] move syncTime for ${syncRecord.machineId} : ${printTime(v)} -> ${printTime(t)}`);
		v = t;
	}
	return v;
}

function getTabItem(tabId) {
	if (!tabMap[tabId]) {
		tabMap[tabId] = {};
	}
	return tabMap[tabId];
}

function trackRecentTab(urls) {
	for (let j = 0; j < urls.length; j++) {
		if (!shouldIgnoreUrl(urls[j])) {
			recentTabs[urls[j]] = Date.now();
			break;
		}
	}
}

function cleanRecentTabs() {
	let now = Date.now();
	for (let url in recentTabs) {
		if (now - recentTabs[url] > recreateDelay) {
			delete recentTabs[url];
		}
	}
}

function cleanRecycle() {
	function clean(dict, key) {
		if (
			!dict[key].updateTime ||
			Date.now() - dict[key].updateTime > recycleDuration
		) {
			delete dict[key];
		}
	}

	//clean recycled tabs
	for (let url in recycledTabs) {
		clean(recycledTabs, url);
	}

	//clean current tab map
	chrome.tabs.query(getQueryInfo(), function (currentTabs) {
		let seenIds = {};
		for (let j = 0; j < currentTabs.length; j++) {
			seenIds[currentTabs[j].id] = true;
		}
		for (let id in tabMap) {
			if (!seenIds[id]) {
				clean(tabMap, id);
			}
		}
	});
}
