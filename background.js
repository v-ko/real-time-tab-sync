/*
 * Real-Time Tab Sync
 * 
 * Author: Petko Ditchev
 *
*/

//Tips about the code :
//I put console.log-s in the start and end of functions , because most of the stuff is async and bugs emerge when some func-s run together
//Do not believe the console log about objects logged before the dev-tools are opened (they could be reduced to Obejct[0] , while at runtime they were correct)

//Basics of the algorithm :
// I call the global variables representing some key conditions 'flags' (see ==Global variables== below).
// In most places where those change the updateSyncState() gets called . It sets syncingIsStarted=true if all the conditions are met 
// and turns it off if some of the conditions aren't met (no 'normal' window is present etc.)
// I'm using flags because most of the stuff is asynchronous and the conventional do 1 , do 2 ; does not work.

//Basically the listeners for tab changes and storage changes get registered , if the user has turned on the extension from the browserAction
//The updateTabsFromStorage() and handleTab...Event() act upon said changes
//On most major functions (flag changes) the updateSyncState() and updateBrowserAction() get called

//The tabs get stored as an URL array in the storage.sync 
//On the time of storing them the "syncTimeStamp" gets updated to UTC time (because when going offline chrome does not notify us)
//In order not to lose information when starting the extension or when the time stamps don't match (we've been offline for some time) 
//the tabs get merged, instead of replaced with the stored URLs 

//Test cases:
//Fresh install
//Update
//On-off from the browserAction
//Closing the normal window and leaving the dev-tools open (to test that tabs are not lost)

//========Global variables===========
var time_of_start=Date.now();//for testing
var syncingIsStarted=false; //indicates if the syncing is started internally (listeners are on)
var syncingIsActive=false; //indicates if the user has enabled syncing ('power' in storage.local is true)
var listenersAreAdded=false; //an indicator used by the last two functions (handling listeners) so they don't register duplicate listeners

var normalWindowPresent=false;
var allTabsHaveCompletedLoading=true;
var browserActionIcon="none";

var inSyncFunction=false;//indicates if one of the two (from/to sync storage) functions is executng right now
var inUpdateIfAllTabsAreCompleteFunc=false;//another indicator to ensure only one instance of a function is running

var start_of_current_session = Date.UTC();
var time_of_last_sync_from_current_session=start_of_current_session;

//========Program start==============

//-------Register the events that will trigger the startUp() function--------
chrome.runtime.onStartup.addListener( function() {
    console.log("[chrome.runtime.onStartup]");
	normalWindowPresent=true; //the startup event implies it
	updateSyncState();
});
chrome.runtime.onInstalled.addListener( function( details ) {
    console.log("[chrome.runtime.onInstalled]"+"Reason:"+details.reason);
    normalWindowPresent=true;
	updateSyncState();
});

//-------Register the events for the window changes-------------
//So that the sync is active only when there are normal windows active (other windows might be apps or the dev tools)
chrome.windows.onCreated.addListener( function(window){
    console.log("[chrome.windows.onCreated]Window type: "+window.type);

	if(window.type==="normal"){
		normalWindowPresent=true;
		updateSyncState();
	}
});
chrome.windows.onRemoved.addListener( function(){
    console.log("[chrome.windows.onRemoved]");
	
	chrome.windows.getAll( {populate : false} , function(windows){	
		normalWindowPresent=false; //assume there are no normal windows now
		
		for(var w=0;w<windows.length;w++){
			if(windows[w].type==="normal"){
				normalWindowPresent=true; //on a normal window - update the flag
			}
		}
		updateSyncState();
	});
});

//-----------Handling the messages from the poppup button (on-off switch)----------
chrome.extension.onMessage.addListener( function( message ) {
    console.log("[chrome.extension.onMessage]","Message:"+message)

	if( message === "start" ) {
		activateSyncing(function(){
			updateSyncState();	
		});
		
	}else if( message === "stop" ) {
		deactivateSyncing(function(){
			updateSyncState();		
		});
	}
});

//Check if the syncing is turned on by the user
chrome.storage.local.get( "power", function( data ) {
    console.log("[chrome.storage.local.get('power')]Returns:",data.power)

	if( data.power === true ){
		syncingIsActive=true;
		updateBrowserAction();
		updateSyncState();
	}else if( data.power === false ) {
		syncingIsActive=false;
		updateBrowserAction();
		updateSyncState();
	}else{
		activateSyncing(function(){
			updateSyncState();
		});
	} 
});

//=========Defining the functions=================

//
// If the appropriate flags are up(/down) - start syncing. Otherwise stop syncing (internally).
///////////////////////////////////////////
function updateSyncState( callback ) {

    console.log("[updateSyncState]syncingIsActive:"+syncingIsActive+" (should be true)")
	if(syncingIsActive){ //Listeners are always on if the user has enabled syncing
		if(!listenersAreAdded){ //if the flag is up , but the listeners are not added - do it
			addListeners();
		}
	}else{
		if(listenersAreAdded){
			removeListeners(); 
		}
	}

	//Check for a normal window
    console.log("[updateSyncState]normalWindowPresent="+normalWindowPresent+" (should be true)")
    console.log("[updateSyncState]inSyncFunction:"+inSyncFunction+" (should be false)")
    console.log("[updateSyncState]syncingIsStarted:"+syncingIsStarted+" (should be true)")
	if(normalWindowPresent===false){
		if(syncingIsStarted){
			stopSyncing();
		}
		if( callback && typeof( callback ) === "function" ) { callback(); }
        //return;
		
	}else if(inSyncFunction){ //Check for a lock by one of the sync functions - unlikely but might mess up things
		if( callback && typeof( callback ) === "function" ) { callback(); }
		
	}else if(!allTabsHaveCompletedLoading){ //Check if there are tabs still loading
		if( callback && typeof( callback ) === "function" ) { callback(); }
		
    }else if(syncingIsActive){ //don't try to put those two if-s in one again
        if(!syncingIsStarted) {
            startSyncing();
            mergeTabsFromSync(function(){
                if( callback && typeof( callback ) === "function" ) { callback(); }
            });
        }
    }else{//syncing is disabled by the user
         stopSyncing();
    }

    if( callback && typeof( callback ) === "function" ) { callback(); }
	
}//end updateSyncState

function mergeTabsFromSync( callback ){
    console.log("[mergeTabsFromSync()]");

	chrome.storage.sync.get( 'syncTabs', function( returnVal ) { //get synced tabs
        console.log("[mergeTabsFromSync]chrome.storage.sync.get( 'syncTabs')Returns:"+returnVal.syncTabs);
		
        if(inSyncFunction){
            console.log("[mergeTabsFromSync]inSyncFunction=true. Returning.")
            return;
        }else{
            inSyncFunction=true;
            updateBrowserAction();
        }

        if( !returnVal.syncTabs ){ //if it's a first start (or there's no 'syncTabs' key for some other reason)
            updateStorageFromTabs_directly(function(){
                inSyncFunction=false;
                updateBrowserAction();
                if( callback && typeof( callback ) === "function" ) { callback(); }
            });
        }else{ //If there is a 'syncTabs' key
            updateTabsFromStringList( returnVal.syncTabs.slice() ,true ,function(){ //merge (and not replace that's what the 'true' is for merging) from the syncTabs list
                updateStorageFromTabs_directly(function(){ //call an update
                    inSyncFunction=false;
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
function updateTabsFromStorage(changes,areaname,callback) {

	var do_merge=false;
	
    updateSyncState( function(){ //just to be sure. Too often there are simultanious events going on

        if(!syncingIsStarted) { //check if we're at all supposed to be active
            console.log("[updateTabsFromStorage]syncingIsStarted=false. Returning");
            if( callback && typeof( callback ) === "function" ) { callback(); }
            return;
        }

        console.log("[updateTabsFromStorage]changes.SyncTabs:"+changes.SyncTabs+"(there should be changes, else func returns)");
        if(!changes.syncTabs) {//skip if there's no item syncTabs in the changes
            if( callback && typeof( callback ) === "function" ) { callback(); }
            return;
        }

        var syncTabs = changes.syncTabs.newValue.slice(); //storage.onChanged returns the old and new storage values - leight copy the array

        if(!syncTabs){
            console.log("[updateTabsFromStorage] !syncTabs==true .Returning.");
            if( callback && typeof( callback ) === "function" ) { callback(); }
            return;
        }

        if(!inSyncFunction){
            inSyncFunction=true;
            updateBrowserAction();

            // Stop tab and windows events while applying changes
            removeListeners();

            chrome.storage.sync.get("syncTimeStamp" , function(sync_time_stamp){
                if(!sync_time_stamp){
                    do_merge = true; //If it's some kind of fluke or first start play it safe
                }else if( sync_time_stamp < time_of_last_sync_from_current_session ){ //if it's some kind of a delayed/buggy update - merge
                    do_merge = true;
                }else{ //the received update is in real time, so use it to update, not merge
                    do_merge = false;
                }

                updateTabsFromStringList(syncTabs,do_merge,function(){
                    addListeners();
                    inSyncFunction=false;
                    updateBrowserAction();

                    //console.log("updateTabsFromStorage() ended.");
                    if( callback && typeof( callback ) === "function" ) { callback(); }
                    return;
                });
            });
        }else{ //If another sync function is running
            console.log("[updateTabsFromStorage] inSyncFunction==true . Returning.");
            if( callback && typeof( callback ) === "function" ) { callback(); }
            return;
        }
    });
	
}

//
//Worker function - makes the current tabs equal to the URL list given (does not touch URLs present in both lists - current and given tabs)
//Does not remove/readd events for itself , and does not set the inSyncFunction for itself (it's faster(=>safer) to set it outside)
///////////////////////////////
function updateTabsFromStringList(syncTabs,do_merge,callback) {
	
    console.log("[updateTabsFromStringList]syncTabs="+syncTabs+" ("+syncTabs.length+"),do_merge="+do_merge);
	
	diffCurrentToStoredTabs(syncTabs,function(additionalTabs,missingTabs,allCurrentTabs,tabs_count){

		if(!allCurrentTabs){
            console.log("[updateTabsFromStringList]diffCurrentToStoredTabs ruturns undefined var-s. Returning.");
			if( callback && typeof( callback ) === "function" ) { callback(); }
			return;
        }else if(!syncingIsStarted){ //make a check closest to the actual sync
            console.log("[updateStorageFromTabs_directly]syncingIsStarted=false. Returning.")
            if( callback && typeof( callback ) === "function" ) { callback(); }
            return;
        }
		
        //if there's one removed and one added - we assume it's an update
        if( ( (additionalTabs.length===1) && (missingTabs.length===1) ) && (!do_merge) ) {
            console.log("[updateTabsFromStringList]Updating tab,id="+missingTabs[0].id);
			chrome.tabs.update(missingTabs[0].id, { url: additionalTabs[0] , active : false } );
		}else{
			//Add tabs left in syncTabs (therefore not present)
			for( var l = 0; l < additionalTabs.length; l++ ) {
                console.log("[updateTabsFromStringList]Creating tab "+additionalTabs[l]);
				chrome.tabs.create( { url: additionalTabs[l], active : false } );
				tabs_count++;
			}
		
			if( !do_merge ){
				if( (missingTabs.length===1) | ( (Date.now()+time_of_start)>8000) ){ //in the first 8 seconds don't remove more than one tab at a time , because syncing may not be ready yet , and sysnce there's no API to detect that we just wait
					//Remove tabs left in the local tabs array (not present in sync)
					for( var lt = 0; lt < missingTabs.length; lt++ ) {
                        console.log("[updateTabsFromStringList]Removing tab: "+missingTabs[lt].url);
						if(tabs_count===1){ //if it's the last tab - just make it blank so chrome doesnt close
							chrome.tabs.update(missingTabs[lt].id, { url: "chrome://newtab" } );
						}else{
							chrome.tabs.remove( missingTabs[lt].id);
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
	
    console.log("[updateStorageFromTabs]");

    updateSyncState( function(){ //just to be sure. Too often there are simultanious events going on

        if(!syncingIsStarted) {
            console.log("[updateStorageFromTabs] syncingIsStarted==false. Returning.");
            if( callback && typeof( callback ) === "function" ) { callback(); }
            return;
        }

        if(!inSyncFunction){
            inSyncFunction=true;
            updateBrowserAction();

            removeListeners();
            updateStorageFromTabs_directly( function(){
                addListeners();
                inSyncFunction=false;
                updateBrowserAction();

                //console.log("updateStorageFromTabs() ended.");
                if( callback && typeof( callback ) === "function" ) { callback(); }
            });
        }else{
            console.log("[updateStorageFromTabs] inSyncFunction==true. Returning.");
            if( callback && typeof( callback ) === "function" ) { callback(); }
            return;
        }
    });
}

//
// Records the tabs' URLs into storage.sync (if necessery)
// Does not handle turning listeners on/off , and ommits some checks 
///////////////////////////////////////////
function updateStorageFromTabs_directly( callback ) {

    var tabsForSync = new Array();
	var syncTabs;
	
	// Get saved tabs
    chrome.storage.sync.get( 'syncTabs', function( returnVal ) { //that's an array of strings
		
		if(!returnVal.syncTabs){
            console.log("[updateStorageFromTabs_directly] !returnVal.syncTabs==true. Creating an empty array.");
			syncTabs = new Array();
		}else{
			syncTabs = returnVal.syncTabs.slice(0); //returnval is a key:value pair, we need only the value
            console.log("[updateStorageFromTabs_directly]syncTabs="+syncTabs+" ("+syncTabs.length+")");
		}
			
		diffCurrentToStoredTabs(syncTabs,function(additionalTabs,missingTabs,currentTabs2){
			
			if(!currentTabs2){
                console.log("[updateStorageFromTabs_directly]diffCurrentToStoredTabs ruturns undefined var-s . Returning.");
				if( callback && typeof( callback ) === "function" ) { callback(); }
				return;
            //if there's no changes - don't write (=>don't invoke a 'storage changed' event)
            }else if( (additionalTabs.length!==0) | (missingTabs.length!==0) ) {
				for( var t = 0; t < currentTabs2.length; t++ ) {
					if( currentTabs2[t].url === "chrome://newtab/" ) {continue;} //don't mind the newtabs
					else if( currentTabs2[t].url.slice(0,18) === "chrome-devtools://" ) {continue;}//if the tab is some kind of dev tool - leave it alone
					else tabsForSync[t] = currentTabs2[t].url;
				}

                if(syncingIsStarted){ //make a check closest to the actual sync
                    chrome.storage.sync.set( {"syncTabs" : tabsForSync } , function() {
                        time_of_last_sync_from_current_session = Date.UTC();
                        chrome.storage.sync.set( {"syncTimeStamp" : Date.UTC() } , function() {
                            // Notify that we saved.
                            console.log('[updateStorageFromTabs_directly]Tabs saved to sync.',tabsForSync);
                            if( callback && typeof( callback ) === "function" ) { callback(); }
                        });
                    });
                }else{
                    console.log("[updateStorageFromTabs_directly]syncingIsStarted=false. Returning.")
                    if( callback && typeof( callback ) === "function" ) { callback(); }
                }

			}else{
                //console.log(Date.now()-time_of_start,":","updateStorageFromTabs_directly() ended.");
				if( callback && typeof( callback ) === "function" ) { callback(); }
			}
		});
	});
}

//
// Worker function that gets current tabs and stored tabs (URLs) and returns the differences and the number of valid tabs (not ignored)
//returns (additionalTabs,missingTabs,allCurrentTabs,tabs_count)
///////////////////////////////////////////////
function diffCurrentToStoredTabs(syncTabs,callback){ 
    console.log("[diffCurrentToStoredTabs]");
	
	var additionalTabs = new Array();
	var missingTabs = new Array();
	var currentTabs2 = new Array();
	var tabs_count;
		
	// Get current tabs
	chrome.tabs.query( {} , function (currentTabs) { //query with no specifier so we get all tabs

        console.log("[diffCurrentToStoredTabs]chrome.tabs.query({}) retruns:"+currentTabs);
		if(!currentTabs){
			if( callback && typeof( callback ) === "function" ) { callback(); }
			return;
		}else if(currentTabs.length===0){
			if( callback && typeof( callback ) === "function" ) { callback(); }
			return;
		}else{
			currentTabs2=currentTabs.slice(); //copy the array for later
			tabs_count=currentTabs.length;
            console.log("[diffCurrentToStoredTabs]currentTabs count="+currentTabs2.length);
		}
	
		//For all local tabs
		for( var t = 0; t < currentTabs.length; t++ ) {

			if( currentTabs[t].url === "chrome://newtab/") { //ignore newtabs
				currentTabs.splice(t,1);
				tabs_count--;
				t--;//object is removed => the one in its place is not inspected =>loop with the same index
				continue;
			}
			
			var str = currentTabs[t].url;
			if( str.slice(0,18) === "chrome-devtools://" ){ //if the tab is some kind of dev tool - leave it alone
				currentTabs.splice(t,1);
				tabs_count--;
				t--;
				continue;
			}
			
			
			// For all sync tabs (those in the sync DB)
			for( var s = 0; s < syncTabs.length; s++ ) {
				var syncTab = syncTabs[s];

				if( syncTab === currentTabs[t].url ) {//if we find the tab in sync - remove it from the sync and tabs lists
					syncTabs.splice(s,1);
					currentTabs.splice(t,1);
					t--;
					break; //start the loop anew
				}
			}//next sync tab
		}//next local tab
		
		additionalTabs = syncTabs.slice();
		missingTabs = currentTabs.slice();
		
        //console.log("diffCurrentToStoredTabs() ended.");
		if( callback && typeof( callback ) === "function" ) { callback( additionalTabs,missingTabs,currentTabs2,tabs_count ); }
		return;
		
	});
}

//
// Forward only the tab-completed updates to updateStorageFromTabs ,and only if there are no other tabs marked 'loading'
// handle...() --> updateIfAllTabsAreComplete() --> updateStorageFromTabs()
///////////////////////////////////////////////
function handleTabCreatedEvent(tab){
    console.log("[handleTabCreatedEvent]tab.id="+tab.id);
	updateIfAllTabsAreComplete(tab.id);
}
function handleTabUpdatedEvent(tabId,changes){
    console.log("[handleTabUpdatedEvent]tabId="+tabId+", changes.status="+changes.status);

	if(changes.status === "complete"){	
		updateIfAllTabsAreComplete(tabId);
	}else{
		allTabsHaveCompletedLoading=false;
	}
}
function handleTabRemovedEvent(tabId){
    console.log("[handleTabRemovedEvent]tabId="+tabId);
	updateIfAllTabsAreComplete(tabId);
}
function updateIfAllTabsAreComplete(tabIdToIgnore){
    console.log("[updateIfAllTabsAreComplete]tabIdToIgnore="+tabIdToIgnore);

    if(inUpdateIfAllTabsAreCompleteFunc){
        console.log("[updateIfAllTabsAreComplete] inUpdateIfAllTabsAreCompleteFunc=true.Returning.");
        return;
	}else{
        inUpdateIfAllTabsAreCompleteFunc=true;
	}
	
	chrome.tabs.query( {} , function (currentTabs) { //query with no specifier so we get all tabs
		
		if(!currentTabs){
            console.log("[updateIfAllTabsAreComplete] !currentTabs==true. Returning.");
            inUpdateIfAllTabsAreCompleteFunc=false;
			return;
		}
	
		allTabsHaveCompletedLoading = true; //assume true (false will be assigned if needed in the for loop below)
	
		for(var t=0;t<currentTabs.length;t++){
			if( (currentTabs.id!==tabIdToIgnore)&&(currentTabs[t].status==="loading") ){ //if any other tab is not completed - return (otherwise there would be overlapping events , the merging on startup will be overridden , etc.)
                console.log("[updateIfAllTabsAreComplete]A tab is still loading. Returning.");
				allTabsHaveCompletedLoading=false;
                inUpdateIfAllTabsAreCompleteFunc=false;
				return;
			}
		}
		
		if(syncingIsStarted){
			updateStorageFromTabs();
		}
		updateSyncState();
        inUpdateIfAllTabsAreCompleteFunc=false;
	});
}

//
//Functions to set the 'power' variable in storage.local 
///////////////////////////////////////
function activateSyncing( callback ){ 
    console.log("[activateSyncing]");
	
	chrome.storage.local.set( { "power": true }, function() {
		syncingIsActive=true;
		updateBrowserAction();
		if( callback && typeof( callback ) === "function" ) { callback(); }
		return;
	});
}
function deactivateSyncing( callback ){
    console.log("[deactivateSyncing]");
	
	chrome.storage.local.set( { "power": false }, function() {
		syncingIsActive=false;
		updateBrowserAction();
		if( callback && typeof( callback ) === "function" ) { callback(); }
		return;
	});
}

//
//Funtions to toggle the syncingIsStarted. Listeners may be on, but startSyncing() gets called only
//when when all conditions are met ( see updateSyncState() )
//////////////////////////
function startSyncing(){ 
    console.log("[startSyncing]");
	syncingIsStarted=true;
	updateBrowserAction();
}
function stopSyncing(){ 
    console.log("[stopSyncing]");
	syncingIsStarted=false;
	updateBrowserAction();
}

//
//Changes the browserAction icon according to the flags
///////////////////////////////////
function updateBrowserAction( callback ){ 
    console.log("[updateBrowserAction]");

	if(inSyncFunction){
		if(browserActionIcon !== "yellow"){
			chrome.browserAction.setIcon( { "path": {'19': 'icon19yellow.png', '38': 'icon38yellow.png' } } );
			browserActionIcon = "yellow";
		}
	}else if(syncingIsActive){
		if(syncingIsStarted){
			if(browserActionIcon !== "green"){
				chrome.browserAction.setIcon( { "path": {'19': 'icon19.png', '38': 'icon38.png' } } );
				browserActionIcon = "green";
			}
		}else{ //syncing is stopped internally
			if(browserActionIcon !== "red"){
				chrome.browserAction.setIcon( { "path": {'19': 'icon19red.png', '38': 'icon38red.png' } } );
				browserActionIcon = "red";
			}
		}
	}else{//user has stopped syncing
		if(browserActionIcon !== "grey"){
			chrome.browserAction.setIcon( { "path": {'19': 'icon19grey.png', '38': 'icon38grey.png' } } );
			browserActionIcon = "grey";
		}
	}
}

//
//Functions to handle the listeners in bulk
//////////////////////////
function addListeners(){
	if(!listenersAreAdded){
		// Add storage change event listener
		chrome.storage.onChanged.addListener( updateTabsFromStorage );
		//Add tab removed/created/updated event listeners
		chrome.tabs.onCreated.addListener( handleTabCreatedEvent );
		chrome.tabs.onUpdated.addListener( handleTabUpdatedEvent );
		chrome.tabs.onRemoved.addListener( handleTabRemovedEvent );	
	}
	listenersAreAdded=true;
}
function removeListeners(){
	if(listenersAreAdded){
		// Remove storage change event listener
		chrome.storage.onChanged.removeListener( updateTabsFromStorage );
		// Stop tab and windows event listeners
		chrome.tabs.onCreated.removeListener( handleTabCreatedEvent );
		chrome.tabs.onUpdated.removeListener( handleTabUpdatedEvent );
		chrome.tabs.onRemoved.removeListener( handleTabRemovedEvent );
	}
	listenersAreAdded=false;
}

//
//Recursive function to make 'i' iterations retrieving the 'syncTabs' from storage.sync (for testing)
/////////////////////////////////////
function printSyncTabs(i,callback){
	chrome.storage.sync.get('syncTabs',function(tt){
		console.log(Date.now()-time_of_start,":",tt.syncTabs);
		if(i>1){printSyncTabs(i-1);}
		else{if( callback && typeof( callback ) === "function" ) { callback(); }}
	});
}
