/*

  Real-Time Tab Sync
  Author: Petko Ditchev
  Contributor(s): Chris de Claverie

  ---------------------

  Tips about the code :

  - The biggest hassle is the fact that chrome.storage.local
  functions (e.g. get()) execute async and the callbacks
  you give them may be executed after some other events have
  happened and changed the browser state. That's why the
  updateSyncAllowedState() gets called frequently and why there
  are a few function locks (and rich debug info). Frankly when
  I started writing the extension I'd written no JS what so
  ever and the async chrome API calls and weird one-threaded
  nature of JS made me write some spaghetti code just to get
  things working. The extension has seen some rework though and
  despite there still being a lot of room for improvement, I
  believe anyone willing to tweak it will get the hang of things
  easily.

  - Do not believe the console log about objects logged before
  the dev-tools are opened (they could be reduced to Obejct[0] ,
  while at runtime they were correct)

  ---------------------

  Test cases :

  - Fresh install
  - Update
  - On-off from the browserAction
  - Closing the normal window and leaving the dev-tools open
  (to test that tabs are not lost)
  - With and without preserving the browser session (the integrated
  Chrome option)

  ---------------------

  Local storage variables :

  syncTabs  : a list with the tabs' urls
  autoSyncEnabled   : whether the user wants its tabs synced or not
  syncAll : whether the user wants to sync all tabs or only pinned tabs
  syncTimeStamp : the timestamp of the last sync

*/


//========Global variables===========
var syncingAllowed      = false;  // indicates if the syncing is started internally (listeners are on)
var autoSyncEnabled       = false;  // indicates if the user has enabled syncing ('autoSyncEnabled' in storage.local is true)
var syncTriggerListenersAdded      = false;  // an indicator used by the last two functions (handling listeners) so they don't register duplicate listeners
var normalWindowPresent = false;
var inSyncFunctionLock  = false;  // indicates if one of the two (from/to sync storage) functions is executing right now
var browserActionIcon   = "none";
var debuggingMode       = true;
var syncAllTabs         = true;

var time_of_start            = Date.now();
var start_of_current_session = Date.UTC(); //those are for a mechanism to avoid syncing to some late syncStorageChanged sigals

var allTabsHaveCompletedLoading      = true;
var inUpdateIfAllTabsAreCompleteFuncLock = false; //indicator to ensure only one instance of a function is running
var time_of_last_sync_from_current_session = start_of_current_session;

var doMergeWhenPossible = false;

debug('-----Starting up-----')

//========Program startup==============
getAutosyncStateFromStore(function(){
    getSyncAllSetting(function(){
        updateBrowserIcon();
        updateSyncAllowedState();
    });
});


function getSyncAllSetting(callback){
    chrome.storage.local.get( "syncAll", function( data ){
        debug("[Startup] syncAll setting: ", data.syncAll)

        if (!data.syncAllTabs){
            chrome.storage.local.set({"syncAll": true}, updateSyncAllowedState);
            syncAllTabs = false;
        }

        syncAllTabs = data.syncAllTabs

        if( callback && typeof( callback ) === "function" ) { callback(autoSyncEnabled); }
    });
}
function getAutosyncStateFromStore(callback) {
    chrome.storage.local.get( "autoSyncEnabled", function( data ){
        debug("[Startup] autoSyncEnabled: ", data.autoSyncEnabled)

        if (!data.autoSyncEnabled){
            chrome.storage.local.set({"autoSyncEnabled": false}, updateSyncAllowedState);
            autoSyncEnabled = false;
        }else{
            doMergeWhenPossible = true
        }

        autoSyncEnabled = data.autoSyncEnabled

        if( callback && typeof( callback ) === "function" ) { callback(autoSyncEnabled); }
    });
};


//========Default event listeners==============
chrome.runtime.onStartup.addListener( handleStartup );
chrome.runtime.onInstalled.addListener( handleInstalled );
chrome.windows.onCreated.addListener( handleWindowCreated );
chrome.windows.onRemoved.addListener( handleWindowRemoved );
chrome.extension.onMessage.addListener( handleMessage );



//========Sync event listeners==============
function addSyncTriggerListeners(){

	if( syncTriggerListenersAdded | !autoSyncEnabled){
        return
	}

    debug('Adding autosync listeners')
    // Add storage change event listener
    chrome.storage.onChanged.addListener( handleStorageChange );
    //Add tab removed/created/updated event listeners
    chrome.tabs.onCreated.addListener( handleTabCreated );
    chrome.tabs.onUpdated.addListener( handleTabUpdated );
    chrome.tabs.onRemoved.addListener( handleTabRemoved );
    syncTriggerListenersAdded = true;
}

function removeSyncTriggerListeners(){
	if( syncTriggerListenersAdded ){
        debug('Removing autosync listeners')
		// Remove storage change event listener
		chrome.storage.onChanged.removeListener( handleStorageChange );
		// Stop tab and windows event listeners
		chrome.tabs.onCreated.removeListener( handleTabCreated );
		chrome.tabs.onUpdated.removeListener( handleTabUpdated );
		chrome.tabs.onRemoved.removeListener( handleTabRemoved );
	}

	syncTriggerListenersAdded = false;
}


//========Window events handlers==============
function handleWindowCreated( window ){
    debug("[chrome.windows.onCreated] Window type: ", window.type);

    if( window.type === "normal" ){
        normalWindowPresent = true;
        updateSyncAllowedState();
    }
}

function handleWindowRemoved(){
    debug("[chrome.windows.onRemoved]");

    chrome.windows.getAll( {populate : false} , function(windows){
        normalWindowPresent = false;

        for( var w = 0; w < windows.length; w++ ){
            if( windows[w].type === "normal" ){
                normalWindowPresent = true;
            }
        }
        updateSyncAllowedState();
    });
}


function setAutoSyncStateInStore(state, callback){
        chrome.storage.local.set( { "autoSyncEnabled": state }, function(){
            autoSyncEnabled = state;

            if( autoSyncEnabled ){ //Listeners are always on if the user has enabled syncing
                addSyncTriggerListeners();
                doMergeWhenPossible = true
            }else{
                removeSyncTriggerListeners();
            }

            updateBrowserIcon()

            if( callback && typeof( callback ) === "function" ) { callback(autoSyncEnabled); }
        });
}

//========Extension events handlers==============
function handleMessage( message ){
    debug("[handleMessage] Message: ", message);

    if( message === "start" ){
        setAutoSyncStateInStore( true , function(){
            updateSyncAllowedState();
        });

    }else if( message === "stop" ){
        setAutoSyncStateInStore( false , function(){
            updateSyncAllowedState();
        });

    }else if( message === "syncAll" ){
        chrome.storage.sync.set( { "syncAll": true }, function(){
            syncAllTabs = true;
            updateSyncAllowedState();
        });
    }else if( message === "syncPinned" ){
        chrome.storage.sync.set( { "syncAll": false }, function(){
            syncAllTabs = false;
            updateSyncAllowedState();
        });
    }
}

function handleStartup() { //should be with callback
    debug("[chrome.runtime.onStartup]");

    windowIsPresent( function( window_is_present ){
        if( window_is_present ){
            normalWindowPresent = true;
            updateSyncAllowedState();
        }
    });
}

function handleInstalled( details )  { //should be with callback
    debug("[chrome.runtime.onInstalled] Reason: ", details.reason);
    chrome.storage.local.set({"autoSyncEnabled": false}, function(){
	    autoSyncEnabled = false;
	    updateBrowserIcon();
	    updateSyncAllowedState();
    });

    chrome.storage.sync.set( { "syncAll": true }, function(){
        syncAllTabs = true;
        updateSyncAllowedState();
    });

    windowIsPresent(function( window_is_present ){
        if( window_is_present ){
            normalWindowPresent = true;
            updateSyncAllowedState();
        }
    });
}



//========Storage event handler==============
//TODO : take account for state variable change
function handleStorageChange( changes, areaname, callback ) {
	var do_merge = false;

    updateSyncAllowedState(function(){ //just to be sure. Too often there are simultanious events going on
        if( !syncingAllowed ) { //check if we're at all supposed to be active
            debug("[handleStorageChange] syncingAllowed: ", false, ". Returning");

            if( callback && typeof( callback ) === "function" ) { callback(); }
            return;
        }

        if( !changes.syncTabs ) { //skip if there's no item syncTabs in the changes
            debug("[handleStorageChange] changes.syncTabs: ", false, ". Returning.");

            if( callback && typeof( callback ) === "function" ) { callback(); }
            return;
        }

        var syncTabs = changes.syncTabs.newValue.slice(); //storage.onChanged returns the old and new storage values - leight copy the array
        if( !syncTabs ){
            debug("[handleStorageChange] syncTabs: ", false, ". Returning.");

            if( callback && typeof( callback ) === "function" ) { callback(); }
            return;
        }

        //commented because it actually bloats the debug log
        //debug("[handleStorageChange] syncTabs: ", syncTabs, " (", syncTabs.length, ")");

        if( !inSyncFunctionLock ){
            inSyncFunctionLock = true;
            updateBrowserIcon();

            // Stop tab and windows events while applying changes
            removeSyncTriggerListeners();

            chrome.storage.sync.get( "syncTimeStamp", function( sync_time_stamp ){
                if( !sync_time_stamp ){
                    do_merge = true; //If it's some kind of fluke or first start play it safe
                }else if( sync_time_stamp < time_of_last_sync_from_current_session ){ //if it's some kind of a delayed/buggy update - merge
                    do_merge = true;
                }else{ //the received update is in real time, so use it to update, not merge
                    do_merge = false;
                }

                updateTabsFromStringList( syncTabs, do_merge, function(){
                    addSyncTriggerListeners();
                    inSyncFunctionLock = false;
                    updateBrowserIcon();

                    //debug("handleStorageChange() ended.");
                    if( callback && typeof( callback ) === "function" ) { callback(); }
                    return;
                });
            });
        }else{ //If another sync function is running
            debug("[handleStorageChange] inSyncFunctionLock: ", true, ". Returning.");

            if( callback && typeof( callback ) === "function" ) { callback(); }
            return;
        }
    });

}


//========Tabs event handlers==============
function handleTabCreated( tab ){
    debug("[handleTabCreatedEvent] tab.id: ", tab.id);
	updateIfAllTabsAreComplete( tab.id );
}

function handleTabUpdated( tabId, changes, tab ){
	if( changes.status === "complete" ){
	    debug("[handleTabUpdated] tabId: ", tabId, ", changes: ", changes, ", URL: ", tab.url);
		updateIfAllTabsAreComplete( tabId );
	}else{
		allTabsHaveCompletedLoading = false;
	}
}

function handleTabRemoved( tabId ){
    debug("[handleTabRemovedEvent]tabId=", tabId);
	updateIfAllTabsAreComplete( tabId );
}


//=========Check if a window is present=================
function windowIsPresent( callback ){
    var window_is_present = false;

    chrome.windows.getAll( {populate : false} , function( windows ){
        if( debuggingMode ){
            debug("[windowIsPresent] Windows count: ", windows.length);
        }

        if( windows ){
            if( windows.length > 0 ){
                window_is_present = true;
            }
        }

        if( callback && typeof( callback ) === "function" ) { callback( window_is_present ); }
    });
}


//=========Sync functions=================
function updateSyncAllowedState( callback ) {

	//Check for a normal window
    debug("[updateSyncAllowedState] normalWindowPresent: ", normalWindowPresent, " (should be true)");
    if( normalWindowPresent === false ){
        disallowSyncing();

        if( callback && typeof( callback ) === "function" ) { callback(); }
        return
    }

    if( inSyncFunctionLock ){ //This could probably be removed
        if( callback && typeof( callback ) === "function" ) { callback(); }
        return
    }

    debug("[updateSyncAllowedState] allTabsHaveCompletedLoading: ", allTabsHaveCompletedLoading, " (should be true)");
    if( !allTabsHaveCompletedLoading ){ //Check if there are tabs still loading (significant for the initial call only?)
        if( callback && typeof( callback ) === "function" ) { callback(); }
        return
    }

     allowSyncing();

     if (doMergeWhenPossible){
         mergeTabsFromSync(callback);
         doMergeWhenPossible = false
     }

    if( callback && typeof( callback ) === "function" ) { callback(); }
}

function mergeTabsFromSync( callback ){
    debug("[mergeTabsFromSync]");

	chrome.storage.sync.get( 'syncTabs', function( returnVal ) { //get synced tabs

        if( inSyncFunctionLock ){
            debug("[mergeTabsFromSync] inSyncFunctionLock: ", true, ". Returning.")
            return;
        }

        inSyncFunctionLock = true;
        updateBrowserIcon();

        if( !returnVal.syncTabs ){ //if it's a first start (or there's no 'syncTabs' key for some other reason)
            updateStorageFromTabs_directly(function(){
                inSyncFunctionLock = false;
                updateBrowserIcon();
                if( callback && typeof( callback ) === "function" ) { callback(); }
            });
        }else{ //If there is a 'syncTabs' key
            updateTabsFromStringList( returnVal.syncTabs.slice(), true, function(){ //merge (and not replace that's what the 'true' is for merging) from the syncTabs list
                updateStorageFromTabs_directly(function(){ //call an update (add merged local tabs)
                    inSyncFunctionLock = false;
                    updateBrowserIcon();
                    if( callback && typeof( callback ) === "function" ) { callback(); }
                });
            });
        }
	});
}

function updateTabsFromStringList( syncTabs, do_merge, callback ) {
    debug("[updateTabsFromStringList] syncTabs length: ", syncTabs.length, ", do_merge: ", do_merge);

	diffCurrentTabsTo( syncTabs, function( additionalTabs, missingTabs, allCurrentTabs, tabs_count ){
		if( !allCurrentTabs ){
            debug("[updateTabsFromStringList] diffCurrentTabsTo returned undefined var(s). Returning.");
			if( callback && typeof( callback ) === "function" ) { callback(); }
			return;
        }else if( !syncingAllowed ){ //make a check closest to the actual sync
            debug("[updateTabsFromStringList] syncingAllowed: ", false, ". Returning.")
            if( callback && typeof( callback ) === "function" ) { callback(); }
            return;
        }

        //if there's one removed and one added - we assume it's an update
        if( additionalTabs.length === 1 && missingTabs.length === 1 && !do_merge ) {
            debug("[updateTabsFromStringList] Updating tab, id: ", missingTabs[0].id);
			chrome.tabs.update( missingTabs[0].id, { url: additionalTabs[0] , active : false } );
		}else{
			//Add tabs left in syncTabs (therefore not present)
			for( var l = 0; l < additionalTabs.length; l++ ) {
                if(additionalTabs[l] && additionalTabs[l]!=="chrome://newtab/"){
                    debug("[updateTabsFromStringList] Creating tab: ", additionalTabs[l]);
                    chrome.tabs.create( { url: additionalTabs[l], active : false } );
                    tabs_count++;
                }else{
                    debug("[updateTabsFromStringList] Skipping empty tab found in syncTabs: ",additionalTabs[l]);
                }
			}

			if( !do_merge ){
			    //in the first 8 seconds don't remove more than one tab at a time , because syncing may not be ready yet , and since there's no API to detect that we just wait
				if( missingTabs.length === 1 || Date.now()+time_of_start > 8000 ){
					//Remove tabs left in the local tabs array (not present in sync)
					for( var lt = 0; lt < missingTabs.length; lt++ ) {
                        debug("[updateTabsFromStringList] Removing tab: ", missingTabs[lt].url);

						if( tabs_count === 1 ){ //if it's the last tab - just make it blank so chrome doesnt close
							chrome.tabs.update( missingTabs[lt].id, { url: "chrome://newtab" } );
						}else{
							chrome.tabs.remove( missingTabs[lt].id );
						}
					}
				}
			}
		}

		if( callback && typeof( callback ) === "function" ) { callback(); }
	});

}

function updateStorageFromTabs( callback ) {
    debug("[updateStorageFromTabs]");

    updateSyncAllowedState(function(){ //just to be sure. Too often there are simultanious events going on
        if( !syncingAllowed ) {
            debug("[updateStorageFromTabs] syncingAllowed: ", false, ". Returning.");
            if( callback && typeof( callback ) === "function" ) { callback(); }
            return;
        }

        if( inSyncFunctionLock ){
            debug("[updateStorageFromTabs] inSyncFunctionLock: ", true, ". Returning.");
            if( callback && typeof( callback ) === "function" ) { callback(); }
            return;
        }

        inSyncFunctionLock = true;
        updateBrowserIcon();

        removeSyncTriggerListeners();
        updateStorageFromTabs_directly( function(){
            addSyncTriggerListeners();
            inSyncFunctionLock = false;
            updateBrowserIcon();

            if( callback && typeof( callback ) === "function" ) { callback(); }
        });
    });
}

function updateStorageFromTabs_directly( callback ) {
    var tabsForSync = new Array();
	var syncTabs;

    debug("[updateStorageFromTabs_directly]")

	// Get saved tabs
    chrome.storage.sync.get( 'syncTabs', function( returnVal ) { //that's an array of strings

		if( !returnVal.syncTabs ){
            debug("[updateStorageFromTabs_directly] returnVal.syncTabs: false. Creating an empty array.");
			syncTabs = new Array();
		}else{
			syncTabs = returnVal.syncTabs.slice( 0 ); //returnval is a key:value pair, we need only the value
		}

		diffCurrentTabsTo( syncTabs, function( additionalTabs, missingTabs, currentTabs2 ){
			if( !currentTabs2 ){
                debug("[updateStorageFromTabs_directly]diffCurrentTabsTo ruturns undefined var-s . Returning.");
				if( callback && typeof( callback ) === "function" ) { callback(); }
				return;

            //if there's no changes - don't write (=>don't invoke a 'storage changed' event)
            }else if( additionalTabs.length !== 0 || missingTabs.length !== 0 ) {
				for( var t = 0; t < currentTabs2.length; t++ ) {
					if( currentTabs2[t].url === "chrome://newtab/" ) {continue;} //don't mind the newtabs
					else if( currentTabs2[t].url.slice( 0, 18 ) === "chrome-devtools://" ) {continue;}//if the tab is some kind of dev tool - leave it alone
					else tabsForSync[t] = currentTabs2[t].url;
				}

                if( !syncingAllowed ){ //make a check closest to the actual sync
                    debug("[updateStorageFromTabs_directly] syncingAllowed: ", false, ". Returning.")
                    if( callback && typeof( callback ) === "function" ) { callback(); }
                    return

                }

                chrome.storage.sync.set( {"syncTabs" : tabsForSync } , function() {
                    time_of_last_sync_from_current_session = Date.UTC();
                    chrome.storage.sync.set( {"syncTimeStamp" : Date.UTC() } , function() {
                        // Notify that we saved.
                        debug('[updateStorageFromTabs_directly] tabs saved to sync.');
                        if( callback && typeof( callback ) === "function" ) { callback(); }
                        return
                    });
                });

			}else{
                debug("[updateStorageFromTabs_directly] No diff in stored and current tabs.");
                if( callback && typeof( callback ) === "function" ) { callback(); }
            }
		}); // diffCurrentTabsTo
	});// storage.sync.get
}

function diffCurrentTabsTo( syncTabs, callback ){
    debug("[diffCurrentTabsTo]");

	var additionalTabs = new Array();
	var missingTabs = new Array();
	var currentTabs2 = new Array();
	var tabs_count;
	var query_obj = {};
	if( !syncAllTabs ){
	    query_obj = {"pinned": true};
	}

	// Get current tabs
	chrome.tabs.query( query_obj , function (currentTabs) { //query_obj to choose all tabs or only pinned
        debug("[diffCurrentTabsTo] chrome.tabs.query(query_obj) returned: " + currentTabs);

		if( !currentTabs ){
			if( callback && typeof( callback ) === "function" ) { callback(); }
			return;
		}else if(currentTabs.length===0){
			if( callback && typeof( callback ) === "function" ) { callback(); }
			return;
		}else{
			currentTabs2 = currentTabs.slice(); //copy the array for later
			tabs_count   = currentTabs.length;
            debug("[diffCurrentTabsTo] currentTabs count: ", currentTabs2.length);
		}

		//For all local tabs
		for( var t = 0; t < currentTabs.length; t++ ) {
			if( currentTabs[t].url === "chrome://newtab/" ) { //ignore newtabs
				currentTabs.splice( t, 1 );
				tabs_count--;
				t--;//object is removed => the one in its place is not inspected =>loop with the same index
				continue;
			}

			var str = currentTabs[t].url;
			if( str.slice( 0, 18 ) === "chrome-devtools://" ){ //if the tab is some kind of dev tool - leave it alone
				currentTabs.splice( t, 1 );
				tabs_count--;
				t--;
				continue;
			}

			// For all sync tabs (those in the sync DB)
			for( var s = 0; s < syncTabs.length; s++ ) {
				var syncTab = syncTabs[s];

				if( syncTab === currentTabs[t].url ) {//if we find the tab in sync - remove it from the sync and tabs lists
					syncTabs.splice( s, 1 );
					currentTabs.splice( t, 1 );
					t--;
					break; //start the loop anew
				}
			}//next sync tab
		}//next local tab

		additionalTabs = syncTabs.slice();
		missingTabs = currentTabs.slice();

        debug("diffCurrentTabsTo() ended.");
		if( callback && typeof( callback ) === "function" ) { callback( additionalTabs, missingTabs, currentTabs2, tabs_count ); }
		return;

	});
}

function updateIfAllTabsAreComplete( tabIdToIgnore ){
    debug("[updateIfAllTabsAreComplete] tabIdToIgnore: ", tabIdToIgnore);

    //Do not run this function twice at the same time
    if( inUpdateIfAllTabsAreCompleteFuncLock ){
        debug("[updateIfAllTabsAreComplete] inUpdateIfAllTabsAreCompleteFuncLock: ", true, ". Returning.");
        return;
	}else{
        inUpdateIfAllTabsAreCompleteFuncLock = true;
	}

	//query the right tabs (all or only pinned ones)
	var query_obj = {}
	if( !syncAllTabs ){
	    query_obj = {"pinned": true};
	}

	//actually ask for them
	chrome.tabs.query( query_obj, function( currentTabs ) {

	    //return if no tabs are found
		if( !currentTabs ){
            debug("[updateIfAllTabsAreComplete] currentTabs: ", false, ". Returning.");

            inUpdateIfAllTabsAreCompleteFuncLock = false;
			return;
		}

	    //assume all tabs loading is complete
		allTabsHaveCompletedLoading = true;
		for( var t = 0; t < currentTabs.length; t++ ){
		    //if any tab loading is not completed, return (otherwise there would be overlapping events ,
            //the merging on startup will be overridden , etc.)
			if( currentTabs.id !== tabIdToIgnore && currentTabs[t].status === "loading" ){
                debug("[updateIfAllTabsAreComplete] A tab is still loading. Returning.");

				allTabsHaveCompletedLoading = false;
                inUpdateIfAllTabsAreCompleteFuncLock = false;
				return;
			}
		}

		//update storage from the current tabs if the function has not yet returned
		if( syncingAllowed ){
			updateStorageFromTabs();
		}

		//update the sync state and say the function is no longer running
		updateSyncAllowedState();
        inUpdateIfAllTabsAreCompleteFuncLock = false;
	});
}


//========Update internal ready flag==============
function allowSyncing(){
    if (syncingAllowed){
        return
    }

    debug("[allowSyncing]");
    syncingAllowed = true;
    updateBrowserIcon();
}

function disallowSyncing(){
    if (!syncingAllowed){
        return
    }

    debug("[disallowSyncing]");
	syncingAllowed = false;
	updateBrowserIcon();
}



//========Update browser icon==============
function updateBrowserIcon( callback ){
    debug("[updateBrowserIcon]");

	if( inSyncFunctionLock ){
		if( browserActionIcon !== "yellow" ){
			chrome.browserAction.setIcon( { "path": {'19': 'icon19yellow.png', '38': 'icon38yellow.png' } } );
			browserActionIcon = "yellow";
		}
	}else if( autoSyncEnabled ){
		if( syncingAllowed ){
			if(browserActionIcon !== "green"){
				chrome.browserAction.setIcon( { "path": {'19': 'icon19.png', '38': 'icon38.png' } } );
				browserActionIcon = "green";
			}
		}else{ //syncing is not yet ready
			if( browserActionIcon !== "red" ){
				chrome.browserAction.setIcon( { "path": {'19': 'icon19red.png', '38': 'icon38red.png' } } );
				browserActionIcon = "red";
			}
		}
	}else{//user doesn't want sync
		if( browserActionIcon !== "grey" ){
			chrome.browserAction.setIcon( { "path": {'19': 'icon19grey.png', '38': 'icon38grey.png' } } );
			browserActionIcon = "grey";
		}
	}
}



//========Debugging and testing functions==============
function printSyncTabs( i, callback ){
	chrome.storage.sync.get( 'syncTabs', function( tt ){
		debug(Date.now()-time_of_start, ":", tt.syncTabs);

		if( i > 1 ){printSyncTabs( i-1 );}
		else{if( callback && typeof( callback ) === "function" ) { callback(); }}
	});
}

function debug( ){
    if( debuggingMode ){
        chrome.extension.getBackgroundPage().console.log.apply( this, arguments );
    }
}
