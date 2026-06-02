/**
 * Telegram user and chat info tools.
 * Uses the Telegram Bot API to look up user profiles and chat info.
 */

function telegramApiUrl(token, method) {
  return `https://api.telegram.org/bot${token}/${method}`;
}

async function telegramRequest(token, method, body = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v !== undefined && v !== null) {
      params.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
  }
  const resp = await fetch(telegramApiUrl(token, method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const data = await resp.json();
  if (!data.ok) {
    return { error: `telegram api error ${data.error_code}: ${data.description}` };
  }
  return data.result;
}

export async function getTelegramUserInfo(args, trustLevel, config = {}) {
  const token = config._telegramToken;
  if (!token) {
    return { error: 'Telegram token not available in config' };
  }

  const userId = String(args.userId || '').trim();
  if (!userId) {
    return { error: 'userId is required' };
  }

  // getChat returns user info for user IDs
  const chatInfo = await telegramRequest(token, 'getChat', { chat_id: userId });

  if (chatInfo.error) {
    return chatInfo;
  }

  // also try to get profile photos
  const photos = await telegramRequest(token, 'getUserProfilePhotos', {
    user_id: userId,
    limit: 1,
  });

  return {
    id: chatInfo.id,
    type: chatInfo.type,
    firstName: chatInfo.first_name || null,
    lastName: chatInfo.last_name || null,
    username: chatInfo.username || null,
    languageCode: chatInfo.language_code || null,
    isBot: chatInfo.is_bot || false,
    canJoinGroups: chatInfo.can_join_groups ?? null,
    canReadAllGroupMessages: chatInfo.can_read_all_group_messages ?? null,
    supportsInlineQueries: chatInfo.supports_inline_queries ?? null,
    hasProfilePhoto: photos?.total_count > 0 || false,
    bio: chatInfo.bio || null,
  };
}

export async function getTelegramChatInfo(args, trustLevel, config = {}) {
  const token = config._telegramToken;
  if (!token) {
    return { error: 'Telegram token not available in config' };
  }

  const chatId = String(args.chatId || '').trim();
  if (!chatId) {
    return { error: 'chatId is required' };
  }

  const chatInfo = await telegramRequest(token, 'getChat', { chat_id: chatId });

  if (chatInfo.error) {
    return chatInfo;
  }

  // get member count for groups
  const result = {
    id: chatInfo.id,
    type: chatInfo.type,
    title: chatInfo.title || null,
    username: chatInfo.username || null,
    description: chatInfo.description || null,
    firstName: chatInfo.first_name || null,
    lastName: chatInfo.last_name || null,
    isBot: chatInfo.is_bot || false,
    memberCount: null,
    pinnedMessage: chatInfo.pinned_message?.text || null,
  };

  if (chatInfo.type === 'group' || chatInfo.type === 'supergroup') {
    const count = await telegramRequest(token, 'getChatMemberCount', { chat_id: chatId });
    result.memberCount = count?.error ? null : count;

    // get administrators
    const admins = await telegramRequest(token, 'getChatAdministrators', { chat_id: chatId });
    if (!admins?.error && Array.isArray(admins)) {
      result.administrators = admins.map(a => ({
        user: {
          id: a.user?.id,
          username: a.user?.username || null,
          firstName: a.user?.first_name || null,
          isBot: a.user?.is_bot || false,
        },
        status: a.status,
        customTitle: a.custom_title || null,
        isAnonymous: a.is_anonymous || false,
      }));
    }
  }

  return result;
}
