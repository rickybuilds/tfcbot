module.exports = {
  apps: [{
    name: "tfcbot",
    script: "index.js",
    cwd: "/root/tfcbot",
    env: {
      NODE_ENV: "production",
      ONEVONE_ENABLED: "0",
      ONEVONE_DRY_RUN: "1",
      ONEVONE_SERVER_SETUP_ENABLED: "0"
    }
  }]
};
