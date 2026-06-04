#!/bin/bash
# create_voice_relays.sh
# Generate .env files for Blue, Red, and Spectator bots for TFC voice relay.

BASE_ENV=".env"

if [ ! -f "$BASE_ENV" ]; then
  echo "❌ Base .env not found in current directory!"
  exit 1
fi

echo "✅ Found base .env — cloning into role-specific configs..."

# Define tokens
BLUE_TOKEN="MTQzNzUwNjk4MTQyMTI1Njc1NA.GIGbWg.XOb4L8bbuaOcn3BhdGAHXo2QvGLSB5LTx-UXyk"
RED_TOKEN="MTQzNzUwNjg4NTcxOTgyMjMzNg.GqKAPv.6JyrYwuve7iLaaoJTMLGVWqzTDiH0GEyeD9QbI"
SPECTATOR_TOKEN="MTQzNzUwNzc2MzIxODU1MDk5Nw.G68LdD.mFEbG3dczJ3IJlit8Xqh-f5HviuxVZyVpDCxc4"

# Create blue env
cp "$BASE_ENV" .env.blue
sed -i "s/^DISCORD_TOKEN=.*/DISCORD_TOKEN=${BLUE_TOKEN}/" .env.blue
echo "BOT_ROLE=blue" >> .env.blue
echo "VOICE_CHANNEL_ID=1409238995749044354" >> .env.blue
echo "✅ Created .env.blue (Blue Team)"

# Create red env
cp "$BASE_ENV" .env.red
sed -i "s/^DISCORD_TOKEN=.*/DISCORD_TOKEN=${RED_TOKEN}/" .env.red
echo "BOT_ROLE=red" >> .env.red
echo "VOICE_CHANNEL_ID=1409239085494833162" >> .env.red
echo "✅ Created .env.red (Red Team)"

# Create spectator env
cp "$BASE_ENV" .env.spectator
sed -i "s/^DISCORD_TOKEN=.*/DISCORD_TOKEN=${SPECTATOR_TOKEN}/" .env.spectator
echo "BOT_ROLE=spectator" >> .env.spectator
echo "SPECTATOR_CHANNEL_ID=1102769055376609392" >> .env.spectator
echo "✅ Created .env.spectator (Spectator Relay)"

echo ""
echo "🎉 All environment files created successfully!"
echo "You can start them with:"
echo "  pm2 start index.js --name tfcbot-blue --env .env.blue"
echo "  pm2 start index.js --name tfcbot-red --env .env.red"
echo "  pm2 start index.js --name tfcbot-spectator --env .env.spectator"
