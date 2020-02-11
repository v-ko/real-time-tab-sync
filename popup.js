/*
 * Real-Time Tab Sync
 *
 * Author: Petko Ditchev
 *
*/

var debuggingMode = true;
window.onload = function(){
	// Get the on/off setting and adjust the text link
	chrome.storage.local.get( "autoSyncEnabled", function( data ){
		var autoSyncEnabled = true;

		// The setting is set in background.js
		if( data && data.autoSyncEnabled === false ) {
			autoSyncEnabled = false;
		}

		if( debuggingMode ){
		    debug( "[popup] autoSyncEnabled: ", autoSyncEnabled );
		}

		var toggle = document.getElementById("power");

		if( autoSyncEnabled ) {
			toggle.checked = true;
		}else{
		    toggle.checked = false;
		}

		// Set action to take when link is clicked
		toggle.onclick = toggleSync;
	});

	chrome.storage.sync.get( "syncAll", function( data ){
	    var syncAll = true;
	    if( data && data.syncAll === false ){
	        syncAll = false;
	    }

	    if( debuggingMode ){
		    debug( "[popup] syncAll: ", syncAll );
		}

		var toggle = document.getElementById("pinned");

		if( syncAll ){
		    toggle.checked = true;
		}else{
		    toggle.checked = false;
		}

		toggle.onclick = toggleTabs;
	});

	var saveTabsButton = document.getElementById("save_tabs_button");
	var restoreTabsButton = document.getElementById("restore_tabs_button");
	saveTabsButton.onclick = handleSaveTabsButtonClick
	restoreTabsButton.onclick = handleRestoreTabsButtonClick
};

//
// This will send a message to background.js to turn on or off tab auto sync
// it will also change the link text
///////////////////////////////////////
function toggleSync() {
	var toggle = document.getElementById("power");

	if( toggle.checked ) {
		chrome.extension.sendMessage("start");
	} else {
		chrome.extension.sendMessage("stop");
	}
}

function toggleTabs() {
    var toggle  = document.getElementById("pinned");

    if( toggle.checked ){
        chrome.extension.sendMessage("syncAll");
    }else{
        chrome.extension.sendMessage("syncPinned");
    }
}

function handleSaveTabsButtonClick(){
	chrome.extension.getBackgroundPage().updateStorageFromTabs()
}

function handleRestoreTabsButtonClick(){
	chrome.extension.getBackgroundPage().mergeTabsFromSync()
}

function debug() {
    if( debuggingMode ){
        chrome.extension.getBackgroundPage().console.log.apply( this, arguments );
    }
}

