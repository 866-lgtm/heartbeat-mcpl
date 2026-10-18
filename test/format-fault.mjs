// Loaded into a server under test with --import (test/call-texts.test.ts):
// formatting 2099-01-01T09:00Z throws, as a fault nobody foresaw would, so a
// test can see what the agent reads when a tool throws. Every other time
// formats as before.
const at = Date.UTC(2099, 0, 1, 9);
const formatToParts = Intl.DateTimeFormat.prototype.formatToParts;
Intl.DateTimeFormat.prototype.formatToParts = function (date) {
  if (Number(date) === at) throw new Error('a fault this test put in formatToParts');
  return formatToParts.call(this, date);
};
