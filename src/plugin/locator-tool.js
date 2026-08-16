import { LOCATOR_SCHEMA, renderJson } from './tool-output.js'
import { DEFAULT_MAX_INLINE_OUTPUT_BYTES } from '../output-limits.js'

const LOCATOR_PAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true },
    start_byte: { type: 'integer', required: true },
    end_byte: { type: 'integer', required: true },
    total_bytes: { type: 'integer', required: true },
    truncated: { type: 'boolean', required: true },
  },
}

export function registerLocatorTool(register, runner, maxInlineOutputBytes) {
  const maxBytes = maxInlineOutputBytes ?? DEFAULT_MAX_INLINE_OUTPUT_BYTES
  register({
    name: 'host_read_locator',
    description: 'Remote-only: read a byte page from a structured remote file, job log, or change locator.',
    parameters: {
      locator: { ...LOCATOR_SCHEMA, required: true },
      start_byte: { type: 'integer', description: 'Absolute byte offset; defaults to zero.' },
      length_bytes: { type: 'integer', description: 'Page size capped by the inline output limit.' },
    },
    output: { schema: LOCATOR_PAGE_SCHEMA, render: renderJson },
    execute(args, exec) {
      const lengthBytes = Math.min(maxBytes, Math.max(1, args.length_bytes ?? maxBytes))
      return runner.readLocator(args.locator, {
        startByte: Math.max(0, args.start_byte ?? 0),
        lengthBytes,
        ownerSessionId: exec?.agent?.id,
      })
    },
  })
}
