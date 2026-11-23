/* Monitor Laporan — settings. The only file to edit after deploying (README, steps 3 and 5). */
window.MONITOR_CONFIG = {
  // The Apps Script web app's address, ending in /exec.
  API_URL: 'https://script.google.com/macros/s/AKfycbxCeMscffzpDzhQJwnhSHw6lX_VazOT5GL2iyui2rc25N26hCKGskeJcTW6GhniE9uusQ/exec',

  // Laporan Tim's own address on GitHub Pages (ending in /). The board reads the posts, patrols and
  // checkpoints from the app itself, so a list changed in the app shows here on the next reload.
  // Empty = the copy in lists/ (taken 2026-11-23, app v58).
  APP_URL: 'https://reeko24-byte.github.io/sec-prabhu/',

  GRACE_MIN: 30,      // a report turns red this many minutes after it is due (Billy, 2026-11-19)
  REFRESH_SEC: 60,    // how often the board asks for new notes
  STALE_MIN: 3        // no answer for this long: the board says its data is old
};
