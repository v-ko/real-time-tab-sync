/*
 * Real-Time Tab Sync
 * 
 * Author: Petko Ditchev
 *
*/

var debuggingMode = true;
window.onload = function(){
	// Get the on/off setting and adjust the text link
	chrome.storage.local.get( "power", function( data ){
		var power = true;
		
		// The setting is set in background.js
		if( data && data.power === false ) {
			power = false;
		}
		
		if( debuggingMode ){
		    debug( "[popup] power: ", power );
		}

		var powerToggle = document.getElementById("power");

		if( power ) {
			powerToggle.checked = true;
		}else{
		    powerToggle.checked = false;
		}
		
		// Set action to take when link is clicked
		powerToggle.onclick = powerButtonOnClick;
	});
	
	chrome.storage.sync.get( "syncAll", function( data ){
	    var syncAll = true;
	    if( data && data.syncAll === false ){
	        syncAll = false;
	    }
	    
	    if( debuggingMode ){
		    debug( "[popup] syncAll: ", syncAll );
		}
	    
		var tabsToggle = document.getElementById("pinned");
		
		if( syncAll ){
		    tabsToggle.checked = true;
		}else{
		    tabsToggle.checked = false;
		}
		
		tabsToggle.onclick = tabsButtonOnClick;
	});
	
	
};

//
// This will send a message to background.js to turn on or off tab auto sync
// it will also change the link text
///////////////////////////////////////
function powerButtonOnClick() {
	var powerToggle = document.getElementById("power");
	
	if( powerToggle.checked ) {
		chrome.extension.sendMessage("start");
	} else {
		chrome.extension.sendMessage("stop");
	}
}

function tabsButtonOnClick() {
    var tabsToggle  = document.getElementById("pinned");
    
    if( tabsToggle.checked ){
        chrome.extension.sendMessage("syncAll");
    }else{
        chrome.extension.sendMessage("syncPinned");
    } 
}

function debug() {
    if( debuggingMode ){
        chrome.extension.getBackgroundPage().console.log.apply( this, arguments );
    }
}

