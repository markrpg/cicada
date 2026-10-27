// Clipboard and file saving. Inside the Android app these go through the native
// bridge, because WebView has no clipboard prompt and ignores blob downloads.

const bridge = globalThis.CicadaAndroid;
const mac = globalThis.webkit?.messageHandlers?.cicada;

export const isAndroidApp = Boolean(bridge);

export async function readClipboard() {
  if (mac) return mac.postMessage({ action: "readClipboard" });
  if (bridge) return bridge.readClipboard();
  return navigator.clipboard.readText();
}

export async function writeClipboard(text) {
  if (mac) return mac.postMessage({ action: "writeClipboard", text });
  if (bridge) return bridge.writeClipboard(text);
  return navigator.clipboard.writeText(text);
}

// Returns where it went, for a status line ("Downloads/photo.jpg"), or '' in a browser.
export async function saveBlob(blob, name) {
  if (bridge || mac) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    if (mac) return mac.postMessage({ action: 'saveFile', name, base64: btoa(bin) });
    return bridge.saveFile(name, blob.type || 'application/octet-stream', btoa(bin));
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return '';
}
