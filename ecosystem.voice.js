module.exports = {
  apps: [
    {
      name: "tfcbot-blue",
      script: "voicebot.js",
      cwd: "/root/tfcbot",
      env: {
        ENV_FILE: ".env.blue",
      },
    },
    {
      name: "tfcbot-red",
      script: "voicebot.js",
      cwd: "/root/tfcbot",
      env: {
        ENV_FILE: ".env.red",
      },
    },
    {
      name: "tfcbot-spectator",
      script: "voicebot.js",
      cwd: "/root/tfcbot",
      env: {
        ENV_FILE: ".env.spectator",
      },
    },
  ],
};
