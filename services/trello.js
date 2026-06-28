"use strict";

const axios = require("axios");

const API_KEY = process.env.TRELLO_API_KEY;
const TOKEN = process.env.TRELLO_TOKEN;
const INBOX_LIST_ID = process.env.TRELLO_INBOX_LIST_ID;

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

module.exports = {
  createInboxCard,
};