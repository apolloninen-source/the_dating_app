// Conversations close kindly or automatically, so the cap on open conversations never fills up
// with dead chats (lifecycle-policy.v0.8.json conversations).
//
// conversation: { id, participants: [a, b], status: 'open' | 'closed', created_at,
//                 last_message_at?, last_message_by?, reminders_sent? }

const DAY_MS = 86_400_000;

export function conversationState(policy, conversation, now = new Date()) {
  const c = policy.conversations;
  if (conversation.status === 'closed') return { state: 'closed' };
  const last = new Date(conversation.last_message_at ?? conversation.created_at);
  const idleDays = (now - last) / DAY_MS;
  if (idleDays >= c.auto_close_after_days) return { state: 'auto_close' };
  const waitingOn = conversation.participants.find((p) => p !== conversation.last_message_by);
  if (
    conversation.last_message_by &&
    idleDays >= c.reply_reminder_after_days &&
    (conversation.reminders_sent ?? 0) < c.max_reminders
  ) {
    return { state: 'remind', remind: waitingOn };
  }
  return { state: 'open' };
}

// Close by a participant (optionally with a kind template) or automatically (by = null).
export function closeConversation(policy, conversation, { by = null, template = null, now }) {
  if (by !== null && !conversation.participants.includes(by)) {
    throw new Error('only a participant can close the conversation');
  }
  if (template !== null && !policy.conversations.closing_templates.some((t) => t.id === template)) {
    throw new Error(`unknown closing template ${template}`);
  }
  return {
    ...conversation,
    status: 'closed',
    closed_at: now.toISOString(),
    closed_by: by,
    close_reason: by === null ? 'inactive' : 'closed_by_participant',
    closing_template: template
  };
}

// Open conversations that count against max_active_conversations for `userId`.
export function openConversationCount(policy, conversations, userId, now = new Date()) {
  return conversations.filter((c) => {
    if (!c.participants.includes(userId)) return false;
    const { state } = conversationState(policy, c, now);
    return state === 'open' || state === 'remind';
  }).length;
}
