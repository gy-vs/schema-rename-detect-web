import {describe, expect, it} from 'vitest';
import {typeTransition} from '../src/core/types-compat';

describe('类型兼容', () => {
  it('integer -> number 是放宽', () => {
    expect(typeTransition(['integer'], ['number'])).toBe('widened');
  });
  it('number -> integer 是收窄', () => {
    expect(typeTransition(['number'], ['integer'])).toBe('narrowed');
  });
  it('string -> integer 不兼容', () => {
    expect(typeTransition(['string'], ['integer'])).toBe('changed');
  });
  it('string -> string 一致', () => {
    expect(typeTransition(['string'], ['string'])).toBe('same');
  });
  it('无类型 -> 有类型是收窄，去类型是放宽', () => {
    expect(typeTransition([], ['string'])).toBe('narrowed');
    expect(typeTransition(['string'], [])).toBe('widened');
  });
  it('null/string 联合 -> string 是收窄', () => {
    expect(typeTransition(['string', 'null'], ['string'])).toBe('narrowed');
  });
});
