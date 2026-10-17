const { parseDevice } = require('../../src/utils/userAgent');

// The activity log's device reading: browser, OS and device type only.
const UA = {
  chromeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  edgeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
  operaWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 OPR/114.0.0.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  chromeAndroidPhone: 'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  samsungAndroid: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
  androidTablet: 'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  chromeIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1',
  safariIpad: 'Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
  chromebook: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  facebookInApp: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0]',
};

describe('utils/userAgent — parseDevice', () => {
  it.each([
    ['chromeWindows', 'Chrome', 'Windows', 'desktop'],
    ['edgeWindows', 'Edge', 'Windows', 'desktop'],
    ['operaWindows', 'Opera', 'Windows', 'desktop'],
    ['firefoxLinux', 'Firefox', 'Linux', 'desktop'],
    ['safariMac', 'Safari', 'macOS', 'desktop'],
    ['chromeAndroidPhone', 'Chrome', 'Android', 'mobile'],
    ['samsungAndroid', 'Samsung Internet', 'Android', 'mobile'],
    ['androidTablet', 'Chrome', 'Android', 'tablet'],
    ['safariIphone', 'Safari', 'iOS', 'mobile'],
    ['chromeIphone', 'Chrome', 'iOS', 'mobile'],
    ['safariIpad', 'Safari', 'iPadOS', 'tablet'],
    ['chromebook', 'Chrome', 'ChromeOS', 'desktop'],
    ['facebookInApp', 'Other', 'iOS', 'mobile'],
  ])('%s → %s / %s / %s', (key, browser, os, deviceType) => {
    expect(parseDevice({ 'user-agent': UA[key] })).toEqual({ browser, os, deviceType });
  });

  it('prefers Chromium client hints when they are sent', () => {
    expect(parseDevice({ 'user-agent': UA.chromeWindows, 'sec-ch-ua-mobile': '?1', 'sec-ch-ua-platform': '"Android"' })).toEqual({
      browser: 'Chrome',
      os: 'Android',
      deviceType: 'mobile',
    });
  });

  it('an empty or missing user agent is "Other" on a desktop — never an error', () => {
    expect(parseDevice({})).toEqual({ browser: 'Other', os: 'Other', deviceType: 'desktop' });
    expect(parseDevice()).toEqual({ browser: 'Other', os: 'Other', deviceType: 'desktop' });
  });

  it('returns exactly the three parsed fields — never the raw string', () => {
    expect(Object.keys(parseDevice({ 'user-agent': UA.chromeWindows }))).toEqual(['browser', 'os', 'deviceType']);
  });
});
