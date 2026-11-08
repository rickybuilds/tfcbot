// lib/queueGate.js
"use strict";

// Optional queue gate for the Bootcamp TFC license. When BOOTCAMP_QUEUE_ROLE_ID
// (config.roles.queueRequired) is set, only members holding that role, or the
// admin role, may add to this bot's pickup queue. Without it, anyone may.

function canJoinQueue(member, config) {
  const roleId = String(config?.roles?.queueRequired || "").trim();
  if (!roleId) return true;
  const roles = member?.roles?.cache;
  if (!roles?.has) return false;
  const adminRole = String(config?.roles?.admin || "").trim();
  return roles.has(roleId) || Boolean(adminRole && roles.has(adminRole));
}

function queueGateMessage() {
  return "🚫 This queue needs a TFC license. Use !bootcamp for the training link and !license to check your status.";
}

function offenseGateMessage() {
  return "🚫 Full-time offense requires the Bootcamp offense endorsement. Earn it on the Bootcamp server and try again.";
}

module.exports = { canJoinQueue, queueGateMessage, offenseGateMessage };
