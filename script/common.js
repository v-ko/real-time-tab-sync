//------------------Working with url-------------------

// note: tried to remove hashtag but it proved to be overly aggressive and unsafe.
const normalizeUrl = (url) => url ? url : "";

//ignore newtabs, dev tools, etc in syncing
function shouldIgnoreUrl(url) {
    const hasPrefix = (url, prefix) => url.slice(0, prefix.length) === prefix;
	return (!url || url === "chrome://newtab/" || hasPrefix(url, "chrome-devtools://"));
}

function stripHashTag(url) {
	if (url) {
		let pos = url.indexOf("#");
		return (pos >= 0) ? url.substr(0, pos) : url;
	}
	return "";
}

//-----------Debugging and testing functions-----------

const printTime = (time) => `${time} {${new Date(time)}}`;

function printSyncRecord(record) {
	const printSource = (source) => source === machineId ? `${source} (me)` : source;

	let s = `machineId: ${printSource(record.machineId)}\ntime: ${printTime(record.time)}\nsourceTimes:\n`;
	
    for (let source in record.sourceTimes) {
		s += `    ${printSource(source)}: ${printTime(record.sourceTimes[source])}\n`;
	}
	
    s += `tabs (${record.tabs.length}):\n`;
	
    for (let i = 0; i < record.tabs.length; i++) {
		s += `    [${printSource(record.tabs[i].source)}] ${record.tabs[i].pinned ? 'pinned' : ''} ${record.tabs[i].url}\n`;
	}
	
    return s;
}
