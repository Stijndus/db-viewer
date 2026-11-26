import { describe, expect, it } from 'vitest';
import { parseProcesses, processActionSql } from './process-list';

describe('processActionSql', () => {
  it('stops a query or a connection per dialect', () => {
    expect(processActionSql('mysql', 'cancel', '12')).toBe('KILL QUERY 12');
    expect(processActionSql('mysql', 'kill', '12')).toBe('KILL 12');
    expect(processActionSql('postgres', 'cancel', '7')).toBe('SELECT pg_cancel_backend(7)');
    expect(processActionSql('postgres', 'kill', '7')).toBe('SELECT pg_terminate_backend(7)');
    expect(processActionSql('mssql', 'kill', '55')).toBe('KILL 55');
    expect(() => processActionSql('mssql', 'cancel', '55')).toThrow(/hele sessie/);
  });
  it('only takes a number as id', () => {
    expect(() => processActionSql('mysql', 'kill', '1; DROP TABLE x')).toThrow(/Ongeldig/);
  });
});

describe('parseProcesses', () => {
  it('reads MySQL rows: own, idle and background', () => {
    const list = parseProcesses('mysql', [
      ['5', 'app', '10.0.0.2:5000', 'shop', 'Query', '12', 'Sending data', 'SELECT 1', '9'],
      ['6', 'app', '10.0.0.2:5001', null, 'Sleep', '300', '', null, '9'],
      ['9', 'me', 'localhost', 'shop', 'Query', '0', 'executing', 'SELECT … PROCESSLIST', '9'],
      ['1', 'system user', '', null, 'Daemon', null, 'InnoDB purge', null, '9'],
    ]);
    expect(list.map((p) => [p.id, p.state, p.idle, p.background, p.own])).toEqual([
      ['5', 'Query · Sending data', false, false, false],
      ['6', 'Sleep', true, false, false],
      ['9', 'Query · executing', false, false, true],
      ['1', 'Daemon', false, true, false],
    ]);
    expect(list[0]!.seconds).toBe(12);
  });
  it('reads PostgreSQL blocking pids and SQL Server system sessions', () => {
    const [pg] = parseProcesses('postgres', [
      [
        '42',
        'app',
        '10.0.0.3:6000',
        'shop',
        'active',
        '3',
        'UPDATE t',
        '7',
        'client backend',
        '40,41',
        'psql',
      ],
    ]);
    expect(pg).toMatchObject({ blockedBy: ['40', '41'], program: 'psql', idle: false });
    const [ms] = parseProcesses('mssql', [
      ['3', 'sa', '', 'master', 'background', '100', null, '60', '0', '', null, 'TASK MANAGER'],
    ]);
    expect(ms).toMatchObject({ background: true, state: 'background · TASK MANAGER' });
  });
});
