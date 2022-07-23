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

//------------Compression and decompression------------

function compressRecord(str) {
	// Build the dictionary.
	asArray = true;
	var i,
		dictionary = {},
		uncompressed = str,
		c,
		wc,
		w = "",
		result = [],
		ASCII = '',
		dictSize = 256;
	for (i = 0; i < 256; i += 1) {
		dictionary[String.fromCharCode(i)] = i;
	}

	for (i = 0; i < uncompressed.length; i += 1) {
		c = uncompressed.charAt(i);
		wc = w + c;
		//Do not use dictionary[wc] because javascript arrays
		//will return values for array['pop'], array['push'] etc
	   // if (dictionary[wc]) {
		if (dictionary.hasOwnProperty(wc)) {
			w = wc;
		} else {
			result.push(dictionary[w]);
			ASCII += String.fromCharCode(dictionary[w]);
			// Add wc to the dictionary.
			dictionary[wc] = dictSize++;
			w = String(c);
		}
	}

	// Output the code for w.
	if (w !== "") {
		result.push(dictionary[w]);
		ASCII += String.fromCharCode(dictionary[w]);
	}
	return asArray ? result : ASCII;
};

function uncompressRecord(compressedStr) {
	"use strict";
	// Build the dictionary.
	var i, tmp = [],
		dictionary = [],
		compressed = compressedStr,
		w,
		result,
		k,
		entry = "",
		dictSize = 256;
	for (i = 0; i < 256; i += 1) {
		dictionary[i] = String.fromCharCode(i);
	}

	if(compressed && typeof compressed === 'string') {
		// convert string into Array.
		for(i = 0; i < compressed.length; i += 1) {
			tmp.push(compressed[i].charCodeAt(0));
		}
		compressed = tmp;
		tmp = null;
	}

	w = String.fromCharCode(compressed[0]);
	result = w;
	for (i = 1; i < compressed.length; i += 1) {
		k = compressed[i];
		if (dictionary[k]) {
			entry = dictionary[k];
		} else {
			if (k === dictSize) {
				entry = w + w.charAt(0);
			} else {
				return null;
			}
		}

		result += entry;

		// Add w+entry[0] to the dictionary.
		dictionary[dictSize++] = w + entry.charAt(0);

		w = entry;
	}
	return result;
};
