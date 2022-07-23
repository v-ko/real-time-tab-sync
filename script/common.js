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

//codec copied from https://gist.github.com/mr5z/d3b653ae9b82bb8c4c2501a06f3931c6
function compressRecord(record) {
	e = (c) => {
		(x = "charCodeAt"),
			(b = z = {}),
			(f = c.split("")),
			(d = []),
			(a = f[0]),
			(g = 256);
		for (b = 1; b < f.length; b++)
			(c = f[b]),
				null != z[a + c]
					? (a += c)
					: (d.push(1 < a.length ? z[a] : a[x](0)),
					  (z[a + c] = g),
					  g++,
					  (a = c));
		d.push(1 < a.length ? z[a] : a[x](0));
		for (b = 0; b < d.length; b++) d[b] = String.fromCharCode(d[b]);
		return d.join("");
	};

	if (!record) {
		return null;
	}
	let uncompressed = JSON.stringify(record);
	let compressed = e(uncompressed);
	debug("[compressRecord]", uncompressed.length, "->", compressed.length);
	return compressed;
}

function uncompressRecord(compressed) {
	d = (b) => {
		(a = e = {}),
			(d = b.split``),
			(c = f = d[(b = 0)]),
			(g = [c]),
			(h = o = 256);
		for (; ++b < d.length; f = a)
			(a = d[b].charCodeAt()),
				(a = h > a ? d[b] : e[a] || f + c),
				g.push(a),
				(c = a[0]),
				(e[o] = f + c),
				o++;
		return g.join``;
	};

	if (!compressed) {
		return null;
	}
	let uncompressed = d(compressed);
	debug("[uncompressRecord]", compressed.length, "->", uncompressed.length);
	return JSON.parse(uncompressed);
}
