import { nowFor, typeCategory } from './column-types';
import { compactJson, formatJson, jsonProblem, looksLikeJson } from './json-text';

describe('column types', () => {
  it('knows the types of every dialect', () => {
    expect(typeCategory('int(11) unsigned')).toBe('number');
    expect(typeCategory('decimal(10,2)')).toBe('number');
    expect(typeCategory('money')).toBe('number');
    expect(typeCategory('tinyint(1)')).toBe('bool');
    expect(typeCategory('boolean')).toBe('bool');
    expect(typeCategory('varchar(255)')).toBe('text');
    expect(typeCategory('character varying')).toBe('text');
    expect(typeCategory('nvarchar(max)')).toBe('text');
    expect(typeCategory('uuid')).toBe('text');
    expect(typeCategory('json')).toBe('json');
    expect(typeCategory('jsonb')).toBe('json');
    expect(typeCategory('date')).toBe('date');
    expect(typeCategory('datetime(6)')).toBe('datetime');
    expect(typeCategory('timestamp with time zone')).toBe('datetime');
    expect(typeCategory('datetime2')).toBe('datetime');
    expect(typeCategory('time')).toBe('time');
    expect(typeCategory('year(4)')).toBe('year');
    expect(typeCategory("enum('a','b')")).toBe('enum');
    expect(typeCategory('longblob')).toBe('binary');
    expect(typeCategory('bytea')).toBe('binary');
    expect(typeCategory('')).toBe('other');
  });

  it('writes the current time as the column stores it', () => {
    const at = new Date(2026, 10, 17, 9, 5, 3);
    expect(nowFor('datetime', at)).toBe('2026-11-17 09:05:03');
    expect(nowFor('date', at)).toBe('2026-11-17');
    expect(nowFor('time', at)).toBe('09:05:03');
    expect(nowFor('year', at)).toBe('2026');
    expect(nowFor('text', at)).toBeNull();
  });
});

describe('JSON in the cell editor', () => {
  it('formats, compacts and says where it is invalid', () => {
    expect(formatJson('{"a":[1,2]}')).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
    expect(compactJson('{\n "a": 1\n}')).toBe('{"a":1}');
    expect(jsonProblem('{"a": 1}')).toBeNull();
    const problem = jsonProblem('{\n  "a": 1,\n  "b": }');
    expect(problem).toMatchObject({ line: 3 });
    expect(problem!.message).not.toMatch(/position/);
  });

  it('recognises JSON objects and arrays in text, not plain words or numbers', () => {
    expect(looksLikeJson(' {"a":1} ')).toBe(true);
    expect(looksLikeJson('[1,2]')).toBe(true);
    expect(looksLikeJson('42')).toBe(false);
    expect(looksLikeJson('{niet json}')).toBe(false);
    expect(looksLikeJson('hallo')).toBe(false);
  });
});
