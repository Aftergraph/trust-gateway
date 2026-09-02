'use strict';
// one planner per gateway instance (WeakMap), so chat sessions survive across
// requests but reset on restart (sessions are ephemeral in the deterministic slice).
const { ChatPlanner } = require('./chat');
const planners = new WeakMap();
function getPlanner(gw) {
  let p = planners.get(gw);
  if (!p) { p = new ChatPlanner({ gateway: gw }); planners.set(gw, p); }
  return p;
}
module.exports = { getPlanner };