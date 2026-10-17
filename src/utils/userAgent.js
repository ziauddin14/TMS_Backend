// A small, dependency-free reading of a request's browser, operating system and device type — all
// the activity log keeps about a device. The raw user-agent string is never stored, and nothing
// here looks at (or keeps) an IP address.
//
// Covers what this app's people actually use: Chrome / Edge / Opera / Samsung Internet / Firefox /
// Safari on Windows, Android, iOS / iPadOS, macOS, ChromeOS and Linux. Anything else is "Other".
// Chromium's low-entropy client hints (Sec-CH-UA-Mobile, Sec-CH-UA-Platform), sent by default on
// HTTPS, are used when present because they are more reliable than the user-agent string.
// Known limit: an iPad asking for the desktop site reports itself as a Mac, so it reads as desktop.

const BROWSERS = [
  ['Edge', /\bEdg(e|A|iOS)?\//],
  ['Opera', /\b(OPR|OPiOS)\//],
  ['Samsung Internet', /\bSamsungBrowser\//],
  ['Firefox', /\b(Firefox|FxiOS)\//],
  ['Chrome', /\b(Chrome|CriOS|Chromium)\//],
  ['Safari', /\bVersion\/[\d.]+.*\bSafari\//],
];

function cleanHint(value) {
  return typeof value === 'string' ? value.replace(/"/g, '').trim().toLowerCase() : '';
}

function parseBrowser(ua) {
  const match = BROWSERS.find(([, pattern]) => pattern.test(ua));
  return match ? match[0] : 'Other';
}

function parseOs(ua, platformHint) {
  const hinted = {
    windows: 'Windows',
    android: 'Android',
    ios: 'iOS',
    macos: 'macOS',
    'chrome os': 'ChromeOS',
    chromeos: 'ChromeOS',
    linux: 'Linux',
  }[platformHint];
  if (hinted) return hinted;
  if (/\bWindows\b/.test(ua)) return 'Windows';
  if (/\bAndroid\b/.test(ua)) return 'Android';
  if (/\biPad\b/.test(ua)) return 'iPadOS';
  if (/\b(iPhone|iPod)\b/.test(ua)) return 'iOS';
  if (/\bCrOS\b/.test(ua)) return 'ChromeOS';
  if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) return 'macOS';
  if (/\bLinux\b/.test(ua)) return 'Linux';
  return 'Other';
}

function parseDeviceType(ua, mobileHint) {
  if (/\b(iPad|Tablet)\b/.test(ua) || (/\bAndroid\b/.test(ua) && !/\bMobile\b/.test(ua))) return 'tablet';
  if (mobileHint === '?1') return 'mobile';
  if (/Mobi|\b(iPhone|iPod)\b/.test(ua)) return 'mobile'; // "Mobi" also matches "Mobile"
  return 'desktop';
}

// `headers` — the request's headers (Express's req.headers: lower-case keys).
function parseDevice(headers = {}) {
  const ua = String(headers['user-agent'] || '').slice(0, 512);
  return {
    browser: parseBrowser(ua),
    os: parseOs(ua, cleanHint(headers['sec-ch-ua-platform'])),
    deviceType: parseDeviceType(ua, String(headers['sec-ch-ua-mobile'] || '').trim()),
  };
}

module.exports = { parseDevice };
