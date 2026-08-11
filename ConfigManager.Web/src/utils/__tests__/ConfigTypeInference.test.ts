import { describe, expect, it } from 'vitest'
// The value -> (type, parsedValue) contract lives in one place for both
// implementations. ConfigManager.Api asserts the same table against
// src/services/redis.js, so changing this side alone fails here, and updating
// the table to match fails there — the two cannot drift apart.
import sharedCases from '../../../../shared/config-type-cases.json'
// Read as source text rather than mounting the component: the assertion below is
// about which option values the template offers, independent of any store state.
import configEditorSource from '../../components/ConfigEditor.vue?raw'
import { createConfigItem, inferConfigType, parseConfigValue } from '../ConfigTypeInference'
import type { ConfigType } from '../ConfigTypeInference'

const cases = sharedCases.cases as Array<{
  value: string | null
  type: ConfigType
  parsedValue: unknown
}>

describe('Config type inference — shared contract', () => {
  it('has a non-empty shared case table', () => {
    expect(cases.length).toBeGreaterThan(0)
  })

  it.each(cases)('$value -> $type', ({ value, type, parsedValue }) => {
    const inferredType = inferConfigType(value)
    expect(inferredType).toBe(type)
    expect(parseConfigValue(value, inferredType)).toEqual(parsedValue)
    expect(createConfigItem('some:key', value as string)).toMatchObject({
      type,
      parsedValue,
    })
  })

  it('classifies undefined as null (not expressible in the shared JSON table)', () => {
    const inferredType = inferConfigType(undefined)
    expect(inferredType).toBe('null')
    expect(parseConfigValue(undefined, inferredType)).toBeNull()
  })

  it('normalises a loglevel parsedValue without touching the stored value', () => {
    expect(parseConfigValue('INFO', 'loglevel')).toBe('info')
    expect(createConfigItem('some:key', 'INFO').value).toBe('INFO')
  })

  it('does not renumber a zero-padded integer', () => {
    expect(inferConfigType('007')).toBe('string')
    expect(parseConfigValue('007', 'string')).toBe('007')
  })
})

describe('ConfigEditor loglevel options', () => {
  // The editor only renders the loglevel <select> when the classifier reports
  // 'loglevel'. Any option it offers that the classifier rejects silently
  // degrades that config to a free-text box on the next load.
  const loglevelSelects = [...configEditorSource.matchAll(/<select\b[^>]*>[\s\S]*?<\/select>/g)]
    .map((match) => match[0])
    .filter((block) => block.includes("'loglevel'"))

  it('finds the loglevel selects in ConfigEditor.vue', () => {
    expect(loglevelSelects.length).toBeGreaterThan(0)
  })

  it.each(loglevelSelects.map((block, index) => ({ index, block })))(
    'every option of loglevel select #$index classifies as loglevel',
    ({ block }) => {
      const optionValues = [...block.matchAll(/<option value="([^"]*)"/g)].map((match) => match[1])

      expect(optionValues.length).toBeGreaterThan(0)
      for (const optionValue of optionValues) {
        expect(inferConfigType(optionValue)).toBe('loglevel')
      }
    },
  )
})
