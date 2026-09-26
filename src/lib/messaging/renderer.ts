import type { MessageContext, MessageTemplateDefinition, RenderMessageInput } from './types'

const CONDITIONAL_RE = /{{#if\s+([a-zA-Z0-9_.]+)}}([\s\S]*?){{\/if}}/g
const VARIABLE_RE = /{{\s*([a-zA-Z0-9_.]+)\s*}}/g

export class MessageTemplateError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'MessageTemplateError'
    this.code = code
  }
}

export function renderMessageTemplate(input: RenderMessageInput): string {
  validateRequiredVariables(input.template, input.context)
  validateSecretUsage(input.template)

  const root: Record<string, unknown> = {
    ...input.context,
    secret: input.secrets ?? {},
  }

  let output = input.template.body.replace(CONDITIONAL_RE, (_match, path: string, block: string) => {
    const value = getPath(root, path)
    return isPresent(value) ? block : ''
  })

  output = output.replace(VARIABLE_RE, (_match, path: string) => {
    if (path.startsWith('secret.')) {
      const secretKey = path.slice('secret.'.length)
      if (!(input.template.secretVariables ?? []).includes(secretKey)) {
        throw new MessageTemplateError(
          'MESSAGE_TEMPLATE_SECRET_NOT_ALLOWED',
          `Secret variable ${secretKey} is not declared for template ${input.template.key}.`,
        )
      }
    }

    const value = getPath(root, path)
    if (!isPresent(value)) {
      throw new MessageTemplateError(
        'MESSAGE_TEMPLATE_VARIABLE_MISSING',
        `Variable ${path} is missing for template ${input.template.key}.`,
      )
    }
    return scalarToText(value, path)
  })

  const rendered = output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line, index, lines) => line !== '' || (index > 0 && lines[index - 1] !== ''))
    .join('\n')
    .trim()

  const maxLength = input.template.maxLength ?? defaultMaxLength(input.template)
  if (rendered.length > maxLength) {
    throw new MessageTemplateError(
      'MESSAGE_TEMPLATE_TOO_LONG',
      `Rendered template ${input.template.key} exceeds ${maxLength} characters.`,
    )
  }

  return rendered
}

function validateRequiredVariables(template: MessageTemplateDefinition, context: MessageContext): void {
  const root = context as unknown as Record<string, unknown>
  for (const path of template.requiredVariables ?? []) {
    if (!isPresent(getPath(root, path))) {
      throw new MessageTemplateError(
        'MESSAGE_TEMPLATE_REQUIRED_VARIABLE_MISSING',
        `Required variable ${path} is missing for template ${template.key}.`,
      )
    }
  }
}

function validateSecretUsage(template: MessageTemplateDefinition): void {
  const declared = new Set(template.secretVariables ?? [])
  const direct = [...template.body.matchAll(/{{\s*secret\.([a-zA-Z0-9_.]+)\s*}}/g)]
  const conditional = [
    ...template.body.matchAll(/{{#if\s+secret\.([a-zA-Z0-9_.]+)}}/g),
  ]
  for (const match of [...direct, ...conditional]) {
    const secretKey = match[1]
    if (!declared.has(secretKey)) {
      throw new MessageTemplateError(
        'MESSAGE_TEMPLATE_SECRET_NOT_ALLOWED',
        `Secret variable ${secretKey} is referenced but not declared for template ${template.key}.`,
      )
    }
  }
}

function getPath(root: Record<string, unknown>, path: string): unknown {
  let current: unknown = root
  for (const segment of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '' && value !== false
}

function scalarToText(value: unknown, path: string): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  throw new MessageTemplateError(
    'MESSAGE_TEMPLATE_NON_SCALAR_VARIABLE',
    `Variable ${path} must resolve to a scalar value.`,
  )
}

function defaultMaxLength(template: MessageTemplateDefinition): number {
  if (template.channel === 'whatsapp') return 4096
  if (template.channel === 'sms') return 1600
  return 20_000
}
