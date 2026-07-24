import { validateContractAddress } from '../src/validation';

const VALID_CONTRACT_ADDRESS = 'C' + 'A'.repeat(55);

describe('validateContractAddress', () => {
  it('accepts a well-formed 56-character contract address', () => {
    const result = validateContractAddress(VALID_CONTRACT_ADDRESS);
    expect(result).toEqual({ valid: true, errors: [], warnings: [] });
  });

  it('rejects an empty address', () => {
    const result = validateContractAddress('');
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(['Contract address cannot be empty']);
  });

  it('rejects addresses not starting with C', () => {
    const result = validateContractAddress('G' + 'A'.repeat(55));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /must start with "C"/.test(e))).toBe(true);
  });

  it('rejects addresses with the wrong length', () => {
    const result = validateContractAddress('CSHORT');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /56 characters/.test(e))).toBe(true);
  });

  it('rejects addresses with invalid base32 characters', () => {
    const result = validateContractAddress('C' + '0'.repeat(55));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /StrKey format/.test(e))).toBe(true);
  });

  it('trims surrounding whitespace before validating', () => {
    const result = validateContractAddress(`  ${VALID_CONTRACT_ADDRESS}  `);
    expect(result.valid).toBe(true);
  });
});
