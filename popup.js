/*
 * Real-Time Tab Sync
 *
 * Author: Petko Ditchev
 *
*/

const debuggingMode = true;
var debug = function(){};
if( debuggingMode ){ debug = chrome.extension.getBackgroundPage().console.log; }

window.onload = function(){
    // Get the on/off setting and adjust the toggle
    let get = function( storage, name, defValue, elementId, onclick ){
        storage.get( name, function( data ){
            let value = defValue;
            if( data && name in data ){ value = data[name]; }
            debug( "[popup]", name, ":", value );

            let toggle = document.getElementById(elementId);
            toggle.checked = value;
            toggle.onclick = onclick;
        });
    };

    //note: default values must be consistent with background.js.
    get( chrome.storage.local, "autoSyncEnabled", false, "power", toggleSync );
    get( chrome.storage.sync, "syncAll", true, "pinned", toggleTabs );

    document.getElementById("save_tabs_button").onclick = function(){
        chrome.extension.sendMessage("saveTabs");
    };
    document.getElementById("restore_tabs_button").onclick = function(){
        chrome.extension.sendMessage("restoreTabs");
    };
};

// This will send a message to background.js to turn on or off tab auto sync
function toggleSync(){
    let toggle = document.getElementById("power");

    if( toggle.checked ) {
        chrome.extension.sendMessage("start");
    } else {
        chrome.extension.sendMessage("stop");
    }
}

// This will send a message to background.js to sync all tabs or only pinned tabs
function toggleTabs(){
    let toggle  = document.getElementById("pinned");

    if( toggle.checked ){
        chrome.extension.sendMessage("syncAll");
    }else{
        chrome.extension.sendMessage("syncPinned");
    }
}
