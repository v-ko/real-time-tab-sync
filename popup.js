/*
 * Real-Time Tab Sync
 * 
 * Author: Petko Ditchev
 *
*/

window.onload = function() {
	// Get the on/off setting and adjust the text link
	chrome.storage.local.get( "power", function( data ) {
		var power = true;
		
		// The setting is set in background.js
		if( data && data.power === false ) {
			power = false;
		}

		var powerButton = document.getElementById("power");

		if( power ) {
			powerButton.innerHTML = "Turn Off";
		}
		
		// Set action to take when link is clicked
		powerButton.onclick = powerButtonOnClick;
	});
};

//
// This will send a message to background.js to turn on or off tab auto sync
// it will also change the link text
///////////////////////////////////////
function powerButtonOnClick() {
	chrome.storage.local.get( "power", function( data ) {
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

