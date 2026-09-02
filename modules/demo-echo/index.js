'use strict';
// demo-echo module entry — tracked under modules/ so tests can install the
// real thing end-to-end (source dir is the repo's modules/, data dir is a
// temp dir). Wave A never executes module code; this is the manifest target.
module.exports = {
  speak(text) { return String(text); },
};
