import { TestBed } from '@angular/core/testing';
import type { TransferProgress } from '../../../../shared/models';
import { DB_API } from '../../core/db-api';
import { fakeDbApi, PROFILE } from '../../testing/fake-db-api';
import { SchemaStore } from '../schema/schema.store';
import { TransferStore } from './transfer.store';

const ID = PROFILE.id;

function progress(phase: TransferProgress['phase'], bytes = 50): TransferProgress {
  return {
    jobId: 'job-1',
    kind: 'import',
    phase,
    bytes,
    totalBytes: 100,
    statements: 3,
    failed: 0,
    errors: [],
  };
}

function setup() {
  let emit: (p: TransferProgress) => void = () => undefined;
  const cancelled: string[] = [];
  TestBed.configureTestingModule({
    providers: [
      {
        provide: DB_API,
        useValue: fakeDbApi({
          onTransfer: (listener) => {
            emit = listener;
            return () => undefined;
          },
          cancelTransfer: (jobId) => {
            cancelled.push(jobId);
            return Promise.resolve({ ok: true, data: undefined });
          },
        }),
      },
    ],
  });
  const transfer = TestBed.inject(TransferStore);
  const schema = TestBed.inject(SchemaStore);
  const refresh = vi.spyOn(schema, 'refresh').mockResolvedValue();
  return { transfer, refresh, cancelled, emit: (p: TransferProgress) => emit(p) };
}

describe('TransferStore imports', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps a running import after its dialog closed, and reopens it', () => {
    const { transfer, emit } = setup();
    transfer.addImport({ jobId: 'job-1', connectionId: ID, name: 'dump.sql', database: 'shop' });
    emit(progress('running'));
    expect(transfer.runningImports().map((j) => j.name)).toEqual(['dump.sql']);

    transfer.showImport('job-1');
    expect(transfer.importFor()).toEqual({ connectionId: ID, jobId: 'job-1' });
  });

  it('refreshes the schema once when an import finishes in the background', () => {
    const { transfer, emit, refresh } = setup();
    transfer.addImport({ jobId: 'job-1', connectionId: ID, name: 'dump.sql' });
    emit(progress('running'));
    expect(refresh).not.toHaveBeenCalled();
    emit(progress('done', 100));
    emit(progress('done', 100));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(ID);
    expect(transfer.runningImports()).toEqual([]);
    // The result stays until it was seen.
    expect(transfer.imports()).toHaveLength(1);
    transfer.forget('job-1');
    expect(transfer.imports()).toEqual([]);
  });

  it('asks before disconnecting with an import running, and stops it', () => {
    const { transfer, emit, cancelled } = setup();
    transfer.addImport({ jobId: 'job-1', connectionId: ID, name: 'dump.sql' });
    emit(progress('running'));
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);

    expect(transfer.confirmStopImports('other')).toBe(true);
    expect(ask).not.toHaveBeenCalled();

    expect(transfer.confirmStopImports(ID)).toBe(false);
    expect(cancelled).toEqual([]);

    ask.mockReturnValue(true);
    expect(transfer.confirmStopImports(ID)).toBe(true);
    expect(cancelled).toEqual(['job-1']);
  });
});
