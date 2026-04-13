describe('shEscape', () => {
  function shEscape(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

  it('escapes a simple string', () => {
    expect(shEscape('simple')).toBe("'simple'");
  });

  it('escapes single quotes', () => {
    expect(shEscape("it's")).toBe("'it'\\''s'");
  });

  it('escapes shell injection attempts', () => {
    expect(shEscape('x; rm -rf /')).toBe("'x; rm -rf /'");
  });

  it('escapes backtick commands', () => {
    expect(shEscape('`pwd`')).toBe("'`pwd`'");
  });

  it('handles numeric input', () => {
    expect(shEscape(123)).toBe("'123'");
  });

  it('handles null input', () => {
    expect(shEscape(null)).toBe("'null'");
  });

  it('handles undefined input', () => {
    expect(shEscape(undefined)).toBe("'undefined'");
  });

  it('handles empty string', () => {
    expect(shEscape('')).toBe("''");
  });

  it('escapes dollar sign', () => {
    expect(shEscape('$HOME')).toBe("'$HOME'");
  });

  it('escapes double quotes', () => {
    expect(shEscape('say "hello"')).toBe("'say \"hello\"'");
  });
});
