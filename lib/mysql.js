const mysql = require("mysql2/promise");

const pool = mysql.createPool({
    host: process.env.SPEEDRUN_DB_HOST,
    port: Number(process.env.SPEEDRUN_DB_PORT || 3306),
    user: process.env.SPEEDRUN_DB_USER,
    password: process.env.SPEEDRUN_DB_PASS,
    database: process.env.SPEEDRUN_DB_NAME,

    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0
});

module.exports = pool;
