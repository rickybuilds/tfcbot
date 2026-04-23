module.exports = {
  apps: [{
    name: "tfcbot",
    script: "index.js",
    cwd: "/root/tfcbot",
    env: {
      NODE_ENV: "production"
    }
  }]
};
