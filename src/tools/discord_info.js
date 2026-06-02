/**
 * Discord user lookup tool.
 * Returns info about a Discord user by ID or mention.
 */

export async function getDiscordUserInfo(args, trustLevel, config = {}) {
  const client = config._discordClient;
  if (!client) {
    return { error: 'Discord client not available' };
  }

  const userId = extractUserId(args.userId);
  if (!userId) {
    return { error: 'Invalid user ID or mention format' };
  }

  try {
    // Try to fetch the user from Discord
    const user = await client.users.fetch(userId);
    
    return {
      id: user.id,
      username: user.username,
      globalName: user.globalName || null,
      discriminator: user.discriminator || '0',
      bot: user.bot,
      system: user.system,
      createdAt: user.createdAt.toISOString(),
      avatarUrl: user.displayAvatarURL({ size: 1024 }) || null,
    };
  } catch (err) {
    if (err.code === 10013 || err.code === 'Unknown User') {
      return { error: `User not found: ${userId}` };
    }
    return { error: `Failed to fetch user: ${err.message}` };
  }
}

/**
 * Extract user ID from various formats:
 * - Raw ID: 1256183302516248680
 * - Mention: <@1256183302516248680>
 * - Mention with nickname: <@!1256183302516248680>
 */
function extractUserId(input) {
  if (!input) return null;
  
  const str = String(input).trim();
  
  // Check if it's a mention format
  const mentionMatch = str.match(/<@!?(\d+)>/);
  if (mentionMatch) {
    return mentionMatch[1];
  }
  
  // Check if it's just a numeric ID
  if (/^\d+$/.test(str)) {
    return str;
  }
  
  return null;
}
