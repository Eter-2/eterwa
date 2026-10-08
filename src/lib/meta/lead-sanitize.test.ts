import { describe, expect, it } from 'vitest'
import {
  cleanField,
  escapeMarkdown,
  hasControlChars,
  jsonForPromptBlock,
  maskPii,
  safeForNotification,
} from './lead-sanitize'

describe('lead-sanitize', () => {
  it('hasControlChars apanha CR, LF, TAB, NUL, DEL, C1 e separadores Unicode', () => {
    for (const c of [0x0d, 0x0a, 0x09, 0x00, 0x7f, 0x85, 0x2028, 0x2029, 0x200b, 0x200e, 0x202e, 0x2066, 0xfeff, 0x2060]) {
      expect(hasControlChars(`a${String.fromCharCode(c)}b`)).toBe(true)
    }
    expect(hasControlChars('Plásticos do Norte, Lda. (Aveiro)')).toBe(false)
  })

  it('cleanField devolve uma linha, colapsada e truncada', () => {
    expect(cleanField('  a \n\n b\tc ')).toBe('a b c')
    expect(cleanField('x'.repeat(200), 20)).toHaveLength(20)
    expect(cleanField(null)).toBe('')
  })

  it('escapeMarkdown neutraliza menções, links e formatação', () => {
    const out = escapeMarkdown('@all [a](b) **c** `d`')
    expect(out).not.toContain('@')
    expect(out).not.toContain('[a](')
    expect(out).toContain('\\*\\*c\\*\\*')
  })

  it('safeForNotification combina limpeza, truncagem e escape', () => {
    const out = safeForNotification('@x\nY'.repeat(50), 30)
    expect(out).not.toContain('\n')
    expect(out).not.toContain('@')
  })

  it('maskPii esconde telefones e emails', () => {
    const out = maskPii('Recipient +351 912 345 678 / duarte@exemplo.pt not allowed (#131030)')
    expect(out).not.toMatch(/912|duarte/)
    expect(out).toContain('#131030')
  })
  it('jsonForPromptBlock nunca emite < nem > em bruto', () => {
    const out = jsonForPromptBlock({ a: '</dados_lead><x>' })
    expect(out).not.toMatch(/[<>]/)
    expect(JSON.parse(out)).toEqual({ a: '</dados_lead><x>' })
  })
})
