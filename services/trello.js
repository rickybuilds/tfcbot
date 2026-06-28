//services/trello.js
"use strict";

const axios = require("axios");

const API_KEY = process.env.TRELLO_API_KEY;
const TOKEN = process.env.TRELLO_TOKEN;
const INBOX_LIST_ID = process.env.TRELLO_INBOX_LIST_ID;

const CHECKLISTS = {
  tfcbot: [
    "Requirements confirmed",
    "Code updated",
    "Tested in Discord",
    "Logs checked",
    "Moved to Ready for Planning",
  ],

  website: [
    "Requirements confirmed",
    "API/data checked",
    "UI updated",
    "Mobile checked",
    "Deployed/tested",
  ],

  speedruns: [
    "Requirements confirmed",
    "Plugin impact checked",
    "Database/API checked",
    "Website impact checked",
    "Tested end-to-end",
  ],

  infrastructure: [
    "Requirements confirmed",
    "Server impact checked",
    "PM2/nginx/env checked",
    "Health/logs checked",
    "Rollback noted",
  ],

  analytics: [
    "Requirements confirmed",
    "Query/data source checked",
    "API/cache impact checked",
    "UI/report updated",
    "Numbers validated",
  ],

  api: [
    "Requirements confirmed",
    "Endpoint/route updated",
    "Error handling checked",
    "Response tested",
    "Logs checked",
  ],

  community: [
    "Requirements confirmed",
    "Community value clear",
    "Owner/next step clear",
    "Tested or reviewed",
    "Notes added",
  ],

  general: [
    "Requirements confirmed",
    "Owner/next step clear",
    "Tested or reviewed",
    "Notes added",
  ],
};

function normalizeCategory(category) {
  return String(category || "")
    .trim()
    .toLowerCase();
}

function getChecklistItems(category) {
  const key = normalizeCategory(category);
  return CHECKLISTS[key] || CHECKLISTS.general;
}

async function createInboxCard({ title, description = "", labelIds = [] }) {
  const res = await axios.post("https://api.trello.com/1/cards", null, {
    params: {
      key: API_KEY,
      token: TOKEN,
      idList: INBOX_LIST_ID,
      name: title,
      desc: description,
      idLabels: labelIds.join(","),
    },
  });

  return res.data;
}

async function addChecklist(cardId, name) {
  const res = await axios.post(
    `https://api.trello.com/1/cards/${cardId}/checklists`,
    null,
    {
      params: {
        key: API_KEY,
        token: TOKEN,
        name,
      },
    }
  );

  return res.data;
}

async function addChecklistItem(checklistId, itemName) {
  const res = await axios.post(
    `https://api.trello.com/1/checklists/${checklistId}/checkItems`,
    null,
    {
      params: {
        key: API_KEY,
        token: TOKEN,
        name: itemName,
        checked: false,
      },
    }
  );

  return res.data;
}

async function applyProjectChecklist(cardId, category) {
  const key = normalizeCategory(category);
  const items = getChecklistItems(key);
  const checklistName = `${key || "general"} checklist`;

  const checklist = await addChecklist(cardId, checklistName);

  for (const item of items) {
    await addChecklistItem(checklist.id, item);
  }

  return checklist;
}

module.exports = {
  createInboxCard,
  applyProjectChecklist,
};