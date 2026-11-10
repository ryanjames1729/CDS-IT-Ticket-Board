/**
 * Ticket categories — shared by the server (history snapshots) and the dashboard page.
 * Each ticket goes into the FIRST category whose keywords match its title, so order
 * matters: most specific first. Keywords are regular-expression fragments matched at
 * the start of a word.
 */
(function (root) {
  const ISSUE_CATEGORIES = {
    'Audio / AV':          ['speakers?\\b', 'audio', 'mics?\\b', 'microphone', 'sound', 'projector', 'smart ?board', 'av\\b', 'auditorium', 'pa system'],
    'Printing':            ['print', 'toner', 'copier'],
    'Network / WiFi':      ['wi-?fi', 'network', 'internet', 'wireless', 'vpn', 'switch', 'ethernet'],
    'iPad / Mobile':       ['ipads?\\b', 'mobile', 'phones?\\b', 'verizon', 'tablet', 'mdm'],
    'Login / Access':      ['log ?in', 'password', 'access', 'locked', 'credential', 'badge', 'off campus', '2fa', 'mfa'],
    'Software / App':      ['apps?\\b', 'software', 'licen[sc]e', 'google workspace', 'zoom', 'google meet', 'drive sync', 'install', 'cursive wizard', 'mailchimp'],
    'Chromebook / Device': ['chromebook', 'screen', 'crack', 'battery', 'charger', 'charging'],
    'Email':               ['e-?mail', 'mail\\b', 'forwarding', 'migration', 'outlook', 'gmail'],
    'Hardware Repair':     ['repair', 'replace', 'broken', 'bulb', 'laptop', 'computer'],
  };

  const PATTERNS = Object.entries(ISSUE_CATEGORIES)
    .map(([cat, kws]) => [cat, new RegExp('\\b(?:' + kws.join('|') + ')', 'i')]);

  function categorize(text) {
    for (const [cat, re] of PATTERNS) if (re.test(text || '')) return cat;
    return 'General';
  }

  const api = { ISSUE_CATEGORIES, categorize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
