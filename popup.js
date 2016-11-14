/*
 * Real-Time Tab Sync
 * 
 * Author: Petko Ditchev
 *
*/

window.onload = function(){
	// Get the on/off setting and adjust the text link
	chrome.storage.local.get( "power", function( data ){
		var power = true;
		
		// The setting is set in background.js
		if( data && data.power === false ) {
			power = false;
		}

		var powerToggle = document.getElementById("power");

		if( power ) {
			powerToggle.checked = "true";
		}
		
		// Set action to take when link is clicked
		powerToggle.onclick = powerButtonOnClick;
	});
	
	chrome.storage.sync.get( "syncAll", function( data ){
	    var syncAll = true;
	    if( data && data.syncAll === false ){
	        syncAll = false;
	    }
	    
		var tabsToggle = document.getElementById("pinned");
		
		if( syncAll ){
		    tabsToggle.checked = "true";
		}
		
		tabsToggle.onclick = tabsButtonOnClick;
	});
	
	
};

//
// This will send a message to background.js to turn on or off tab auto sync
// it will also change the link text
///////////////////////////////////////
function powerButtonOnClick() {
	chrome.storage.local.get( "power", function( data ){
		var power = true;
		if( data && data.power === false ) {
			power = false;
		}
		
		var powerButton = document.getElementById("power");
		
		if( power ) {
			chrome.extension.sendMessage("stop");
			powerButton.innerHTML = "Turn On";
		} else {
			chrome.extension.sendMessage("start");
			powerButton.innerHTML = "Turn Off";
		}
	});
}

function tabsButtonOnClick() {
    chrome.storage.local.get( "syncAll", function( data ){
        var syncAll = true;
        if( data && data.syncAll === false ){
            syncAll = false;
        }
        
        var tabsButton  = document.getElementById("pinned");
        
        if( syncAll ){
            chrome.extension.sendMessage("syncAll");
            tabsButton.innerHTML = "Sync all tabs";
        }else{
            chrome.extension.sendMessage("syncPinned");
            tabsButton.innerHTML = "Sync pinned tabs";
        } 
    });
}


