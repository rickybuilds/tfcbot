"use strict";
const fs = require("fs");
module.exports = function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; };
