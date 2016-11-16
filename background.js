/*

  Real-Time Tab Sync
  Author: Petko Ditchev
  Contributor(s): Chris de Claverie
 
  ---------------------
  
  Tips about the code :
  
  - I put debug(s) in the start and end of functions,
  because most of the stuff is async and bugs emerge when some functions run together
  
  - Do not believe the console log about objects logged before the dev-tools are opened 
  (they could be reduced to Obejct[0] , while at runtime they were correct)

  ---------------------
  
  Basics of the algorithm :
  
  - I call the global variables representing some key conditions 'flags' (see ==Global variables== below).
  In most places where those change the updateSyncState() gets called . It sets syncingReady=true if all the conditions are met 
  and turns it off if some of the conditions aren't met (no 'normal' window is present etc.)
  I'm using flags because most of the stuff is asynchronous and the conventional do 1 , do 2 ; does not work.

  - Basically the listeners for tab changes and storage changes get registered , if the user has turned on the extension from the browserAction
  The handleStorageChange() and handleTab...Event() act upon said changes
  On most major functions (flag changes) the updateSyncState() and updateBrowserAction() get called

  - The tabs get stored as an URL array in the storage.sync 
  On the time of storing them the "syncTimeStamp" gets updated to UTC time (because when going offline chrome does not notify us)
  In order not to lose information when starting the extension or when the time stamps don't match (we've been offline for some time) 
  the tabs get merged, instead of replaced with the stored URLs 

  ---------------------
  
  Conditions (flags) needed for the sync functions to execute correctly (unfinished):

  - sync.storage.'power'==true
  - Flag: syncingActive
  - Event handler:


  ---------------------
  
  Test cases :
  
  - Fresh install
  - Update
  - On-off from the browserAction
  - Closing the normal window and leaving the dev-tools open (to test that tabs are not lost)
  - With and without preserving the browser session (the integrated Chrome option)
  
  ---------------------
  
*/


//========Global variables===========

var syncingReady    = false;  // indicates if the syncing is started internally (listeners are on)
var syncingActive     = false;  // indicates if the user has enabled syncing ('power' in storage.local is true)
var listenersAdded   = false;  // an indicator used by the last two functions (handling listeners) so they don't register duplicate listeners
var normalWindowPresent = false;  
var inSyncFunction      = false;  // indicates if one of the two (from/to sync storage) functions is executng right now
var browserActionIcon   = "none";
var debuggingMode       = true;

var time_of_start            = Date.now(); // for testing
var start_of_current_session = Date.UTC(); //those are for a mechanism to avoid syncing to some late syncStorageChanged sigals

var allTabsHaveCompletedLoading      = true;
var inUpdateIfAllTabsAreCompleteFunc = false; //another indicator to ensure only one instance of a function is running
var time_of_last_sync_from_current_session = start_of_current_session;

//========Program startup==============
// Check if the syncing is turned on by the user
chrome.storage.local.get( "power", function( data ) {
    debug("[chrome.storage.local.get('power')] Returned: ", data.power)

	if( data.power === true ){
		syncingActive = true;
		updateBrowserAction();
		updateSyncState();
	}else if( data.power === false ) {
		syncingActive = false;
		updateBrowserAction();
		updateSyncState();
	}else{
		activateSyncing(function(){
			updateSyncState();
		});
	} 
});



//========Default event handling==============
chrome.runtime.onStartup.addListener( handleStartup );
chrome.runtime.onInstalled.addListener( handleInstalled );
chrome.windows.onCreated.addListener( handleWindowCreated );
chrome.windows.onRemoved.addListener( handleWindowRemoved );
chrome.extension.onMessage.addListener( handleMessage )

function handleWindowCreated( window ){
    debug("[chrome.windows.onCreated] Window type: ", window.type);

    if( window.type === "normal" ){
        normalWindowPresent = true;
        updateSyncState();
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
        updateSyncState();
    });
}

function handleMessage( message ){
    debug("[chrome.extension.onMessage] Message: ", message);

    if( message === "start" ){
        activateSyncing(function(){
            updateSyncState();
        });

    }else if( message === "stop" ){
        deactivateSyncing(function(){
            updateSyncState();
        });
        
    }else if( message === "syncTabs" ){
        syncAllTabs(function(){
            updateSyncState();
        });
    }else if( message === "syncPinned" ){
        syncPinnedTabs(function(){
            updateSyncState();
        });
    }
}

function handleStartup() { //should be with callback
    debug("[chrome.runtime.onStartup]");

    windowIsPresent( function( window_is_present ){
        if( window_is_present ){
            normalWindowPresent = true;
            updateSyncState();
        }
    });
}

function handleInstalled( details )  { //should be with callback
    debug("[chrome.runtime.onInstalled] Reason: "+details.reason);

    windowIsPresent(function( window_is_present ){
        if( window_is_present ){
            normalWindowPresent = true;
            updateSyncState();
        }
    });
}



//--------------------------------------------------------------------------------










//=========Defining the functions=================

function windowIsPresent( callback ){
    var window_is_present = false;

    chrome.windows.getAll( {populate : false} , function( windows ){
        if( debuggingMode ){
            debug("[windowIsPresent] Windows returned: "+windows);
        }

        if( windows ){
            if( windows.length > 0 ){
                window_is_present = true;
            }
        }
        
        if( callback && typeof( callback ) === "function" ) { callback( window_is_present ); }
    });
}

//
// If the appropriate flags are up(/down) - start syncing. Otherwise stop syncing (internally).
///////////////////////////////////////////
function updateSyncState( callback ) {
    debug("[updateSyncState] syncingActive: ", syncingActive, " (should be true)");
    
	if( syncingActive ){ //Listeners are always on if the user has enabled syncing
		if( !listenersAdded ){ //if the flag is up , but the listeners are not added - do it
			addListeners();
		}
	}else{
		if( listenersAdded ){
			removeListeners(); 
		}
	}

	//Check for a normal window
    debug("[updateSyncState] normalWindowPresent: ", normalWindowPresent, " (should be true)");
    debug("[updateSyncState] inSyncFunction: ", inSyncFunction, " (should be false)");
    debug("[updateSyncState] syncingReady: ", syncingReady, " (should be true)");
        
	if( normalWindowPresent === false ){
	    if( syncingReady ){
			stopSyncing();
		}
		
		if( callback && typeof( callback ) === "function" ) { callback(); }
        //return;
	}else if( inSyncFunction ){ //Check for a lock by one of the sync functions - unlikely but might mess up things
		if( callback && typeof( callback ) === "function" ) { callback(); }
		
	}else if( !allTabsHaveCompletedLoading ){ //Check if there are tabs still loading
		if( callback && typeof( callback ) === "function" ) { callback(); }
		
    }else if( syncingActive ){ //don't try to put those two if-s in one again
        if( !syncingReady ) {
            startSyncing();
            mergeTabsFromSync(function(){
                if( callback && typeof( callback ) === "function" ) { callback(); }
            });
        }
    }else{ //syncing is disabled by the user
         stopSyncing();
    }

    if( callback && typeof( callback ) === "function" ) { callback(); }
	
}

function mergeTabsFromSync( callback ){
    debug("[mergeTabsFromSync()]");

	chrome.storage.sync.get( 'syncTabs', function( returnVal ) { //get synced tabs
	    debug("[mergeTabsFromSync] chrome.storage.sync.get('syncTabs') Returned: ", returnVal.syncTabs);
		
        if( inSyncFunction ){
            debug("[mergeTabsFromSync] inSyncFunction: ", true, ". Returning.")
            return;
        }else{
            inSyncFunction = true;
            updateBrowserAction();
        }

        if( !returnVal.syncTabs ){ //if it's a first start (or there's no 'syncTabs' key for some other reason)
            updateStorageFromTabs_directly(function(){
                inSyncFunction = false;
                updateBrowserAction();
                if( callback && typeof( callback ) === "function" ) { callback(); }
            });
        }else{ //If there is a 'syncTabs' key
            updateTabsFromStringList( returnVal.syncTabs.slice(), true, function(){ //merge (and not replace that's what the 'true' is for merging) from the syncTabs list
                updateStorageFromTabs_directly(function(){ //call an update (add merged local tabs)
                    inSyncFunction = false;
                    updateBrowserAction();
                    if( callback && typeof( callback ) === "function" ) { callback(); }
                });
            });
        }
	});
}

//
// Apply remote changes from sync storage (called on storage-changed-event)
///////////////////////////////////////////
function handleStorageChange( changes, areaname, callback ) {
	var do_merge = false;
	
    updateSyncState(function(){ //just to be sure. Too often there are simultanious events going on
        if( !syncingReady ) { //check if we're at all supposed to be active
            debug("[handleStorageChange] syncingReady: ", false, ". Returning");
            
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

        debug("[handleStorageChange] syncTabs: ", syncTabs, " (", syncTabs.length, ")");

        if( !inSyncFunction ){
            inSyncFunction = true;
            updateBrowserAction();

            // Stop tab and windows events while applying changes
            removeListeners();

            chrome.storage.sync.get( "syncTimeStamp", function( sync_time_stamp ){
                if( !sync_time_stamp ){
                    do_merge = true; //If it's some kind of fluke or first start play it safe
                }else if( sync_time_stamp < time_of_last_sync_from_current_session ){ //if it's some kind of a delayed/buggy update - merge
                    do_merge = true;
                }else{ //the received update is in real time, so use it to update, not merge
                    do_merge = false;
                }

                updateTabsFromStringList( syncTabs, do_merge, function(){
                    addListeners();
                    inSyncFunction = false;
                    updateBrowserAction();

                    //debug("handleStorageChange() ended.");
                    if( callback && typeof( callback ) === "function" ) { callback(); }
                    return;
                });
            });
        }else{ //If another sync function is running
            debug("[handleStorageChange] inSyncFunction: ", true, ". Returning.");
            
            if( callback && typeof( callback ) === "function" ) { callback(); }
            return;
        }
    });
	
}

//
// Worker function - makes the current tabs equal to the URL list given (does not touch URLs present in both lists - current and given tabs)
// Does not remove/readd events for itself , and does not set the inSyncFunction for itself (it's faster(=>safer) to set it outside)
///////////////////////////////
function updateTabsFromStringList( syncTabs, do_merge, callback ) {
    debug("[updateTabsFromStringList] syncTabs: ", syncTabs, " (", syncTabs.length, "), do_merge: ", do_merge);
	
	diffCurrentToStoredTabs( syncTabs, function( additionalTabs, missingTabs, allCurrentTabs, tabs_count ){
		if( !allCurrentTabs ){
            debug("[updateTabsFromStringList] diffCurrentToStoredTabs returned undefined var(s). Returning.");
			if( callback && typeof( callback ) === "function" ) { callback(); }
			return;
        }else if( !syncingReady ){ //make a check closest to the actual sync
            debug("[updateStorageFromTabs_directly] syncingReady: ", false, ". Returning.")
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
                debug("[updateTabsFromStringList] Creating tab: ", additionalTabs[l]);
				chrome.tabs.create( { url: additionalTabs[l], active : false } );
				tabs_count++;
			}
		
			if( !do_merge ){
				if( missingTabs.length === 1 || Date.now()+time_of_start > 8000 ){ //in the first 8 seconds don't remove more than one tab at a time , because syncing may not be ready yet , and sysnce there's no API to detect that we just wait
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

}//end updateTabsFromStringList()

//
// Save local changes to sync storage (called on tab-removed/updated/created-event)
/////////////////////////////////////////////// 
function updateStorageFromTabs( callback ) {
    debug("[updateStorageFromTabs]");

    updateSyncState(function(){ //just to be sure. Too often there are simultanious events going on
        if( !syncingReady ) {
            debug("[updateStorageFromTabs] syncingReady: ", false, ". Returning.");
            if( callback && typeof( callback ) === "function" ) { callback(); }
            return;
        }

        if( !inSyncFunction ){
            inSyncFunction = true;
            updateBrowserAction();

            removeListeners();
            updateStorageFromTabs_directly( function(){
                addListeners();
                inSyncFunction = false;
                updateBrowserAction();

                //debug("updateStorageFromTabs() ended.");
                if( callback && typeof( callback ) === "function" ) { callback(); }
            });
        }else{
            debug("[updateStorageFromTabs] inSyncFunction: ", true, ". Returning.");
            if( callback && typeof( callback ) === "function" ) { callback(); }
            return;
        }
    });
}

//
// Records the tabs' URLs into storage.sync (if necessary)
// Does not handle turning listeners on/off , and ommits some checks 
///////////////////////////////////////////
function updateStorageFromTabs_directly( callback ) {
    var tabsForSync = new Array();
	var syncTabs;
	
	// Get saved tabs
    chrome.storage.sync.get( 'syncTabs', function( returnVal ) { //that's an array of strings
		
		if( !returnVal.syncTabs ){
            debug("[updateStorageFromTabs_directly] returnVal.syncTabs: false. Creating an empty array.");
			syncTabs = new Array();
		}else{
			syncTabs = returnVal.syncTabs.slice( 0 ); //returnval is a key:value pair, we need only the value
            debug("[updateStorageFromTabs_directly] syncTabs: ", syncTabs, " (", syncTabs.length, ")");
		}
			
		diffCurrentToStoredTabs( syncTabs,function( additionalTabs, missingTabs, currentTabs2 ){
			if( !currentTabs2 ){
                debug("[updateStorageFromTabs_directly]diffCurrentToStoredTabs ruturns undefined var-s . Returning.");
				if( callback && typeof( callback ) === "function" ) { callback(); }
				return;
            //if there's no changes - don't write (=>don't invoke a 'storage changed' event)
            }else if( additionalTabs.length !== 0 || missingTabs.length !== 0 ) {
				for( var t = 0; t < currentTabs2.length; t++ ) {
					if( currentTabs2[t].url === "chrome://newtab/" ) {continue;} //don't mind the newtabs
					else if( currentTabs2[t].url.slice( 0, 18 ) === "chrome-devtools://" ) {continue;}//if the tab is some kind of dev tool - leave it alone
					else tabsForSync[t] = currentTabs2[t].url;
				}

                if( syncingReady ){ //make a check closest to the actual sync
                    chrome.storage.sync.set( {"syncTabs" : tabsForSync } , function() {
                        time_of_last_sync_from_current_session = Date.UTC();
                        chrome.storage.sync.set( {"syncTimeStamp" : Date.UTC() } , function() {
                            // Notify that we saved.
                            debug('[updateStorageFromTabs_directly] tabs saved to sync.', tabsForSync);
                            if( callback && typeof( callback ) === "function" ) { callback(); }
                        });
                    });
                }else{
                    debug("[updateStorageFromTabs_directly] syncingReady: ", false, ". Returning.")
                    if( callback && typeof( callback ) === "function" ) { callback(); }
                }

			}else{
                //debug(Date.now()-time_of_start,":","updateStorageFromTabs_directly() ended.");
				if( callback && typeof( callback ) === "function" ) { callback(); }
			}
		});
	});
}

//
// Worker function that gets current tabs and stored tabs (URLs) and returns the differences and the number of valid tabs (not ignored)
// returns (additionalTabs,missingTabs,allCurrentTabs,tabs_count)
///////////////////////////////////////////////
function diffCurrentToStoredTabs( syncTabs, callback ){ 
    debug("[diffCurrentToStoredTabs]");
	
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
        debug("[diffCurrentToStoredTabs] chrome.tabs.query(query_obj) returned: "+currentTabs);
        
		if( !currentTabs ){
			if( callback && typeof( callback ) === "function" ) { callback(); }
			return;
		}else if(currentTabs.length===0){
			if( callback && typeof( callback ) === "function" ) { callback(); }
			return;
		}else{
			currentTabs2 = currentTabs.slice(); //copy the array for later
			tabs_count   = currentTabs.length;
            debug("[diffCurrentToStoredTabs] currentTabs count: ", currentTabs2.length);
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
		
        //debug("diffCurrentToStoredTabs() ended.");
		if( callback && typeof( callback ) === "function" ) { callback( additionalTabs, missingTabs, currentTabs2, tabs_count ); }
		return;
		
	});
}

//
// Forward only the tab-completed updates to updateStorageFromTabs ,and only if there are no other tabs marked 'loading'
// handle...() --> updateIfAllTabsAreComplete() --> updateStorageFromTabs()
///////////////////////////////////////////////
function handleTabCreated( tab ){
    debug("[handleTabCreatedEvent] tab.id: ", tab.id);
	updateIfAllTabsAreComplete( tab.id );
}

function handleTabUpdated( tabId, changes ){
    debug("[handleTabUpdatedEvent] tabId: ", tabId, ", changes.status: ", changes.status);

	if( changes.status === "complete" ){	
		updateIfAllTabsAreComplete( tabId );
	}else{
		allTabsHaveCompletedLoading = false;
	}
}

function handleTabRemoved( tabId ){
    debug("[handleTabRemovedEvent]tabId=", tabId);
	updateIfAllTabsAreComplete( tabId );
}

function updateIfAllTabsAreComplete( tabIdToIgnore ){
    debug("[updateIfAllTabsAreComplete] tabIdToIgnore: ", tabIdToIgnore);

    if( inUpdateIfAllTabsAreCompleteFunc ){
        debug("[updateIfAllTabsAreComplete] inUpdateIfAllTabsAreCompleteFunc: ", true, ". Returning.");
        return;
	}else{
        inUpdateIfAllTabsAreCompleteFunc = true;
	}
	
	var query_obj = {}
	if( !syncAllTabs ){
	    query_obj = {"pinned": true};
	}
	
	chrome.tabs.query( query_obj, function( currentTabs ) { //query_obj filters if we want all tabs or only pinned tabs
		if( !currentTabs ){
            debug("[updateIfAllTabsAreComplete] currentTabs: ", false, ". Returning.");
            
            inUpdateIfAllTabsAreCompleteFunc = false;
			return;
		}
	
		allTabsHaveCompletedLoading = true; //assume true (false will be assigned if needed in the for loop below)
	
		for( var t = 0; t < currentTabs.length; t++ ){
			if( currentTabs.id !== tabIdToIgnore && currentTabs[t].status === "loading" ){ //if any other tab is not completed - return (otherwise there would be overlapping events , the merging on startup will be overridden , etc.)
                debug("[updateIfAllTabsAreComplete] A tab is still loading. Returning.");
                
				allTabsHaveCompletedLoading = false;
                inUpdateIfAllTabsAreCompleteFunc = false;
				return;
			}
		}
		
		if( syncingReady ){
			updateStorageFromTabs();
		}
		updateSyncState();
        inUpdateIfAllTabsAreCompleteFunc = false;
	});
}

//
// Functions to set the 'power' variable in storage.local 
///////////////////////////////////////
function activateSyncing( callback ){ 
    debug("[activateSyncing]");
	
	chrome.storage.local.set( { "power": true }, function(){
		syncingActive = true;
		updateBrowserAction();
		if( callback && typeof( callback ) === "function" ) { callback(); }
		return;
	});
}
function deactivateSyncing( callback ){
    debug("[deactivateSyncing]");
	
	chrome.storage.local.set( { "power": false }, function(){
		syncingActive = false;
		updateBrowserAction();
		if( callback && typeof( callback ) === "function" ) { callback(); }
		return;
	});
}

function syncAllTabs( callback ){
    debug("[syncAllTabs]");
    
    chrome.storage.sync.set( { "syncAllTabs": true }, function(){
        syncAllTabs = true;
        if( callback && typeof( callback ) === "function" ) { callback(); }
        return; 
    });
}

function syncPinnedTabs( callback ){
    debug("[syncPinnedTabs]");
    
    chrome.storage.sync.set( { "syncAllTabs": false }, function(){
        syncAllTabs = false;
        if( callback && typeof( callback ) === "function" ) { callback(); }
        return; 
    });
}

//
//Funtions to toggle the syncingReady. Listeners may be on, but startSyncing() gets called only
//when when all conditions are met ( see updateSyncState() )
//////////////////////////
function startSyncing(){ 
    debug("[startSyncing]");
    
	syncingReady = true;
	updateBrowserAction();
}
function stopSyncing(){ 
    debug("[stopSyncing]");
    
	syncingReady = false;
	updateBrowserAction();
}

//
// Changes the browserAction icon according to the flags
///////////////////////////////////
function updateBrowserAction( callback ){ 
    debug("[updateBrowserAction]");

	if( inSyncFunction ){
		if( browserActionIcon !== "yellow" ){
			chrome.browserAction.setIcon( { "path": {'19': 'icon19yellow.png', '38': 'icon38yellow.png' } } );
			browserActionIcon = "yellow";
		}
	}else if( syncingActive ){
		if( syncingReady ){
			if(browserActionIcon !== "green"){
				chrome.browserAction.setIcon( { "path": {'19': 'icon19.png', '38': 'icon38.png' } } );
				browserActionIcon = "green";
			}
		}else{ //syncing is stopped internally
			if( browserActionIcon !== "red" ){
				chrome.browserAction.setIcon( { "path": {'19': 'icon19red.png', '38': 'icon38red.png' } } );
				browserActionIcon = "red";
			}
		}
	}else{//user has stopped syncing
		if( browserActionIcon !== "grey" ){
			chrome.browserAction.setIcon( { "path": {'19': 'icon19grey.png', '38': 'icon38grey.png' } } );
			browserActionIcon = "grey";
		}
	}
}

//
// Functions to handle the listeners in bulk
//////////////////////////
function addListeners(){
	if( !listenersAdded ){
		// Add storage change event listener
		chrome.storage.onChanged.addListener( handleStorageChange );
		//Add tab removed/created/updated event listeners
		chrome.tabs.onCreated.addListener( handleTabCreated );
		chrome.tabs.onUpdated.addListener( handleTabUpdated );
		chrome.tabs.onRemoved.addListener( handleTabRemoved );	
	}
	listenersAdded = true;
}
function removeListeners(){
	if( listenersAdded ){
		// Remove storage change event listener
		chrome.storage.onChanged.removeListener( handleStorageChange );
		// Stop tab and windows event listeners
		chrome.tabs.onCreated.removeListener( handleTabCreated );
		chrome.tabs.onUpdated.removeListener( handleTabUpdated );
		chrome.tabs.onRemoved.removeListener( handleTabRemoved );
	}
	
	listenersAdded = false;
}

//
// Debugging and testing functions
/////////////////////////////////////
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
