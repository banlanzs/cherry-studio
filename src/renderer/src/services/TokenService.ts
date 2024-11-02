import { Assistant, FileType, FileTypes, Message } from '@renderer/types'
import { GPTTokens } from 'gpt-tokens'
import { flatten, takeRight } from 'lodash'
import { CompletionUsage } from 'openai/resources'

import { getAssistantSettings } from './AssistantService'
import { filterContextMessages, filterMessages } from './MessagesService'

interface MessageItem {
  name?: string
  role: 'system' | 'user' | 'assistant'
  content: string
}

async function getFileContent(file: FileType) {
  if (!file) {
    return ''
  }

  if (file.type === FileTypes.TEXT) {
    return await window.api.file.read(file.id + file.ext)
  }

  return ''
}

async function getMessageParam(message: Message): Promise<MessageItem[]> {
  const param: MessageItem[] = []

  param.push({
    role: message.role,
    content: message.content
  })

  if (message.files) {
    for (const file of message.files) {
      param.push({
        role: 'assistant',
        content: await getFileContent(file)
      })
    }
  }

  return param
}

export function estimateTextTokens(text: string) {
  const { usedTokens } = new GPTTokens({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: text }]
  })

  return usedTokens - 7
}

export function estimateImageTokens(file: FileType) {
  return Math.floor(file.size / 100)
}

export async function estimateMessageUsage(message: Message): Promise<CompletionUsage> {
  const { usedTokens, promptUsedTokens, completionUsedTokens } = new GPTTokens({
    model: 'gpt-4o',
    messages: await getMessageParam(message)
  })

  let imageTokens = 0

  if (message.files) {
    const images = message.files.filter((f) => f.type === FileTypes.IMAGE)
    if (images.length > 0) {
      for (const image of images) {
        imageTokens = estimateImageTokens(image) + imageTokens
      }
    }
  }

  return {
    prompt_tokens: promptUsedTokens,
    completion_tokens: completionUsedTokens,
    total_tokens: usedTokens + (imageTokens ? imageTokens - 7 : 0)
  }
}

export async function estimateMessagesUsage({
  assistant,
  messages
}: {
  assistant: Assistant
  messages: Message[]
}): Promise<CompletionUsage> {
  const outputMessage = messages.pop()!

  const prompt_tokens = await estimateHistoryTokens(assistant, messages)
  const { completion_tokens } = await estimateMessageUsage(outputMessage)

  return {
    prompt_tokens: await estimateHistoryTokens(assistant, messages),
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens
  } as CompletionUsage
}

export async function estimateHistoryTokens(assistant: Assistant, msgs: Message[]) {
  const { contextCount } = getAssistantSettings(assistant)
  const messages = filterMessages(filterContextMessages(takeRight(msgs, contextCount)))

  // 有 usage 数据的消息，快速计算总数
  const uasageTokens = messages
    .filter((m) => m.usage)
    .reduce((acc, message) => {
      const inputTokens = message.usage?.total_tokens ?? 0
      const outputTokens = message.usage!.completion_tokens ?? 0
      return acc + (message.role === 'user' ? inputTokens : outputTokens)
    }, 0)

  // 没有 usage 数据的消息，需要计算每条消息的 token
  let allMessages: MessageItem[][] = []

  for (const message of messages.filter((m) => !m.usage)) {
    const items = await getMessageParam(message)
    allMessages = allMessages.concat(items)
  }

  const { usedTokens } = new GPTTokens({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: assistant.prompt
      },
      ...flatten(allMessages)
    ]
  })

  return usedTokens - 7 + uasageTokens
}