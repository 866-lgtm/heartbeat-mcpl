// Loaded into a server under test with --import (test/call-texts.test.ts):
// formatting 2099-01-01T09:00Z throws an Error, and formatting
// 2099-01-02T09:00Z throws undefined, as faults nobody foresaw would, so a test
// can see what the agent reads when a tool throws. Every other time formats as
// before.
const error = Date.UTC(2099, 0, 1, 9);
const notAnError = Date.UTC(2099, 0, 2, 9);
const formatToParts = Intl.DateTimeFormat.prototype.formatToParts;
Intl.DateTimeFormat.prototype.formatToParts = function (date) {
  if (Number(date) === error) throw new Error('a fault this test put in formatToParts');
  if (Number(date) === notAnError) throw undefined;
  return formatToParts.call(this, date);
};
